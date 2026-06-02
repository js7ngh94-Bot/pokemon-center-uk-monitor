const axios = require('axios');
const cheerio = require('cheerio');
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SCRAPER_API_KEY   = process.env.SCRAPER_API_KEY;

const NORMAL_INTERVAL_MS = 2 * 60 * 60 * 1000;
const DROP_INTERVAL_MS   = 15 * 1000;

const FILTER_WORDS = [
  'plush', 'clothing', 'apparel', 'sticker', 'poster',
  'mug', 'bottle', 'hat', 'cushion', 'lamp', 'ornament',
  'towel', 'necklace', 'bracelet', 'earring', 'jewellery',
  'jewelry', 'hoodie', 't-shirt', 'tshirt', 'jacket', 'sock'
];

const CATEGORY_SLUGS = {
  newReleases: 'new-releases',
  outOfStock:  'back-in-stock',
};

// ─── STATE FILES ──────────────────────────────────────────────────────────────
const PRODUCTS_FILE = path.join(__dirname, 'products_state.json');
const IGNORED_FILE  = path.join(__dirname, 'ignored_products.json');

// ─── STATE ────────────────────────────────────────────────────────────────────
let dropMode = false;
let monitorInterval = null;
let productState = loadJSON(PRODUCTS_FILE, {});
let ignoredProducts = new Set(loadJSON(IGNORED_FILE, []));

// ─── INIT ─────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── PERSISTENCE ──────────────────────────────────────────────────────────────
function loadJSON(file, defaultVal) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { console.error('Load error:', e.message); }
  return defaultVal;
}

function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { console.error('Save error:', e.message); }
}

function saveState() {
  saveJSON(PRODUCTS_FILE, productState);
  saveJSON(IGNORED_FILE, [...ignoredProducts]);
}

// ─── STATE CLEANUP ────────────────────────────────────────────────────────────
function pruneOldState() {
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  let pruned = 0;
  for (const [id, data] of Object.entries(productState)) {
    if (ignoredProducts.has(id)) continue;
    if (new Date(data.lastSeen).getTime() < cutoff) {
      delete productState[id];
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log(`[PRUNE] Removed ${pruned} stale products`);
    saveState();
  }
}
setInterval(pruneOldState, 24 * 60 * 60 * 1000);

// ─── SCRAPER ──────────────────────────────────────────────────────────────────
async function scrapeCategory(slug) {
  const targetUrl = `https://www.pokemoncenter.com/en-gb/category/${slug}`;
  const proxyUrl  = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}&render=true&country_code=gb&wait_for_selector=${encodeURIComponent('[class*="product-fe"]')}`;

  const res = await axios.get(proxyUrl, { timeout: 60000 });
  const $ = cheerio.load(res.data);
  const products = [];

  const selectors = ['[class*="product-fe"]', '[data-pid]', '.product-tile', '[class*="ProductCard"]', '[class*="product-card"]', 'article[class*="product"]'];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const name  = $(el).find('[class*="name"], [class*="title"], h2, h3, [itemprop="name"]').first().text().trim();
      const price = $(el).find('[class*="price"], [itemprop="price"]').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || $(el).attr('data-href');
      const id    = $(el).attr('data-pid') || $(el).attr('data-product-id') || link || name;
      const outOfStock = $(el).find('[class*="out-of-stock"], [class*="unavailable"], [class*="sold-out"]').length > 0;
      const notAvailable = $(el).find('[class*="coming-soon"], [class*="not-available"], [class*="notify"]').length > 0;

      let stockStatus = 'in_stock';
      if (slug === 'out-of-stock' || outOfStock) stockStatus = 'out_of_stock';
      else if (notAvailable) stockStatus = 'not_available';

      if (name && name.length > 2) {
        products.push({
          name,
          price: price || 'N/A',
          link: link ? (link.startsWith('http') ? link : `https://www.pokemoncenter.com${link}`) : targetUrl,
          id: String(id),
          stockStatus,
          source: 'pokemoncenter_uk',
        });
      }
    });
    if (products.length > 0) break;
  }

  // Fallback: __NEXT_DATA__
  if (products.length === 0) {
    const nextRaw = $('script#__NEXT_DATA__').html();
    if (nextRaw) {
      try {
        const nd = JSON.parse(nextRaw);
        const prods = nd?.props?.pageProps?.products || nd?.props?.pageProps?.category?.products || [];
        for (const p of prods) {
          if (p.name) products.push({
            name: p.name, price: p.price || 'N/A',
            link: p.url || targetUrl, id: p.id || p.name,
            stockStatus: slug === 'out-of-stock' ? 'out_of_stock' : 'in_stock',
            source: 'pokemoncenter_uk',
          });
        }
      } catch (_) {}
    }
  }

  return products;
}

