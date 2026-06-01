const axios = require('axios');
const cheerio = require('cheerio');
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const NORMAL_INTERVAL_MS = 2 * 60 * 60 * 1000;   // 2 hours
const DROP_INTERVAL_MS   = 15 * 1000;              // 15 seconds

const FILTER_WORDS = [
  'plush', 'pin', 'badge', 'clothing', 'apparel',
  'sticker', 'poster', 'keychain', 'mug', 'bottle',
  'hat', 'bag', 'cushion', 'lamp', 'ornament'
];

// Pokémon Center UK uses a GraphQL/API backend — we hit the API directly
// to avoid Cloudflare protection on the HTML pages
const API_BASE = 'https://www.pokemoncenter.com/api/2.0/page/category';

const CATEGORY_SLUGS = {
  newArrivals: 'new-arrivals',
  outOfStock:  'out-of-stock',
};

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Shared axios instance that looks like a real browser
const httpClient = axios.create({
  timeout: 30000,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-GB,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
  },
});

const STATE_FILE = path.join(__dirname, 'seen_products.json');

// ─── STATE ────────────────────────────────────────────────────────────────────
let dropMode = false;
let monitorInterval = null;
let seenProducts = loadState();

// ─── INIT ─────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── PERSISTENCE ──────────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    }
  } catch (e) {
    console.error('Failed to load state:', e.message);
  }
  return new Set();
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify([...seenProducts]), 'utf8');
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

// ─── SCRAPER ──────────────────────────────────────────────────────────────────
async function scrapeProducts(slug) {
  const products = [];

  // Strategy 1: Try the Pokémon Center API endpoint
  try {
    const apiUrl = `https://www.pokemoncenter.com/api/2.0/page/category/${slug}?locale=en-gb&start=0&sz=96`;
    const res = await httpClient.get(apiUrl, {
      headers: {
        'User-Agent': randomUA(),
        'Referer': `https://www.pokemoncenter.com/en-gb/category/${slug}`,
        'x-requested-with': 'XMLHttpRequest',
        'Accept': 'application/json, text/plain, */*',
      }
    });

    const data = res.data;
    const hits = data?.hits || data?.products || data?.data?.products || [];

    for (const item of hits) {
      const name  = item.name || item.productName || item.title || '';
      const price = item.price?.sales?.formatted || item.price?.formatted || item.priceGBP || '';
      const link  = item.url || item.productUrl || `/en-gb/product/${item.id}`;
      const id    = item.id || item.sku || item.productId || name;

      if (name) {
        products.push({
          name,
          price: price || 'N/A',
          link: link.startsWith('http') ? link : `https://www.pokemoncenter.com${link}`,
          id: String(id),
        });
      }
    }

    if (products.length > 0) {
      console.log(`  [API] Got ${products.length} products for ${slug}`);
      return products;
    }
  } catch (err) {
    console.log(`  [API] Strategy 1 failed: ${err.message}`);
  }

  // Strategy 2: Scrape HTML page with browser-like headers + delay
  try {
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
    const pageUrl = `https://www.pokemoncenter.com/en-gb/category/${slug}`;
    const res = await httpClient.get(pageUrl, {
      headers: { 'User-Agent': randomUA() }
    });

    const $ = cheerio.load(res.data);

    // Try multiple selectors
    const selectors = [
      '[data-pid]',
      '.product-tile',
      '[class*="ProductCard"]',
      '[class*="product-card"]',
      'article[class*="product"]',
    ];

    for (const sel of selectors) {
      $(sel).each((_, el) => {
        const name  = $(el).find('[class*="name"], [class*="title"], h2, h3, [itemprop="name"]').first().text().trim();
        const price = $(el).find('[class*="price"], [itemprop="price"]').first().text().trim();
        const link  = $(el).find('a').first().attr('href') || $(el).attr('data-href');
        const id    = $(el).attr('data-pid') || $(el).attr('data-product-id') || link || name;

        if (name && name.length > 2) {
          products.push({
            name,
            price: price || 'N/A',
            link: link ? (link.startsWith('http') ? link : `https://www.pokemoncenter.com${link}`) : pageUrl,
            id: String(id),
          });
        }
      });
      if (products.length > 0) break;
    }

    // Strategy 2b: JSON-LD within HTML
    if (products.length === 0) {
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const data = JSON.parse($(el).html());
          const items = Array.isArray(data) ? data : [data];
          items.forEach(item => {
            if (item['@type'] === 'Product' && item.name) {
              products.push({
                name: item.name,
                price: item.offers?.price ? `£${item.offers.price}` : 'N/A',
                link: item.url || pageUrl,
                id: item.sku || item.name,
              });
            }
          });
        } catch (_) {}
      });
    }

    // Strategy 2c: window.__PRELOADED_STATE__ or next data
    if (products.length === 0) {
      const scriptContent = $('script#__NEXT_DATA__').html() || '';
      if (scriptContent) {
        try {
          const nextData = JSON.parse(scriptContent);
          const prods = nextData?.props?.pageProps?.products ||
                        nextData?.props?.pageProps?.category?.products || [];
          for (const p of prods) {
            if (p.name) {
              products.push({
                name: p.name,
                price: p.price || 'N/A',
                link: p.url || pageUrl,
                id: p.id || p.name,
              });
            }
          }
        } catch (_) {}
      }
    }

    if (products.length > 0) {
      console.log(`  [HTML] Got ${products.length} products for ${slug}`);
    } else {
      console.log(`  [HTML] No products found for ${slug} — site may require JS rendering`);
    }
  } catch (err) {
    console.log(`  [HTML] Strategy 2 failed: ${err.message}`);
  }

  return products;
}

