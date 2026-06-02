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
const EBAY_APP_ID       = process.env.EBAY_APP_ID;

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
// productState: { [id]: { name, price, link, stockStatus, lastSeen } }
let productState = loadJSON(PRODUCTS_FILE, {});
// ignoredProducts: Set of product ids
let ignoredProducts = new Set(loadJSON(IGNORED_FILE, []));

// ─── INIT ─────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
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

// ─── SCRAPER ──────────────────────────────────────────────────────────────────
async function scrapeCategory(slug) {
  const targetUrl = `https://www.pokemoncenter.com/en-gb/category/${slug}`;
  const proxyUrl  = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}&country_code=gb`;

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

    // Look for limit text
    const bodyText = $('body').text();
    const limitMatch = bodyText.match(/limit[:\s]+(\d+)\s+per\s+(customer|order|person|household)/i) ||
                       bodyText.match(/maximum[:\s]+(\d+)\s+per\s+(customer|order|person|household)/i) ||
                       bodyText.match(/max[:\s]+(\d+)\s+per\s+(customer|order|person|household)/i);

    if (limitMatch) return `Max ${limitMatch[1]} per ${limitMatch[2]}`;

    // Check quantity selector max
    const qtyMax = $('input[name="quantity"]').attr('max') || $('[class*="quantity"] input').attr('max');
    if (qtyMax && parseInt(qtyMax) <= 10) return `Max ${qtyMax} per order`;

    return null;
  } catch (_) {
    return null;
  }
}

// ─── EBAY UK SOLD DATA ────────────────────────────────────────────────────────
async function getEbaySoldData(productName) {
  try {
    // Use eBay Finding API if we have app ID, otherwise scrape
    if (EBAY_APP_ID) {
      const url = `https://svcs.ebay.com/services/search/FindingService/v1?OPERATION-NAME=findCompletedItems&SERVICE-VERSION=1.0.0&SECURITY-APPNAME=${EBAY_APP_ID}&RESPONSE-DATA-FORMAT=JSON&keywords=${encodeURIComponent(productName)}&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true&itemFilter(1).name=Currency&itemFilter(1).value=GBP&sortOrder=EndTimeSoonest&paginationInput.entriesPerPage=20&outputSelector=SellingStatus`;
      const res = await axios.get(url, { timeout: 15000 });
      const items = res.data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];

      if (items.length === 0) return null;

      const prices = items
        .map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0))
        .filter(p => p > 0)
        .sort((a, b) => a - b);

      if (prices.length === 0) return null;

      // Remove outliers (top and bottom 10%)
      const trimCount = Math.floor(prices.length * 0.1);
      const trimmed = prices.slice(trimCount, prices.length - trimCount);

      const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
      const last5 = prices.slice(-5);
      const avgLast5 = last5.reduce((a, b) => a + b, 0) / last5.length;

      return {
        avgSold: avg.toFixed(2),
        avgLast5: avgLast5.toFixed(2),
        lastSold: prices[prices.length - 1].toFixed(2),
        volume30d: prices.length,
      };
    }

    // Fallback: scrape eBay completed listings
    const searchQuery = encodeURIComponent(productName);
    const ebayUrl = `https://www.ebay.co.uk/sch/i.html?_nkw=${searchQuery}&LH_Complete=1&LH_Sold=1&_sop=13&LH_PrefLoc=1`;
    const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(ebayUrl)}&country_code=gb`;
    const res = await axios.get(proxyUrl, { timeout: 45000 });
    const $ = cheerio.load(res.data);

    const prices = [];
    $('.s-item__price').each((_, el) => {
      const text = $(el).text().replace(/[£,]/g, '').trim();
      const price = parseFloat(text);
      if (!isNaN(price) && price > 0) prices.push(price);
    });

    if (prices.length === 0) return null;

    prices.sort((a, b) => a - b);
    const trimCount = Math.floor(prices.length * 0.1);
    const trimmed = prices.slice(trimCount, prices.length - trimCount);
    const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    const last5 = prices.slice(0, 5);
    const avgLast5 = last5.reduce((a, b) => a + b, 0) / last5.length;

    return {
      avgSold: avg.toFixed(2),
      avgLast5: avgLast5.toFixed(2),
      lastSold: prices[0].toFixed(2),
      volume30d: prices.length,
    };
  } catch (err) {
    console.error('eBay error:', err.message);
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
async function analyseProduct(product, ebayData) {
  const ebayContext = ebayData
    ? `eBay UK Sold Data: Avg Sold £${ebayData.avgSold} | Avg Last 5: £${ebayData.avgLast5} | Last Sold: £${ebayData.lastSold} | 30d Volume: ${ebayData.volume30d} sales`
    : 'eBay data: not available';

  const prompt = `You are a Pokémon TCG resale expert for the UK market.

