const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const DISCORD_WEBHOOK_URL = process.env.RETAILER_DISCORD_WEBHOOK_URL;
const CHECK_INTERVAL_MS   = 3 * 60 * 1000;
const PORT                = process.env.RETAILER_PORT || 10001;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

const JSON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-GB,en;q=0.9',
};

// ─── STATE ────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'retailer_state.json');
let productState = loadJSON(STATE_FILE, {});
let lastCheck = null;

function loadJSON(file, defaultVal) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return defaultVal;
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(productState, null, 2)); }
  catch (e) { console.error('Save error:', e.message); }
}

// ─── ARGOS ────────────────────────────────────────────────────────────────────
// Known Pokemon PIDs - add more as they appear
const ARGOS_PIDS = [
  { pid: '8488909', name: 'Pokémon Destined Rivals Booster Box' },
  { pid: '8512239', name: 'Pokémon Surging Sparks Booster Box' },
  { pid: '8595689', name: 'Pokémon Lumiose City Meganium Mini Tin' },
  { pid: '8699042', name: 'Pokémon Lumiose City Emboar Inkay Mini Tin' },
  { pid: '8185312', name: 'Pokémon Mega Feraligatr ex Box' },
  { pid: '8131720', name: 'Pokémon Mega Meganium ex Box' },
  { pid: '8482606', name: 'Pokémon Mega Evolution Chaos Rising Pack of 3' },
];

async function checkArgos() {
  const results = [];
  for (const { pid, name: fallbackName } of ARGOS_PIDS) {
    try {
      const res = await axios.get(`https://www.argos.co.uk/product/${pid}`, {
        timeout: 15000,
        headers: HEADERS,
      });

      const html = res.data;

      // Parse __NEXT_DATA__ for stock info
      const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      let name = fallbackName;
      let price = 'N/A';
      let cncStock = false;
      let deliveryStock = false;

      if (match) {
        try {
          const nd = JSON.parse(match[1]);
          const product = nd?.props?.pageProps?.product || nd?.props?.initialProps?.pageProps?.product;
          if (product) {
            name = product?.attributes?.name || fallbackName;
            price = product?.attributes?.price ? `£${product.attributes.price}` : 'N/A';
            const availability = product?.attributes?.availability;
            cncStock = availability?.storeAvailability?.status === 'In Stock';
            deliveryStock = availability?.deliveryAvailability?.status === 'In Stock';
          }
        } catch (e) {}
      }

      // Fallback: check page text for stock signals
      if (!match) {
        const $ = cheerio.load(html);
        const pageText = $('body').text();
        cncStock = pageText.includes('Reserve & collect') || pageText.includes('collect from store');
        deliveryStock = pageText.includes('Add to trolley') || pageText.includes('In stock');
        const priceEl = $('[class*="price"]').first().text().trim();
        if (priceEl) price = priceEl;
      }

      const inStock = cncStock || deliveryStock;

      results.push({
        id: `argos-${pid}`,
        pid,
        name,
        price,
        link: `https://www.argos.co.uk/product/${pid}`,
        inStock,
        cnc: cncStock ? '🟢' : '🔴',
        delivery: deliveryStock ? '🟢' : '🔴',
        retailer: 'Argos',
      });

      console.log(`  [Argos] ${pid}: ${name} | CnC: ${cncStock} | Delivery: ${deliveryStock}`);
    } catch (e) {
      console.log(`  [Argos] PID ${pid} failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

// ─── SPORTS DIRECT ───────────────────────────────────────────────────────────
async function checkSportsDirect() {
  try {
    // Sports Direct search API
    const res = await axios.get(
      'https://www.sportsdirect.com/api/search?query=pokemon&pageSize=100&pageNumber=1',
      { timeout: 15000, headers: JSON_HEADERS }
    );

    const items = res.data?.Products || res.data?.products || res.data?.items || [];
    if (items.length > 0) {
      return items.map(p => ({
        id: `sd-${p.ProductId || p.id}`,
        name: p.ProductName || p.Name || p.name || 'Unknown',
        price: p.Price ? `£${p.Price}` : p.SalePrice ? `£${p.SalePrice}` : 'N/A',
        link: `https://www.sportsdirect.com${p.Url || p.url || ''}`,
        inStock: p.InStock ?? p.isInStock ?? true,
        retailer: 'Sports Direct',
      }));
    }
  } catch (e) {
    console.log(`  [Sports Direct] API failed: ${e.message}`);
  }

  // Fallback: scrape search page
  try {
    const res = await axios.get(
      'https://www.sportsdirect.com/search?query=pokemon+trading+card',
      { timeout: 15000, headers: HEADERS }
    );
    const $ = cheerio.load(res.data);
    const results = [];
    $('[class*="product"], [class*="Product"], article').each((_, el) => {
      const name = $(el).find('[class*="name"], [class*="title"], h2, h3').first().text().trim();
      const price = $(el).find('[class*="price"], [class*="Price"]').first().text().trim();
      const link = $(el).find('a').first().attr('href');
      if (name && name.toLowerCase().includes('pokemon')) {
        results.push({
          id: `sd-${name}`,
          name,
          price: price || 'N/A',
          link: link ? (link.startsWith('http') ? link : `https://www.sportsdirect.com${link}`) : 'https://www.sportsdirect.com',
          inStock: true,
          retailer: 'Sports Direct',
        });
      }
    });
    console.log(`  [Sports Direct] Scraped ${results.length} products`);
    return results;
  } catch (e) {
    console.log(`  [Sports Direct] Scrape failed: ${e.message}`);
    return [];
  }
}

