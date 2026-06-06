const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const DISCORD_WEBHOOK_URL = process.env.RETAILER_DISCORD_WEBHOOK_URL || 'https://discordapp.com/api/webhooks/1512953145532092537/tL-vbqf-FGt89BKyYeZ7fzMiyL3tM8yOR_J6XKQojc13bnvA6dqhk5X3yB51muAp9sfK';
const CHECK_INTERVAL_MS   = 3 * 60 * 1000; // 3 minutes
const PORT                = process.env.RETAILER_PORT || 10001;

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

// ─── RETAILERS ────────────────────────────────────────────────────────────────

// ARGOS — uses their product API directly with known Pokemon PIDs
const ARGOS_PIDS = [
  '8488909', // Destined Rivals TCG
  '8595689', // Lumiose City Meganium Mini Tin
  '8699042', // Lumiose City Emboar Inkay Mini Tin
  '8185312', // Mega Evolution Ascended Heroes Mega Feraligatr ex Box
  '8131720', // Mega Evolution Ascended Heroes Mega Meganium ex Box
  '8482606', // Mega Evolution Chaos Rising Pack of 3
];

async function checkArgos() {
  const results = [];
  for (const pid of ARGOS_PIDS) {
    try {
      const res = await axios.get(`https://www.argos.co.uk/api/product/v2/${pid}`, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      });
      const data = res.data;
      const name = data?.product?.details?.name || `PID ${pid}`;
      const price = data?.product?.details?.price ? `£${data.product.details.price}` : 'N/A';
      const link = `https://www.argos.co.uk/product/${pid}`;
      const cnc = data?.product?.availability?.storeAvailability?.status || 'unknown';
      const delivery = data?.product?.availability?.deliveryAvailability?.status || 'unknown';
      const inStock = cnc === 'In Stock' || delivery === 'In Stock';

      results.push({ id: `argos-${pid}`, pid, name, price, link, inStock, cnc, delivery, retailer: 'Argos' });
    } catch (e) {
      console.log(`  [Argos] PID ${pid} failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

// SPORTS DIRECT — Shopify store
async function checkSportsDirect() {
  try {
    const res = await axios.get('https://www.sportsdirect.com/products.json?limit=250&page=1', {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });
    const products = res.data?.products || [];
    return products
      .filter(p => p.title.toLowerCase().includes('pokemon') || p.title.toLowerCase().includes('pokémon'))
      .map(p => ({
        id: `sd-${p.id}`,
        name: p.title,
        price: p.variants?.[0]?.price ? `£${p.variants[0].price}` : 'N/A',
        link: `https://www.sportsdirect.com/products/${p.handle}`,
        inStock: p.variants?.some(v => v.available) ?? false,
        retailer: 'Sports Direct',
      }));
  } catch (e) {
    // Fallback — Sports Direct may not be Shopify, try their search API
    try {
      const res = await axios.get('https://www.sportsdirect.com/SearchResultV2.aspx?sf=2&noOfRecordsPerPage=100&keywords=pokemon&isort=4', {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      });
      console.log(`  [Sports Direct] Fallback status: ${res.status}`);
    } catch (e2) {}
    console.log(`  [Sports Direct] Failed: ${e.message}`);
    return [];
  }
}

// JOHN LEWIS — uses their product search API
async function checkJohnLewis() {
  try {
    const res = await axios.get('https://api.johnlewis.com/search/api/rest/v2/catalog/products/search/keyword?q=pokemon&pageSize=100&sort=RELEVANCE', {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'JL-Authorization': 'wRhAeHTdPFGGGDJpwEWpFhJDXTumRqDXdABUHowsHkU=',
      },
    });
    const products = res.data?.products || [];
    return products.map(p => ({
      id: `jl-${p.productId}`,
      name: p.title,
      price: p.price?.was || p.price?.now ? `£${p.price.now || p.price.was}` : 'N/A',
      link: `https://www.johnlewis.com${p.pdpUrl || ''}`,
      inStock: p.available ?? true,
      retailer: 'John Lewis',
    }));
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
  'Argos': 'https://www.argos.co.uk/static/argos/assets/images/favicons/favicon-32x32.png',
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
  if (product.cnc) fields.push({ name: 'C&C', value: product.cnc === 'In Stock' ? '🟢' : '🔴', inline: true });
  if (product.delivery) fields.push({ name: 'Delivery', value: product.delivery === 'In Stock' ? '🟢' : '🔴', inline: true });

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
  console.log(`[CHECK] ${lastCheck.toISOString()}`);

  const allProducts = [
    ...await checkArgos(),
    ...await checkSportsDirect(),
    ...await checkJohnLewis(),
  ];

  console.log(`[TOTAL] ${allProducts.length} products found`);

  for (const product of allProducts) {
    const prev = productState[product.id];
    let eventType = null;

    if (!prev) eventType = 'new';
    else if (!prev.inStock && product.inStock) eventType = 'restock';
    else if (prev.inStock && !product.inStock) eventType = 'oos';

    productState[product.id] = {
      name: product.name,
      price: product.price,
      link: product.link,
      inStock: product.inStock,
      lastSeen: new Date().toISOString(),
    };

    // Only alert on new in-stock or restocks
    if (!eventType || eventType === 'oos') continue;
    if (!product.inStock) continue;

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
  if (!DISCORD_WEBHOOK_URL) { console.error('❌ Missing DISCORD_WEBHOOK_URL'); process.exit(1); }

  startServer();

  await axios.post(DISCORD_WEBHOOK_URL, {
    content: '🛒 **UK Retailer Monitor Online**\nMonitoring Argos, Sports Direct & John Lewis every 3 minutes.',
  }).catch(e => console.error('Startup ping failed:', e.message));

  await checkAll();
  setInterval(checkAll, CHECK_INTERVAL_MS);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
