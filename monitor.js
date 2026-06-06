const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SCRAPER_API_KEY     = process.env.SCRAPER_API_KEY;
const CHECK_INTERVAL_MS   = 3 * 60 * 1000; // 3 minutes
const PORT                = process.env.PORT || 10000;

const CATEGORIES = [
  { slug: 'new-releases',  label: 'New Release' },
  { slug: 'back-in-stock', label: 'Restock' },
];

// ─── STATE ────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');
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

// ─── FETCH ────────────────────────────────────────────────────────────────────
async function fetchProducts(slug) {
  const targetUrl = `https://www.pokemoncenter.com/en-gb/category/${slug}`;

  // Try 1: ScraperAPI with rendering
  try {
    const url = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}&render=true&country_code=gb&wait=3000`;
    const res = await axios.get(url, { timeout: 60000 });
    const products = parseHTML(res.data, slug, targetUrl);
    if (products.length > 0) {
      console.log(`  [render] Got ${products.length} products`);
      return products;
    }
  } catch (e) {
    console.log(`  [render] Failed: ${e.message}`);
  }

  // Try 2: ScraperAPI without rendering (faster, cheaper)
  try {
    const url = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}&country_code=gb`;
    const res = await axios.get(url, { timeout: 30000 });
    const products = parseHTML(res.data, slug, targetUrl);
    if (products.length > 0) {
      console.log(`  [no-render] Got ${products.length} products`);
      return products;
    }
  } catch (e) {
    console.log(`  [no-render] Failed: ${e.message}`);
  }

  // Try 3: Direct fetch (no proxy)
  try {
    const res = await axios.get(targetUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });
    const products = parseHTML(res.data, slug, targetUrl);
    if (products.length > 0) {
      console.log(`  [direct] Got ${products.length} products`);
      return products;
    }
  } catch (e) {
    console.log(`  [direct] Failed: ${e.message}`);
  }

  return [];
}

// ─── PARSE HTML ───────────────────────────────────────────────────────────────
function parseHTML(html, slug, fallbackUrl) {
  const products = [];

  // Try __NEXT_DATA__ first (most reliable)
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (match) {
    try {
      const nd = JSON.parse(match[1]);
      const hits =
        nd?.props?.pageProps?.productResults?.hits ||
        nd?.props?.pageProps?.products ||
        nd?.props?.pageProps?.category?.products || [];

      for (const p of hits) {
        const src = p._source || p;
        const name = src.productName || src.name;
        const id = src.id || src.productId || p._id || name;
        const sku = src.id || src.masterProductId || p._id || id;
        const price = src.price?.sales?.formatted || src.price?.list?.formatted || src.price || 'N/A';
        const link = src.selectedProductUrl || src.url
          ? `https://www.pokemoncenter.com${src.selectedProductUrl || src.url}`
          : fallbackUrl;
        const inStock = src.availability?.inStock ?? !src.outOfStock ?? true;

        if (name) products.push({ id: String(id), name, sku: String(sku), price, link, inStock });
      }

      if (products.length > 0) return products;
    } catch (e) {}
  }

  // Fallback: cheerio DOM scraping
  const $ = cheerio.load(html);
  $('[data-pid], [class*="product-tile"], [class*="ProductCard"], [class*="product-card"]').each((_, el) => {
    const name = $(el).find('[class*="name"], [class*="title"], h2, h3').first().text().trim();
    const price = $(el).find('[class*="price"]').first().text().trim();
    const link = $(el).find('a').first().attr('href');
    const id = $(el).attr('data-pid') || link || name;
    const sku = $(el).attr('data-pid') || id;

    if (name && name.length > 2) {
      products.push({
        id: String(id),
        name,
        sku: String(sku),
        price: price || 'N/A',
        link: link ? (link.startsWith('http') ? link : `https://www.pokemoncenter.com${link}`) : fallbackUrl,
        inStock: true,
      });
    }
  });

  return products;
}

// ─── DISCORD ALERT ────────────────────────────────────────────────────────────
async function sendDiscordAlert(product, label) {
  const isRestock = label === 'Restock';
  const color = isRestock ? 0x5865F2 : 0x57F287;

  const embed = {
    color,
    author: {
      name: 'pokemoncenter.com',
      icon_url: 'https://www.pokemoncenter.com/favicon.ico',
      url: 'https://www.pokemoncenter.com/en-gb',
    },
    title: product.name,
    url: product.link,
    fields: [
      { name: 'Status', value: isRestock ? '🔄 Restock' : '🆕 New Product', inline: true },
      { name: 'SKU',    value: `\`${product.sku}\``, inline: true },
      { name: 'Price',  value: product.price, inline: true },
    ],
    footer: { text: `Pokémon Center UK Monitor • ${new Date().toLocaleString('en-GB')}` },
  };

  await axios.post(DISCORD_WEBHOOK_URL, { embeds: [embed] }, { timeout: 10000 });
}

// ─── MAIN CHECK ───────────────────────────────────────────────────────────────
async function checkProducts() {
  lastCheck = new Date();
  console.log(`[CHECK] ${lastCheck.toISOString()}`);

  for (const { slug, label } of CATEGORIES) {
    console.log(`[${slug}] Fetching...`);
    const products = await fetchProducts(slug);
    console.log(`[${slug}] Found ${products.length} products`);

    for (const product of products) {
      const prev = productState[product.id];
      let eventType = null;

      if (!prev) {
        eventType = 'new';
      } else if (!prev.inStock && product.inStock) {
        eventType = 'restock';
      }

      productState[product.id] = {
        name: product.name,
        sku: product.sku,
        price: product.price,
        link: product.link,
        inStock: product.inStock,
        lastSeen: new Date().toISOString(),
      };

      if (!eventType) continue;

      const alertLabel = eventType === 'restock' ? 'Restock' : label;
      console.log(`  [${eventType.toUpperCase()}] ${product.name} (SKU: ${product.sku})`);

      try {
        await sendDiscordAlert(product, alertLabel);
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.error(`  [ALERT ERROR] ${e.message}`);
      }
    }

    saveState();
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
function startServer() {
  http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('OK');
    } else if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end([
        '🎮 Pokémon Center UK Monitor',
        `Tracking: ${Object.keys(productState).length} products`,
        `Last check: ${lastCheck ? lastCheck.toISOString() : 'pending'}`,
        `Next check in ~3 minutes`,
      ].join('\n'));
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(PORT, () => console.log(`Server on port ${PORT}`));
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🎮 Pokémon Center UK Monitor starting...');

  if (!SCRAPER_API_KEY) { console.error('❌ Missing SCRAPER_API_KEY'); process.exit(1); }
  if (!DISCORD_WEBHOOK_URL) { console.error('❌ Missing DISCORD_WEBHOOK_URL'); process.exit(1); }

  startServer();

  await axios.post(DISCORD_WEBHOOK_URL, {
    content: '🎮 **Pokémon Center UK Monitor Online**\nChecking every 3 minutes.',
  }).catch(e => console.error('Startup ping failed:', e.message));

  await checkProducts();
  setInterval(checkProducts, CHECK_INTERVAL_MS);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
