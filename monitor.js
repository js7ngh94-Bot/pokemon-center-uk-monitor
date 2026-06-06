const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || 'https://discordapp.com/api/webhooks/1512943826556162341/jYvhTXAZneXb1Ab-zL4LrTu-OJ1SFj6EI-9I_0yY9gYSO5gBoag7zT3by4Hb50dwKawJ';
const SCRAPER_API_KEY     = process.env.SCRAPER_API_KEY;
const CHECK_INTERVAL_MS   = 3 * 60 * 1000; // 3 minutes
const PORT                = process.env.PORT || 10000;

const CATEGORY_SLUGS = ['new-releases', 'back-in-stock'];

// ─── STATE ────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');
let productState = loadJSON(STATE_FILE, {});

// ─── PERSISTENCE ──────────────────────────────────────────────────────────────
function loadJSON(file, defaultVal) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { console.error('Load error:', e.message); }
  return defaultVal;
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(productState, null, 2)); }
  catch (e) { console.error('Save error:', e.message); }
}

// ─── FETCH PRODUCTS FROM PC API ───────────────────────────────────────────────
async function fetchProducts(slug) {
  const targetUrl = `https://www.pokemoncenter.com/en-gb/api/2.0/catalog/category/results?limit=48&start=0&format=ajax&cgid=${slug}`;

  let products = [];

  // Try the JSON API first
  try {
    const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}&country_code=gb`;
    const res = await axios.get(proxyUrl, { timeout: 30000 });
    const data = res.data;

    if (data?.hits?.hits) {
      for (const hit of data.hits.hits) {
        const src = hit._source || hit;
        const id = src.id || src.productId || src.sku || hit._id;
        const name = src.productName || src.name;
        const price = src.price?.sales?.formatted || src.price?.list?.formatted || 'N/A';
        const sku = src.id || src.masterProductId || hit._id;
        const link = src.selectedProductUrl || src.url
          ? `https://www.pokemoncenter.com${src.selectedProductUrl || src.url}`
          : `https://www.pokemoncenter.com/en-gb/category/${slug}`;
        const inStock = src.availability?.inStock ?? src.inStock ?? true;

        if (name) products.push({ id: String(id), name, price, sku: String(sku), link, inStock, slug });
      }
    }
  } catch (e) {
    console.log(`[API] JSON endpoint failed for ${slug}: ${e.message}`);
  }

  // Fallback: scrape __NEXT_DATA__
  if (products.length === 0) {
    try {
      const pageUrl = `https://www.pokemoncenter.com/en-gb/category/${slug}`;
      const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(pageUrl)}&render=true&country_code=gb`;
      const res = await axios.get(proxyUrl, { timeout: 60000 });

      const match = res.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (match) {
        const nd = JSON.parse(match[1]);
        const prods =
          nd?.props?.pageProps?.products ||
          nd?.props?.pageProps?.category?.products ||
          nd?.props?.pageProps?.productResults?.hits || [];

        for (const p of prods) {
          const id = p.id || p.productId || p.name;
          if (p.name) products.push({
            id: String(id),
            name: p.name,
            price: p.price?.sales?.formatted || p.price || 'N/A',
            sku: String(p.id || p.masterProductId || id),
            link: p.url ? `https://www.pokemoncenter.com${p.url}` : `https://www.pokemoncenter.com/en-gb/category/${slug}`,
            inStock: p.availability?.inStock ?? true,
            slug,
          });
        }
      }
    } catch (e) {
      console.log(`[SCRAPE] Fallback failed for ${slug}: ${e.message}`);
    }
  }

  return products;
}

// ─── SEND DISCORD ALERT ───────────────────────────────────────────────────────
async function sendDiscordAlert(product, eventType) {
  const isNew     = eventType === 'new';
  const isRestock = eventType === 'restock';

  const color  = isNew ? 0x57F287 : 0x5865F2; // green for new, blurple for restock
  const status = isNew ? '🆕 New Product' : '🔄 Restock';

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
      { name: 'Status', value: status, inline: true },
      { name: 'SKU',    value: `\`${product.sku}\``, inline: true },
      { name: 'Price',  value: product.price, inline: true },
    ],
    footer: { text: `Pokémon Center UK Monitor • ${new Date().toISOString()}` },
  };

  await axios.post(DISCORD_WEBHOOK_URL, { embeds: [embed] }, { timeout: 10000 });
}

// ─── MAIN CHECK ───────────────────────────────────────────────────────────────
async function checkProducts() {
  console.log(`[CHECK] ${new Date().toISOString()}`);

  for (const slug of CATEGORY_SLUGS) {
    let products;
    try {
      products = await fetchProducts(slug);
      console.log(`[${slug}] Found ${products.length} products`);
    } catch (e) {
      console.error(`[${slug}] Fetch error: ${e.message}`);
      continue;
    }

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

      console.log(`  [${eventType.toUpperCase()}] ${product.name} (SKU: ${product.sku})`);

      try {
        await sendDiscordAlert(product, eventType);
        await new Promise(r => setTimeout(r, 500)); // small delay between alerts
      } catch (e) {
        console.error(`  [ALERT ERROR] ${e.message}`);
      }
    }

    saveState();
    await new Promise(r => setTimeout(r, 2000)); // delay between categories
  }
}

// ─── HTTP SERVER (keeps Render alive) ────────────────────────────────────────
function startServer() {
  http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('OK');
    } else if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`🎮 Pokémon Center UK Monitor running\nTracking: ${Object.keys(productState).length} products\nLast check: ${new Date().toISOString()}`);
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(PORT, () => console.log(`Server on port ${PORT}`));
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🎮 Pokémon Center UK Monitor starting...');

  if (!SCRAPER_API_KEY) {
    console.error('❌ Missing SCRAPER_API_KEY');
    process.exit(1);
  }

  startServer();

  // Startup ping to Discord
  await axios.post(DISCORD_WEBHOOK_URL, {
    content: '🎮 **Pokémon Center UK Monitor Online**\nChecking every 3 minutes for new products and restocks.',
  }).catch(e => console.error('Startup ping failed:', e.message));

  await checkProducts();
  setInterval(checkProducts, CHECK_INTERVAL_MS);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