// ─── JOHN LEWIS ──────────────────────────────────────────────────────────────
async function checkJohnLewis() {
  try {
    const res = await axios.get(
      'https://www.johnlewis.com/search?search-term=pokemon+trading+card&Nrpp=100',
      { timeout: 15000, headers: HEADERS }
    );

    const html = res.data;
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (match) {
      try {
        const nd = JSON.parse(match[1]);
        const products =
          nd?.props?.pageProps?.searchResults?.products ||
          nd?.props?.pageProps?.products || [];

        if (products.length > 0) {
          console.log(`  [John Lewis] Found ${products.length} products via __NEXT_DATA__`);
          return products.map(p => ({
            id: `jl-${p.id || p.productId}`,
            name: p.title || p.name,
            price: p.price?.now ? `£${p.price.now}` : 'N/A',
            link: `https://www.johnlewis.com${p.href || p.url || ''}`,
            inStock: p.available ?? true,
            retailer: 'John Lewis',
          }));
        }
      } catch (e) {}
    }

    // Fallback DOM scrape
    const $ = cheerio.load(html);
    const results = [];
    $('[class*="product"], [class*="Product"], article').each((_, el) => {
      const name = $(el).find('[class*="name"], [class*="title"], h2, h3').first().text().trim();
      const price = $(el).find('[class*="price"]').first().text().trim();
      const link = $(el).find('a').first().attr('href');
      if (name && name.length > 2) {
        results.push({
          id: `jl-${name}`,
          name,
          price: price || 'N/A',
          link: link ? (link.startsWith('http') ? link : `https://www.johnlewis.com${link}`) : 'https://www.johnlewis.com',
          inStock: true,
          retailer: 'John Lewis',
        });
      }
    });
    console.log(`  [John Lewis] Scraped ${results.length} products`);
    return results;
  } catch (e) {
    console.log(`  [John Lewis] Failed: ${e.message}`);
    return [];
  }
}

// ─── DISCORD ALERT ────────────────────────────────────────────────────────────
const RETAILER_COLORS = {
  'Argos': 0xED1B24,
  'Sports Direct': 0xFF6B00,
  'John Lewis': 0x003D72,
};

const RETAILER_ICONS = {
  'Argos': 'https://media.4rgos.it/i/Argos/logo_argos2x?w=32&h=32&fmt=png',
  'Sports Direct': 'https://www.sportsdirect.com/favicon.ico',
  'John Lewis': 'https://www.johnlewis.com/favicon.ico',
};

async function sendAlert(product, eventType) {
  const isRestock = eventType === 'restock';
  const fields = [
    { name: 'Status', value: isRestock ? '🔄 Restock' : '🆕 New Product', inline: true },
    { name: 'Price', value: product.price, inline: true },
  ];

  if (product.pid) fields.push({ name: 'PID', value: `\`${product.pid}\``, inline: true });
  if (product.cnc) fields.push({ name: 'C&C', value: product.cnc, inline: true });
  if (product.delivery) fields.push({ name: 'Delivery', value: product.delivery, inline: true });

  const embed = {
    color: RETAILER_COLORS[product.retailer] || 0x5865F2,
    author: {
      name: product.retailer,
      icon_url: RETAILER_ICONS[product.retailer],
    },
    title: product.name,
    url: product.link,
    fields,
    footer: { text: `UK Retailer Monitor • ${new Date().toLocaleString('en-GB')}` },
  };

  await axios.post(DISCORD_WEBHOOK_URL, { embeds: [embed] }, { timeout: 10000 });
}

// ─── MAIN CHECK ───────────────────────────────────────────────────────────────
async function checkAll() {
  lastCheck = new Date();
  console.log(`[RETAILER CHECK] ${lastCheck.toISOString()}`);

  const allProducts = [
    ...await checkArgos(),
    ...await checkSportsDirect(),
    ...await checkJohnLewis(),
  ];

  console.log(`[RETAILER TOTAL] ${allProducts.length} products found`);

  for (const product of allProducts) {
    const prev = productState[product.id];
    let eventType = null;

    if (!prev) eventType = 'new';
    else if (!prev.inStock && product.inStock) eventType = 'restock';

    productState[product.id] = {
      name: product.name,
      price: product.price,
      link: product.link,
      inStock: product.inStock,
      lastSeen: new Date().toISOString(),
    };

    if (!eventType || !product.inStock) continue;

    console.log(`  [${eventType.toUpperCase()}] ${product.retailer}: ${product.name}`);

    try {
      await sendAlert(product, eventType);
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`  [ALERT ERROR] ${e.message}`);
    }
  }

  saveState();
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
function startServer() {
  http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200); res.end('OK');
    } else if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end([
        '🛒 UK Retailer Monitor',
        `Tracking: ${Object.keys(productState).length} products`,
        `Last check: ${lastCheck ? lastCheck.toISOString() : 'pending'}`,
        'Retailers: Argos, Sports Direct, John Lewis',
      ].join('\n'));
    } else {
      res.writeHead(404); res.end();
    }
  }).listen(PORT, () => console.log(`Server on port ${PORT}`));
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🛒 UK Retailer Monitor starting...');
  if (!DISCORD_WEBHOOK_URL) { console.error('❌ Missing RETAILER_DISCORD_WEBHOOK_URL'); process.exit(1); }

  startServer();

  await axios.post(DISCORD_WEBHOOK_URL, {
    content: '🛒 **UK Retailer Monitor Online**\nMonitoring Argos, Sports Direct & John Lewis every 3 minutes.',
  }).catch(e => console.error('Startup ping failed:', e.message));

  await checkAll();
  setInterval(checkAll, CHECK_INTERVAL_MS);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