// ─── SCRAPE PRODUCT PAGE (for purchase limit) ─────────────────────────────────
async function scrapeProductLimit(productUrl) {
  try {
    const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(productUrl)}&country_code=gb`;
    const res = await axios.get(proxyUrl, { timeout: 30000 });
    const $ = cheerio.load(res.data);

    const bodyText = $('body').text();
    const limitMatch = bodyText.match(/limit[:\s]+(\d+)\s+per\s+(customer|order|person|household)/i) ||
                       bodyText.match(/maximum[:\s]+(\d+)\s+per\s+(customer|order|person|household)/i) ||
                       bodyText.match(/max[:\s]+(\d+)\s+per\s+(customer|order|person|household)/i);

    if (limitMatch) return `Max ${limitMatch[1]} per ${limitMatch[2]}`;

    const qtyMax = $('input[name="quantity"]').attr('max') || $('[class*="quantity"] input').attr('max');
    if (qtyMax && parseInt(qtyMax) <= 10) return `Max ${qtyMax} per order`;

    return null;
  } catch (_) {
    return null;
  }
}

// ─── FILTER ───────────────────────────────────────────────────────────────────
function isFiltered(productName) {
  const lower = productName.toLowerCase();
  return FILTER_WORDS.some(word => lower.includes(word));
}

function containsCards(productName) {
  const lower = productName.toLowerCase();
  const cardTerms = ['booster', 'etb', 'elite trainer', 'pack', 'box', 'collection box',
    'tin', 'bundle', 'tcg', 'trading card', 'promo card', 'build & battle',
    'build and battle', 'blister', 'display'];
  return cardTerms.some(term => lower.includes(term));
}

// ─── CLAUDE ANALYSIS ──────────────────────────────────────────────────────────
async function analyseProduct(product) {
  const prompt = `You are a Pokémon TCG resale expert for the UK market.

Product: ${product.name}
Price: ${product.price}

Respond in JSON only:
{
  "priority": "HIGH|MEDIUM|LOW",
  "priority_reason": "one sentence",
  "hype_level": "HIGH|MEDIUM|LOW",
  "should_alert": true
}

Priority rules:
- HIGH: contains booster packs, ETBs, booster boxes, collection boxes with packs, promo cards
- MEDIUM: tins, accessories with some demand
- LOW: everything else`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 150,
    messages: [{ role: 'user', content: prompt }],
  });

  const clean = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── FORMAT ALERT ─────────────────────────────────────────────────────────────
const PRIORITY_EMOJI = { HIGH: '🔴', MEDIUM: '🟡', LOW: '🟢' };
const STOCK_EMOJI    = { in_stock: '✅', out_of_stock: '❌', not_available: '⏳' };
const STOCK_LABEL    = { in_stock: 'In Stock', out_of_stock: 'Out of Stock', not_available: 'Listed — Not Yet Available' };

function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

async function sendAlert(product, analysis, purchaseLimit, eventType) {
  const emoji      = PRIORITY_EMOJI[analysis.priority] || '⚪';
  const stockEmoji = STOCK_EMOJI[product.stockStatus] || '❓';
  const stockLabel = STOCK_LABEL[product.stockStatus] || 'Unknown';
  const modeLabel  = dropMode ? '⚡ DROP MODE' : '🕐 Normal Mode';

  const eventLabel = {
    new:     '🆕 New Listing',
    restock: '🔄 Restock',
    oos:     '📉 Now Out of Stock',
  }[eventType] || '🆕 New';

  const limitLine = purchaseLimit ? `🛒 ${escapeMarkdown(purchaseLimit)}\n` : '';

  const message = [
    `${emoji} *${analysis.priority} PRIORITY* \\| ${eventLabel}`,
    `${modeLabel} \\| ${stockEmoji} ${escapeMarkdown(stockLabel)}`,
    ``,
    `📦 *${escapeMarkdown(product.name)}*`,
    `💷 Price: ${escapeMarkdown(product.price)}`,
    limitLine.trim() ? limitLine.trim() : null,
    ``,
    `💡 ${escapeMarkdown(analysis.priority_reason)}`,
    `🔥 Hype: ${analysis.hype_level}`,
  ].filter(l => l !== null).join('\n');

  const keyboard = {
    inline_keyboard: [[
      { text: '🔕 Ignore', callback_data: `ignore::${product.id}` },
      { text: '🔗 Open Listing', url: product.link },
    ]]
  };

  await bot.sendMessage(TELEGRAM_CHAT_ID, message, {
    parse_mode: 'MarkdownV2',
    reply_markup: keyboard,
  });
}

// ─── MAIN CHECK ───────────────────────────────────────────────────────────────
async function checkProducts() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Running check | Drop mode: ${dropMode}`);

  const allProducts = [];

  for (const [source, slug] of Object.entries(CATEGORY_SLUGS)) {
    try {
      const products = await scrapeCategory(slug);
      console.log(`  [${slug}] Found ${products.length} products`);
      allProducts.push(...products);
    } catch (err) {
      console.error(`  [SCRAPE ERROR] ${slug}: ${err.message}`);
    }
  }

  for (const product of allProducts) {
    if (!product.id || !product.name) continue;
    if (isFiltered(product.name)) continue;
    if (ignoredProducts.has(product.id)) continue;

    const prev = productState[product.id];
    let eventType = null;

    if (!prev) {
      eventType = 'new';
    } else if (prev.stockStatus !== product.stockStatus) {
      if (product.stockStatus === 'in_stock') eventType = 'restock';
      else if (product.stockStatus === 'out_of_stock') eventType = 'oos';
    }

    productState[product.id] = {
      name: product.name,
      price: product.price,
      link: product.link,
      stockStatus: product.stockStatus,
      lastSeen: timestamp,
    };
    saveState();

    if (!eventType) continue;
    if (eventType === 'oos' && !prev?.alertedInStock) continue;

    console.log(`  [${eventType.toUpperCase()}] ${product.name} (${product.stockStatus})`);

    try {
      let analysis = await analyseProduct(product);
      if (containsCards(product.name)) analysis.priority = 'HIGH';

      const purchaseLimit = product.stockStatus === 'in_stock'
        ? await scrapeProductLimit(product.link)
        : null;

      await sendAlert(product, analysis, purchaseLimit, eventType);

      if (product.stockStatus === 'in_stock') {
        productState[product.id].alertedInStock = true;
        saveState();
      }

      console.log(`  [ALERTED] ${product.name} — ${analysis.priority} (${eventType})`);
    } catch (err) {
      console.error(`  [ALERT ERROR] ${product.name}:`, err.message);
      await bot.sendMessage(
        TELEGRAM_CHAT_ID,
        `⚠️ *New Product*\n📦 ${product.name}\n💷 ${product.price}\n🔗 ${product.link}`,
        { parse_mode: 'Markdown' }
      );
    }

    await new Promise(r => setTimeout(r, 1500));
  }
}