Product: ${product.name}
Price: ${product.price}
${ebayContext}

Respond in JSON only:
{
  "priority": "HIGH|MEDIUM|LOW",
  "priority_reason": "one sentence",
  "resale_notes": "one sentence about profit potential",
  "hype_level": "HIGH|MEDIUM|LOW",
  "should_alert": true
}

Priority rules:
- HIGH: contains booster packs, ETBs, booster boxes, collection boxes with packs, promo cards
- MEDIUM: tins, accessories with some demand
- LOW: everything else`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
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

function calcProfit(retailPrice, avgSold) {
  const retail = parseFloat(String(retailPrice).replace(/[£,]/g, ''));
  const sold   = parseFloat(avgSold);
  if (isNaN(retail) || isNaN(sold)) return null;
  const profit = sold - retail;
  const pct    = ((profit / retail) * 100).toFixed(0);
  return { profit: profit.toFixed(2), pct };
}

async function sendAlert(product, analysis, ebayData, purchaseLimit, eventType) {
  const emoji       = PRIORITY_EMOJI[analysis.priority] || '⚪';
  const stockEmoji  = STOCK_EMOJI[product.stockStatus] || '❓';
  const stockLabel  = STOCK_LABEL[product.stockStatus] || 'Unknown';
  const modeLabel   = dropMode ? '⚡ DROP MODE' : '🕐 Normal Mode';

  const eventLabel = {
    new:       '🆕 New Listing',
    restock:   '🔄 Restock',
    oos:       '📉 Now Out of Stock',
  }[eventType] || '🆕 New';

  let profitLine = '';
  if (ebayData) {
    const p = calcProfit(product.price, ebayData.avgLast5);
    if (p) {
      const sign = parseFloat(p.profit) >= 0 ? '+' : '';
      profitLine = `💰 Est\\. Profit: ${sign}£${escapeMarkdown(p.profit)} \\(${sign}${p.pct}%\\)\n`;
    }
  }

  const ebayLines = ebayData ? [
    `📊 eBay Avg Last 5: £${escapeMarkdown(ebayData.avgLast5)}`,
    `📈 Last Sold: £${escapeMarkdown(ebayData.lastSold)}`,
    `🔢 30d Volume: ${ebayData.volume30d} sales`,
  ].join('\n') : '📊 eBay data: unavailable';

  const limitLine = purchaseLimit ? `🛒 ${escapeMarkdown(purchaseLimit)}\n` : '';

  const message = [
    `${emoji} *${analysis.priority} PRIORITY* \\| ${eventLabel}`,
    `${modeLabel} \\| ${stockEmoji} ${escapeMarkdown(stockLabel)}`,
    ``,
    `📦 *${escapeMarkdown(product.name)}*`,
    `💷 Price: ${escapeMarkdown(product.price)}`,
    limitLine.trim() ? limitLine.trim() : null,
    ``,
    ebayLines,
    profitLine.trim() ? profitLine.trim() : null,
    ``,
    `💡 ${escapeMarkdown(analysis.priority_reason)}`,
    `🔥 Hype: ${analysis.hype_level} \\| ${escapeMarkdown(analysis.resale_notes)}`,
  ].filter(l => l !== null).join('\n');

  const keyboard = {
    inline_keyboard: [[
      { text: '🔕 Ignore', callback_data: `ignore::${product.id}` },
      { text: '📊 Deep Analysis', callback_data: `deep::${product.id}` },
    ], [
      { text: '🔗 Open Listing', url: product.link },
    ]]
  };

  await bot.sendMessage(TELEGRAM_CHAT_ID, message, {
    parse_mode: 'MarkdownV2',
    reply_markup: keyboard,
  });
}

// ─── DEEP ANALYSIS ────────────────────────────────────────────────────────────
async function sendDeepAnalysis(product, chatId, messageId) {
  await bot.sendMessage(chatId, '🔍 Running deep analysis...');

  const ebayData = await getEbaySoldData(product.name);

  const prompt = `You are a Pokémon TCG UK resale expert. Give a detailed analysis of this product.

