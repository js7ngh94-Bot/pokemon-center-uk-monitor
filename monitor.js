const axios = require('axios');
const cheerio = require('cheerio');
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SCRAPER_API_KEY   = process.env.SCRAPER_API_KEY;
const WEBHOOK_URL       = process.env.WEBHOOK_URL; // e.g. https://your-app.onrender.com

const NORMAL_INTERVAL_MS = 2 * 60 * 60 * 1000;
const DROP_INTERVAL_MS   = 15 * 1000;
const PORT = process.env.PORT || 10000;

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
        });
      }
    });
    if (products.length > 0) break;
  }

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
          });
        }
      } catch (_) {}
    }
  }

  return products;
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
  "hype_level": "HIGH|MEDIUM|LOW"
}
Priority: HIGH = booster packs/ETBs/boxes/promo cards, MEDIUM = tins/accessories, LOW = everything else`;

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
const STOCK_LABEL    = { in_stock: 'In Stock', out_of_stock: 'Out of Stock', not_available: 'Not Yet Available' };

function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

async function sendAlert(product, analysis, eventType) {
  const emoji      = PRIORITY_EMOJI[analysis.priority] || '⚪';
  const stockEmoji = STOCK_EMOJI[product.stockStatus] || '❓';
  const stockLabel = STOCK_LABEL[product.stockStatus] || 'Unknown';
  const modeLabel  = dropMode ? '⚡ DROP MODE' : '🕐 Normal Mode';

  const eventLabel = {
    new:     '🆕 New Listing',
    restock: '🔄 Restock',
    oos:     '📉 Now Out of Stock',
  }[eventType] || '🆕 New';

  const message = [
    `${emoji} *${analysis.priority} PRIORITY* \\| ${eventLabel}`,
    `${modeLabel} \\| ${stockEmoji} ${escapeMarkdown(stockLabel)}`,
    ``,
    `📦 *${escapeMarkdown(product.name)}*`,
    `💷 Price: ${escapeMarkdown(product.price)}`,
    ``,
    `💡 ${escapeMarkdown(analysis.priority_reason)}`,
    `🔥 Hype: ${analysis.hype_level}`,
  ].join('\n');

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

  for (const [source, slug] of Object.entries(CATEGORY_SLUGS)) {
    try {
      const products = await scrapeCategory(slug);
      console.log(`  [${slug}] Found ${products.length} products`);

      for (const product of products) {
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
          alertedInStock: prev?.alertedInStock || false,
        };

        if (!eventType) continue;
        if (eventType === 'oos' && !prev?.alertedInStock) continue;

        console.log(`  [${eventType.toUpperCase()}] ${product.name}`);

        try {
          let analysis = await analyseProduct(product);
          if (containsCards(product.name)) analysis.priority = 'HIGH';
          await sendAlert(product, analysis, eventType);
          if (product.stockStatus === 'in_stock') {
            productState[product.id].alertedInStock = true;
          }
          console.log(`  [ALERTED] ${product.name} — ${analysis.priority}`);
        } catch (err) {
          console.error(`  [ALERT ERROR] ${product.name}:`, err.message);
          await bot.sendMessage(TELEGRAM_CHAT_ID,
            `⚠️ *New Product*\n📦 ${product.name}\n💷 ${product.price}\n🔗 ${product.link}`,
            { parse_mode: 'Markdown' }
          );
        }

        await new Promise(r => setTimeout(r, 1500));
      }

      saveState();
    } catch (err) {
      console.error(`  [SCRAPE ERROR] ${slug}: ${err.message}`);
    }
  }
}

// ─── HANDLE TELEGRAM UPDATE ───────────────────────────────────────────────────
async function handleUpdate(update) {
  // Callback queries (button presses)
  if (update.callback_query) {
    const query = update.callback_query;
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
    return;
  }

  // Regular messages (commands)
  const msg = update.message;
  if (!msg || !msg.text) return;
  if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;

  const text = msg.text.toLowerCase();

  if (text.includes('/dropmode on')) {
    dropMode = true;
    if (monitorInterval) clearInterval(monitorInterval);
    monitorInterval = setInterval(checkProducts, DROP_INTERVAL_MS);
    bot.sendMessage(TELEGRAM_CHAT_ID, '⚡ *DROP MODE ON* — checking every 15 seconds', { parse_mode: 'Markdown' });
  } else if (text.includes('/dropmode off')) {
    dropMode = false;
    if (monitorInterval) clearInterval(monitorInterval);
    monitorInterval = setInterval(checkProducts, NORMAL_INTERVAL_MS);
    bot.sendMessage(TELEGRAM_CHAT_ID, '🕐 *Normal mode* — checking every 2 hours', { parse_mode: 'Markdown' });
  } else if (text.includes('/status')) {
    const mode = dropMode ? '⚡ DROP MODE (15s)' : '🕐 Normal (2hr)';
    bot.sendMessage(TELEGRAM_CHAT_ID,
      `🤖 *Pokémon Monitor Status*\nMode: ${mode}\nTracking: ${Object.keys(productState).length} products\nIgnored: ${ignoredProducts.size} products`,
      { parse_mode: 'Markdown' }
    );
  } else if (text.includes('/check')) {
    bot.sendMessage(TELEGRAM_CHAT_ID, '🔍 Running manual check now...');
    checkProducts();
  } else if (text.includes('/clearcache')) {
    productState = {};
    saveState();
    bot.sendMessage(TELEGRAM_CHAT_ID, '🗑️ Cache cleared.');
  } else if (text.includes('/ignored')) {
    if (ignoredProducts.size === 0) {
      bot.sendMessage(TELEGRAM_CHAT_ID, '✅ No ignored products.');
    } else {
      const list = [...ignoredProducts].map(id => `• ${productState[id]?.name || id}`).join('\n');
      bot.sendMessage(TELEGRAM_CHAT_ID, `🔕 *Ignored (${ignoredProducts.size}):*\n${list}`, { parse_mode: 'Markdown' });
    }
  } else if (text.includes('/help')) {
    bot.sendMessage(TELEGRAM_CHAT_ID, [
      '🤖 *Pokémon Center UK Monitor*',
      '',
      '`/dropmode on` — 15s checks',
      '`/dropmode off` — 2hr checks',
      '`/status` — Current status',
      '`/check` — Manual check now',
      '`/ignored` — Show ignored',
      '`/clearcache` — Reset state',
      '`/help` — This message',
    ].join('\n'), { parse_mode: 'Markdown' });
  }
}

// ─── WEBHOOK SERVER ───────────────────────────────────────────────────────────
function startWebhookServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === `/webhook/${TELEGRAM_TOKEN}`) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const update = JSON.parse(body);
          await handleUpdate(update);
        } catch (e) {
          console.error('Webhook error:', e.message);
        }
        res.writeHead(200);
        res.end('OK');
      });
    } else if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end('OK');
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(PORT, () => {
    console.log(`Webhook server listening on port ${PORT}`);
  });
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
function startMonitor() {
  monitorInterval = setInterval(checkProducts, NORMAL_INTERVAL_MS);
  console.log(`Monitor started | Interval: ${NORMAL_INTERVAL_MS / 1000}s`);
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🎮 Pokémon Center UK Monitor starting...');

  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !ANTHROPIC_API_KEY || !SCRAPER_API_KEY || !WEBHOOK_URL) {
    console.error('❌ Missing required env vars');
    process.exit(1);
  }

  // Register webhook with Telegram
  const webhookEndpoint = `${WEBHOOK_URL}/webhook/${TELEGRAM_TOKEN}`;
  await bot.setWebHook(webhookEndpoint, { allowed_updates: ['message', 'callback_query'] });
  console.log(`Webhook set: ${webhookEndpoint}`);

  // Start HTTP server to receive webhook updates
  startWebhookServer();
  await new Promise(r => setTimeout(r, 2000));

  await bot.sendMessage(TELEGRAM_CHAT_ID, [
    '🎮 *Pokémon Center UK Monitor Online*',
    `🕐 Normal mode — checking every 2 hours`,
    `✅ Webhook mode — no more conflicts`,
    '',
    `Send /help for commands`,
  ].join('\n'), { parse_mode: 'Markdown' });

  await checkProducts();
  startMonitor();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