// ─── FILTER ───────────────────────────────────────────────────────────────────
function isFiltered(productName) {
  const lower = productName.toLowerCase();
  return FILTER_WORDS.some(word => lower.includes(word));
}

// ─── CLAUDE ANALYSIS ──────────────────────────────────────────────────────────
async function analyseProduct(product) {
  const prompt = `You are a Pokémon TCG and collectibles resale expert focused on the UK market.

Analyse this Pokémon Center UK product and respond in JSON only (no markdown, no explanation):

Product: ${product.name}
Price: ${product.price}
URL: ${product.link}

Respond with exactly this JSON structure:
{
  "priority": "HIGH|MEDIUM|LOW",
  "priority_reason": "one sentence why",
  "estimated_resale_gbp": "£X–£Y or N/A",
  "resale_notes": "one sentence about resale potential",
  "should_alert": true
}

Priority guide:
- HIGH: TCG booster boxes, Elite Trainer Boxes, special sets, limited editions, sealed product with strong resale
- MEDIUM: Single packs, standard accessories, figures with moderate demand
- LOW: Common items, low resale potential

Always set should_alert to true (filtering is handled upstream).`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content[0].text.trim();
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── TELEGRAM ALERT ───────────────────────────────────────────────────────────
const PRIORITY_EMOJI = { HIGH: '🔴', MEDIUM: '🟡', LOW: '🟢' };

async function sendAlert(product, analysis, source) {
  const emoji = PRIORITY_EMOJI[analysis.priority] || '⚪';
  const sourceLabel = source === 'newArrivals' ? '🆕 New Arrival' : '🔄 Restock';
  const modeLabel   = dropMode ? '⚡ DROP MODE' : '🕐 Normal Mode';

  const message = [
    `${emoji} *${analysis.priority} PRIORITY* | ${sourceLabel}`,
    `${modeLabel}`,
    ``,
    `📦 *${escapeMarkdown(product.name)}*`,
    `💷 Price: ${escapeMarkdown(product.price)}`,
    `📈 Est. Resale: ${escapeMarkdown(analysis.estimated_resale_gbp)}`,
    ``,
    `💡 ${escapeMarkdown(analysis.priority_reason)}`,
    `🛒 ${escapeMarkdown(analysis.resale_notes)}`,
    ``,
    `🔗 [Buy Now](${product.link})`,
  ].join('\n');

  await bot.sendMessage(TELEGRAM_CHAT_ID, message, {
    parse_mode: 'Markdown',
    disable_web_page_preview: false,
  });
}

function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

// ─── MAIN CHECK ───────────────────────────────────────────────────────────────
async function checkProducts() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Running check | Drop mode: ${dropMode}`);

  for (const [source, slug] of Object.entries(CATEGORY_SLUGS)) {
    try {
      const products = await scrapeProducts(slug);
      console.log(`  [${source}] Found ${products.length} products`);

      for (const product of products) {
        if (!product.id || !product.name) continue;

        // Skip filtered items
        if (isFiltered(product.name)) {
          continue;
        }

        const key = `${source}::${product.id}`;
        if (seenProducts.has(key)) continue;

        // New or restocked product — analyse with Claude
        console.log(`  [NEW] ${product.name}`);
        seenProducts.add(key);
        saveState();

        try {
          const analysis = await analyseProduct(product);
          await sendAlert(product, analysis, source);
          console.log(`  [ALERTED] ${product.name} — ${analysis.priority}`);
        } catch (err) {
          console.error(`  [ANALYSIS ERROR] ${product.name}:`, err.message);
          // Send basic alert without analysis
          await bot.sendMessage(
            TELEGRAM_CHAT_ID,
            `⚠️ *New Product (analysis failed)*\n📦 ${product.name}\n💷 ${product.price}\n🔗 ${product.link}`,
            { parse_mode: 'Markdown' }
          );
        }

        // Small delay between Claude calls
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error(`  [SCRAPE ERROR] ${source}:`, err.message);
    }
  }
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
function startMonitor(intervalMs) {
  if (monitorInterval) clearInterval(monitorInterval);
  monitorInterval = setInterval(checkProducts, intervalMs);
  console.log(`Monitor started | Interval: ${intervalMs / 1000}s`);
}

function setDropMode(enabled) {
  dropMode = enabled;
  const intervalMs = enabled ? DROP_INTERVAL_MS : NORMAL_INTERVAL_MS;
  startMonitor(intervalMs);
  const status = enabled
    ? `⚡ *DROP MODE ON* — checking every 15 seconds`
    : `🕐 *Normal mode* — checking every 2 hours`;
  bot.sendMessage(TELEGRAM_CHAT_ID, status, { parse_mode: 'Markdown' });
  console.log(`Drop mode: ${enabled}`);
}

// ─── TELEGRAM COMMANDS ────────────────────────────────────────────────────────
bot.onText(/\/dropmode on/i, (msg) => {
  if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  setDropMode(true);
});

bot.onText(/\/dropmode off/i, (msg) => {
  if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  setDropMode(false);
});

bot.onText(/\/status/i, (msg) => {
  if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  const mode = dropMode ? '⚡ DROP MODE (15s)' : '🕐 Normal (2hr)';
  bot.sendMessage(
    TELEGRAM_CHAT_ID,
    `🤖 *Pokémon Monitor Status*\nMode: ${mode}\nTracking: ${seenProducts.size} products`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/check/i, (msg) => {
  if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  bot.sendMessage(TELEGRAM_CHAT_ID, '🔍 Running manual check now...');
  checkProducts();
});

bot.onText(/\/clearcache/i, (msg) => {
  if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  seenProducts.clear();
  saveState();
  bot.sendMessage(TELEGRAM_CHAT_ID, '🗑️ Cache cleared — all products will re-trigger on next check.');
});

bot.onText(/\/help/i, (msg) => {
  if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  bot.sendMessage(TELEGRAM_CHAT_ID, [
    '🤖 *Pokémon Center UK Monitor*',
    '',
    '`/dropmode on` — 15s check interval',
    '`/dropmode off` — 2hr check interval',
    '`/status` — Show current status',
    '`/check` — Run manual check now',
    '`/clearcache` — Reset seen products',
    '`/help` — Show this message',
  ].join('\n'), { parse_mode: 'Markdown' });
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🎮 Pokémon Center UK Monitor starting...');

  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !ANTHROPIC_API_KEY) {
    console.error('❌ Missing required env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ANTHROPIC_API_KEY');
    process.exit(1);
  }

  await bot.sendMessage(TELEGRAM_CHAT_ID, [
    '🎮 *Pokémon Center UK Monitor Online*',
    `🕐 Normal mode — checking every 2 hours`,
    `📦 Tracking: new arrivals & restocks`,
    `🚫 Filtering: plush, pins, badges, clothing, stickers, posters, keychains, mugs, bottles, hats, bags, cushions, lamps, ornaments`,
    ``,
    `Send /help for commands`,
  ].join('\n'), { parse_mode: 'Markdown' });

  // Run immediately on startup
  await checkProducts();

  // Start normal mode scheduler
  startMonitor(NORMAL_INTERVAL_MS);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