// ─── CALLBACK HANDLER (buttons) ───────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const [action, productId] = query.data.split('::');
  const chatId = query.message.chat.id;

  if (String(chatId) !== String(TELEGRAM_CHAT_ID)) return;

  if (action === 'ignore') {
    if (ignoredProducts.has(productId)) {
      ignoredProducts.delete(productId);
      saveState();
      const name = productState[productId]?.name || productId;
      await bot.answerCallbackQuery(query.id, { text: `🔔 Unignored: ${name}` });
      await bot.editMessageReplyMarkup({
        inline_keyboard: [[
          { text: '🔔 Unignored ✓', callback_data: `ignore::${productId}` },
          { text: '🔗 Open Listing', url: productState[productId]?.link || 'https://www.pokemoncenter.com/en-gb' },
        ]]
      }, { chat_id: chatId, message_id: query.message.message_id });
    } else {
      ignoredProducts.add(productId);
      saveState();
      const name = productState[productId]?.name || productId;
      await bot.answerCallbackQuery(query.id, { text: `🔕 Ignored: ${name}` });
      await bot.editMessageReplyMarkup({
        inline_keyboard: [[
          { text: '🔕 Ignored ✓', callback_data: `ignore::${productId}` },
          { text: '🔗 Open Listing', url: productState[productId]?.link || 'https://www.pokemoncenter.com/en-gb' },
        ]]
      }, { chat_id: chatId, message_id: query.message.message_id });
    }
  }
});

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
    `🤖 *Pokémon Monitor Status*\nMode: ${mode}\nTracking: ${Object.keys(productState).length} products\nIgnored: ${ignoredProducts.size} products`,
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
  productState = {};
  saveState();
  bot.sendMessage(TELEGRAM_CHAT_ID, '🗑️ Cache cleared — all products will re-trigger on next check.');
});