Product: ${product.name}
Price: ${product.price}
${ebayData ? `eBay: Avg £${ebayData.avgSold} | Last 5 avg £${ebayData.avgLast5} | Last sold £${ebayData.lastSold} | 30d volume ${ebayData.volume30d}` : 'No eBay data'}

Cover:
1. Is this worth buying to resell?
2. What is the demand like?
3. What price should I aim to sell at?
4. Any risks?
5. Best platforms to sell on (eBay UK, Facebook, etc)

Be specific and concise.`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  await bot.sendMessage(chatId, `📊 *Deep Analysis: ${product.name}*\n\n${msg.content[0].text}`, { parse_mode: 'Markdown' });
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
      // Brand new product
      eventType = 'new';
    } else if (prev.stockStatus !== product.stockStatus) {
      // Stock status changed
      if (product.stockStatus === 'in_stock') eventType = 'restock';
      else if (product.stockStatus === 'out_of_stock') eventType = 'oos';
    }

    // Update state
    productState[product.id] = {
      name: product.name,
      price: product.price,
      link: product.link,
      stockStatus: product.stockStatus,
      lastSeen: timestamp,
    };
    saveState();

    if (!eventType) continue;

    // Don't alert on out of stock events for items we've never alerted on as in_stock
    if (eventType === 'oos' && !prev?.alertedInStock) continue;

    console.log(`  [${eventType.toUpperCase()}] ${product.name} (${product.stockStatus})`);

    try {
      // Get eBay data and purchase limit in parallel
      const [ebayData, purchaseLimit] = await Promise.all([
        getEbaySoldData(product.name),
        product.stockStatus === 'in_stock' ? scrapeProductLimit(product.link) : Promise.resolve(null),
      ]);

      // Override priority if contains cards
      let analysis = await analyseProduct(product, ebayData);
      if (containsCards(product.name)) analysis.priority = 'HIGH';

      await sendAlert(product, analysis, ebayData, purchaseLimit, eventType);

      // Mark that we've alerted this product as in stock
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
      // Toggle off — unignore
      ignoredProducts.delete(productId);
      saveState();
      const name = productState[productId]?.name || productId;
      await bot.answerCallbackQuery(query.id, { text: `🔔 Unignored: ${name}` });
      await bot.editMessageReplyMarkup({
        inline_keyboard: [[
          { text: '🔔 Unignored ✓', callback_data: `ignore::${productId}` },
          { text: '📊 Deep Analysis', callback_data: `deep::${productId}` },
        ], [
          { text: '🔗 Open Listing', url: productState[productId]?.link || 'https://www.pokemoncenter.com/en-gb' },
        ]]
      }, { chat_id: chatId, message_id: query.message.message_id });
    } else {
      // Ignore
      ignoredProducts.add(productId);
      saveState();
      const name = productState[productId]?.name || productId;
      await bot.answerCallbackQuery(query.id, { text: `🔕 Ignored: ${name}` });
      await bot.editMessageReplyMarkup({
        inline_keyboard: [[
          { text: '🔕 Ignored ✓', callback_data: `ignore::${productId}` },
          { text: '📊 Deep Analysis', callback_data: `deep::${productId}` },
        ], [
          { text: '🔗 Open Listing', url: productState[productId]?.link || 'https://www.pokemoncenter.com/en-gb' },
        ]]
      }, { chat_id: chatId, message_id: query.message.message_id });
    }
  }

  if (action === 'deep') {
    const product = productState[productId];
    if (!product) {
      await bot.answerCallbackQuery(query.id, { text: 'Product not found in state.' });
      return;
    }
    await bot.answerCallbackQuery(query.id, { text: '🔍 Running deep analysis...' });
    await sendDeepAnalysis({ ...product, id: productId }, chatId, query.message.message_id);
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
    '📊 Deep Analysis — detailed resale breakdown',
    '🔗 Open Listing — go to Pokémon Center',
  ].join('\n'), { parse_mode: 'Markdown' });
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🎮 Pokémon Center UK Monitor starting...');

  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !ANTHROPIC_API_KEY || !SCRAPER_API_KEY) {
    console.error('❌ Missing required env vars');
    process.exit(1);
  }

  await bot.sendMessage(TELEGRAM_CHAT_ID, [
    '🎮 *Pokémon Center UK Monitor v2 Online*',
    `🕐 Normal mode — checking every 2 hours`,
    `✅ Stock status tracking`,
    `🔄 Restock alerts enabled`,
    `📊 eBay UK resale data`,
    `🔕 Ignore buttons on alerts`,
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