bot.onText(/\/ignored/i, (msg) => {
  if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  if (ignoredProducts.size === 0) {
    bot.sendMessage(TELEGRAM_CHAT_ID, '✅ No ignored products.');
    return;
  }
  const list = [...ignoredProducts].map(id => {
    const name = productState[id]?.name || id;
    return `• ${name}`;
  }).join('\n');
  bot.sendMessage(TELEGRAM_CHAT_ID, `🔕 *Ignored Products (${ignoredProducts.size}):*\n${list}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/i, (msg) => {
  if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  bot.sendMessage(TELEGRAM_CHAT_ID, [
    '🤖 *Pokémon Center UK Monitor*',
    '',
    '`/dropmode on` — 15s check interval',
    '`/dropmode off` — 2hr check interval',
    '`/status` — Current status',
    '`/check` — Manual check now',
    '`/ignored` — Show ignored products',
    '`/clearcache` — Reset all state',
    '`/help` — This message',
    '',
    '*Alert buttons:*',
    '🔕 Ignore — mute this item (tap again to unignore)',
    '🔗 Open Listing — go to Pokémon Center',
  ].join('\n'), { parse_mode: 'Markdown' });
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function main() {
  // Kill any other running instances
  try { await bot.deleteWebHook({ drop_pending_updates: true }); } catch(_) {}
  await new Promise(r => setTimeout(r, 5000));
  bot.startPolling();
  console.log('🎮 Pokémon Center UK Monitor starting...');

  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !ANTHROPIC_API_KEY || !SCRAPER_API_KEY) {
    console.error('❌ Missing required env vars');
    process.exit(1);
  }

  await bot.sendMessage(TELEGRAM_CHAT_ID, [
    '🎮 *Pokémon Center UK Monitor Online*',
    `🕐 Normal mode — checking every 2 hours`,
    `✅ Stock status tracking`,
    `🔄 Restock alerts enabled`,
    '',
    `Send /help for commands`,
  ].join('\n'), { parse_mode: 'Markdown' });

  await checkProducts();
  startMonitor(NORMAL_INTERVAL_MS);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
