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

const CARD_TERMS = [
  'booster', 'etb', 'elite trainer', 'pack', 'collection box',
  'tin', 'bundle', 'tcg', 'trading card', 'promo card',
  'build & battle', 'build and battle', 'blister', 'display box'
];

const PAGES = {
  newReleases: 'https://www.pokemoncenter.com/en-gb/category/new-releases',
  backInStock: 'https://www.pokemoncenter.com/en-gb/search/back-in-stock',
};

// ─── STATE FILES ──────────────────────────────────────────────────────────────
const PRODUCTS_FILE = path.join(__dirname, 'products_state.json');
const IGNORED_FILE  = path.join(__dirname, 'ignored_products.json');

let dropMode = false;
let monitorInterval = null;
let productState    = loadJSON(PRODUCTS_FILE, {});
let ignoredProducts = new Set(loadJSON(IGNORED_FILE, []));

// ─── INIT ─────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── PERSISTENCE ──────────────────────────────────────────────────────────────
function loadJSON(file, def) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error('Load error:', e.message); }
  return def;
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
async function scrapePage(pageKey, targetUrl) {
  const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}&country_code=gb`;
  const res = await axios.get(proxyUrl, { timeout: 60000 });
  const $ = cheerio.load(res.data);
  const products = [];

  // Primary selector — matches Pokémon Center UK product cards
  const selectors = [
    '[class*="product-fe"]',
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

      // Detect stock status from page hints
      const elHtml = $(el).html() || '';
      let stockStatus = pageKey === 'backInStock' ? 'in_stock' : 'in_stock';
      if (/out-of-stock|sold-out|unavailable/i.test(elHtml)) stockStatus = 'out_of_stock';
      else if (/coming-soon|not-available|notify-me/i.test(elHtml)) stockStatus = 'not_available';

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

  // Fallback: __NEXT_DATA__ JSON
  if (products.length === 0) {
    const nextRaw = $('script#__NEXT_DATA__').html();
    if (nextRaw) {
      try {
        const nd = JSON.parse(nextRaw);
        const prods = nd?.props?.pageProps?.products || nd?.props?.pageProps?.category?.products || [];
        for (const p of prods) {
          if (p.name) products.push({
            name: p.name, price: p.price || 'N/A',
            link: p.url || targetUrl, id: String(p.id || p.name),
            stockStatus: 'in_stock',
          });
        }
      } catch (_) {}
    }
  }

  // Fallback: JSON-LD
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
              link: item.url || targetUrl,
              id: String(item.sku || item.name),
              stockStatus: 'in_stock',
            });
          }
        });
      } catch (_) {}
    });
  }

  console.log(`  [${pageKey}] ${products.length} products found`);
  return products;
}

// ─── EBAY UK SOLD DATA ────────────────────────────────────────────────────────
async function getEbaySoldData(productName) {
  try {
    const searchQuery = encodeURIComponent(productName);
    const ebayUrl = `https://www.ebay.co.uk/sch/i.html?_nkw=${searchQuery}&LH_Complete=1&LH_Sold=1&_sop=13&LH_PrefLoc=1`;
    const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(ebayUrl)}&country_code=gb`;
    const res = await axios.get(proxyUrl, { timeout: 45000 });
    const $ = cheerio.load(res.data);

    const prices = [];
    $('.s-item__price').each((_, el) => {
      const text = $(el).text().replace(/[£,\s]/g, '');
      const price = parseFloat(text);
      if (!isNaN(price) && price > 1) prices.push(price);
    });

    if (prices.length === 0) return null;

    prices.sort((a, b) => a - b);
    const trim = Math.floor(prices.length * 0.1);
    const trimmed = prices.slice(trim, prices.length - trim || prices.length);
    const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    const last5 = prices.slice(0, Math.min(5, prices.length));
    const avgLast5 = last5.reduce((a, b) => a + b, 0) / last5.length;

    return {
      avgSold:  avg.toFixed(2),
      avgLast5: avgLast5.toFixed(2),
      lastSold: prices[0].toFixed(2),
      volume:   prices.length,
    };
  } catch (err) {
    console.error('eBay error:', err.message);
    return null;
  }
}

// ─── PRODUCT PAGE: purchase limit ─────────────────────────────────────────────
async function getPurchaseLimit(productUrl) {
  try {
    const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(productUrl)}&country_code=gb`;
    const res = await axios.get(proxyUrl, { timeout: 30000 });
    const $ = cheerio.load(res.data);
    const text = $('body').text();
    const m = text.match(/(?:limit|maximum|max)[:\s]+(\d+)\s+per\s+(customer|order|person|household)/i);
    if (m) return `Max ${m[1]} per ${m[2]}`;
    const qtyMax = $('input[name="quantity"]').attr('max');
    if (qtyMax && parseInt(qtyMax) <= 10) return `Max ${qtyMax} per order`;
    return null;
  } catch (_) { return null; }
}

// ─── FILTERS ──────────────────────────────────────────────────────────────────
function isFiltered(name) {
  const l = name.toLowerCase();
  return FILTER_WORDS.some(w => l.includes(w));
}
function containsCards(name) {
  const l = name.toLowerCase();
  return CARD_TERMS.some(t => l.includes(t));
}

// ─── CLAUDE ANALYSIS ──────────────────────────────────────────────────────────
async function analyseProduct(product, ebayData) {
  const ebayCtx = ebayData
    ? `eBay UK: Avg £${ebayData.avgSold} | Last 5 avg £${ebayData.avgLast5} | Last sold £${ebayData.lastSold} | ${ebayData.volume} sales`
    : 'No eBay data available';

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    messages: [{ role: 'user', content: `You are a Pokémon TCG UK resale expert. Respond in JSON only, no markdown.

Product: ${product.name}
Price: ${product.price}
${ebayCtx}

JSON format:
{"priority":"HIGH|MEDIUM|LOW","priority_reason":"one sentence","resale_notes":"one sentence","hype_level":"HIGH|MEDIUM|LOW"}

HIGH priority = booster packs, ETBs, booster boxes, sealed TCG product with strong resale
MEDIUM = tins, accessories with demand
LOW = everything else` }],
  });

  const clean = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── SEND ALERT ───────────────────────────────────────────────────────────────
const P_EMOJI = { HIGH: '🔴', MEDIUM: '🟡', LOW: '🟢' };
const S_EMOJI = { in_stock: '✅', out_of_stock: '❌', not_available: '⏳' };
const S_LABEL = { in_stock: 'In Stock', out_of_stock: 'Out of Stock', not_available: 'Not Yet Available' };
const E_LABEL = { new: '🆕 New Listing', restock: '🔄 Restock', oos: '📉 Out of Stock' };

function esc(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

function calcProfit(retailStr, avgSoldStr) {
  const r = parseFloat(String(retailStr).replace(/[^0-9.]/g, ''));
  const s = parseFloat(avgSoldStr);
  if (isNaN(r) || isNaN(s) || r === 0) return null;
  const profit = (s - r).toFixed(2);
  const pct = (((s - r) / r) * 100).toFixed(0);
  return { profit, pct };
}

async function sendAlert(product, analysis, ebayData, limit, eventType) {
  const pe = P_EMOJI[analysis.priority] || '⚪';
  const se = S_EMOJI[product.stockStatus] || '❓';
  const sl = S_LABEL[product.stockStatus] || 'Unknown';
  const el = E_LABEL[eventType] || '🆕';
  const mode = dropMode ? '⚡ DROP MODE' : '🕐 Normal Mode';

  const lines = [
    `${pe} *${esc(analysis.priority)} PRIORITY* \\| ${el}`,
    `${mode} \\| ${se} ${esc(sl)}`,
    ``,
    `📦 *${esc(product.name)}*`,
    `💷 Price: ${esc(product.price)}`,
  ];

  if (limit) lines.push(`🛒 ${esc(limit)}`);
  lines.push(``);

  if (ebayData) {
    lines.push(`📊 eBay Avg Last 5: £${esc(ebayData.avgLast5)}`);
    lines.push(`📈 Last Sold: £${esc(ebayData.lastSold)}`);
    lines.push(`🔢 30d Volume: ${ebayData.volume} sales`);
    const p = calcProfit(product.price, ebayData.avgLast5);
    if (p) {
      const sign = parseFloat(p.profit) >= 0 ? '+' : '';
      lines.push(`💰 Est\\. Profit: ${sign}£${esc(p.profit)} \\(${sign}${p.pct}%\\)`);
    }
  } else {
    lines.push(`📊 eBay data: unavailable`);
  }

  lines.push(``);
  lines.push(`💡 ${esc(analysis.priority_reason)}`);
  lines.push(`🔥 Hype: ${esc(analysis.hype_level)} \\| ${esc(analysis.resale_notes)}`);

  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔕 Ignore', callback_data: `ignore::${product.id}` },
        { text: '📊 Deep Analysis', callback_data: `deep::${product.id}` },
      ],
      [{ text: '🔗 Open Listing', url: product.link }],
    ],
  };

  await bot.sendMessage(TELEGRAM_CHAT_ID, lines.join('\n'), {
    parse_mode: 'MarkdownV2',
    reply_markup: keyboard,
  });
}

// ─── DEEP ANALYSIS ────────────────────────────────────────────────────────────
async function sendDeepAnalysis(product, chatId) {
  await bot.sendMessage(chatId, '🔍 Running deep analysis...');
  const ebayData = await getEbaySoldData(product.name);
  const prompt = `You are a Pokémon TCG UK resale expert. Detailed analysis:

Product: ${product.name}
Price: ${product.price}
${ebayData ? `eBay: Avg £${ebayData.avgSold} | Last 5 £${ebayData.avgLast5} | Last sold £${ebayData.lastSold} | Volume: ${ebayData.volume}` : 'No eBay data'}

Cover:
1. Worth buying to resell?
2. Demand level?
3. Target sell price?
4. Risks?
5. Best platforms (eBay UK, Facebook Marketplace, etc)?

Be specific and concise.`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  await bot.sendMessage(chatId, `📊 *Deep Analysis*\n\n${msg.content[0].text}`, { parse_mode: 'Markdown' });
}

// ─── MAIN CHECK ───────────────────────────────────────────────────────────────
async function checkProducts() {
  const ts = new Date().toISOString();
  console.log(`[${ts}] Checking | Drop mode: ${dropMode}`);

  const allProducts = [];
  for (const [key, url] of Object.entries(PAGES)) {
    try {
      const products = await scrapePage(key, url);
      allProducts.push(...products);
    } catch (err) {
      console.error(`  [ERROR] ${key}: ${err.message}`);
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
      else if (product.stockStatus === 'out_of_stock' && prev.alertedInStock) eventType = 'oos';
    }

    productState[product.id] = {
      name: product.name,
      price: product.price,
      link: product.link,
      stockStatus: product.stockStatus,
      alertedInStock: prev?.alertedInStock || false,
      lastSeen: ts,
    };
    saveState();

    if (!eventType) continue;

    console.log(`  [${eventType.toUpperCase()}] ${product.name}`);

    try {
      const [ebayData, limit] = await Promise.all([
        getEbaySoldData(product.name),
        product.stockStatus === 'in_stock' ? getPurchaseLimit(product.link) : Promise.resolve(null),
      ]);

      let analysis = await analyseProduct(product, ebayData);
      if (containsCards(product.name)) analysis.priority = 'HIGH';

      await sendAlert(product, analysis, ebayData, limit, eventType);

      if (product.stockStatus === 'in_stock') {
        productState[product.id].alertedInStock = true;
        saveState();
      }

      console.log(`  [ALERTED] ${product.name} — ${analysis.priority}`);
    } catch (err) {
      console.error(`  [ALERT ERROR] ${product.name}: ${err.message}`);
      await bot.sendMessage(TELEGRAM_CHAT_ID,
        `⚠️ *New Product*\n📦 ${product.name}\n💷 ${product.price}\n🔗 ${product.link}`,
        { parse_mode: 'Markdown' }
      );
    }

    await new Promise(r => setTimeout(r, 1500));
  }
}

// ─── BUTTON CALLBACKS ─────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const [action, productId] = query.data.split('::');
  const chatId = query.message.chat.id;
  if (String(chatId) !== String(TELEGRAM_CHAT_ID)) return;

  if (action === 'ignore') {
    const isIgnored = ignoredProducts.has(productId);
    if (isIgnored) {
      ignoredProducts.delete(productId);
    } else {
      ignoredProducts.add(productId);
    }
    saveState();

    const name = productState[productId]?.name || productId;
    const newText = isIgnored ? '🔔 Unignored ✓' : '🔕 Ignored ✓';
    await bot.answerCallbackQuery(query.id, { text: isIgnored ? `🔔 Unignored: ${name}` : `🔕 Ignored: ${name}` });
    await bot.editMessageReplyMarkup({
      inline_keyboard: [
        [
          { text: newText, callback_data: `ignore::${productId}` },
          { text: '📊 Deep Analysis', callback_data: `deep::${productId}` },
        ],
        [{ text: '🔗 Open Listing', url: productState[productId]?.link || 'https://www.pokemoncenter.com/en-gb' }],
      ],
    }, { chat_id: chatId, message_id: query.message.message_id });
  }

  if (action === 'deep') {
    const product = productState[productId];
    if (!product) { await bot.answerCallbackQuery(query.id, { text: 'Product not found.' }); return; }
    await bot.answerCallbackQuery(query.id, { text: '🔍 Analysing...' });
    await sendDeepAnalysis({ ...product, id: productId }, chatId);
  }
});

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
function startMonitor(ms) {
  if (monitorInterval) clearInterval(monitorInterval);
  monitorInterval = setInterval(checkProducts, ms);
  console.log(`Monitor started | Interval: ${ms / 1000}s`);
}

function setDropMode(enabled) {
  dropMode = enabled;
  startMonitor(enabled ? DROP_INTERVAL_MS : NORMAL_INTERVAL_MS);
  bot.sendMessage(TELEGRAM_CHAT_ID,
    enabled ? `⚡ *DROP MODE ON* — checking every 15 seconds` : `🕐 *Normal mode* — checking every 2 hours`,
    { parse_mode: 'Markdown' }
  );
}

// ─── COMMANDS ─────────────────────────────────────────────────────────────────
bot.onText(/\/dropmode on/i,  msg => { if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return; setDropMode(true); });
bot.onText(/\/dropmode off/i, msg => { if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return; setDropMode(false); });

bot.onText(/\/status/i, msg => {
  if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  const mode = dropMode ? '⚡ DROP MODE (15s)' : '🕐 Normal (2hr)';
  bot.sendMessage(TELEGRAM_CHAT_ID,
    `🤖 *Pokémon Monitor Status*\nMode: ${mode}\nTracking: ${Object.keys(productState).length} products\nIgnored: ${ignoredProducts.size} products`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/check/i, msg => {
  if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  bot.sendMessage(TELEGRAM_CHAT_ID, '🔍 Running manual check...');
  checkProducts();
});

bot.onText(/\/clearcache/i, msg => {
  if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  productState = {};
  saveState();
  bot.sendMessage(TELEGRAM_CHAT_ID, '🗑️ Cache cleared — all products will re-trigger on next check.');
});

bot.onText(/\/ignored/i, msg => {
  if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  if (ignoredProducts.size === 0) { bot.sendMessage(TELEGRAM_CHAT_ID, '✅ No ignored products.'); return; }
  const list = [...ignoredProducts].map(id => `• ${productState[id]?.name || id}`).join('\n');
  bot.sendMessage(TELEGRAM_CHAT_ID, `🔕 *Ignored (${ignoredProducts.size}):*\n${list}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/i, msg => {
  if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  bot.sendMessage(TELEGRAM_CHAT_ID, [
    '🤖 *Pokémon Center UK Monitor v2*',
    '',
    '`/dropmode on` — 15s checks',
    '`/dropmode off` — 2hr checks',
    '`/status` — Current status',
    '`/check` — Manual check now',
    '`/ignored` — Show ignored items',
    '`/clearcache` — Reset all state',
    '`/help` — This message',
    '',
    '*Alert buttons:*',
    '🔕 Ignore — tap again to unignore',
    '📊 Deep Analysis — full resale breakdown',
    '🔗 Open Listing — go to Pokémon Center',
  ].join('\n'), { parse_mode: 'Markdown' });
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🎮 Pokémon Center UK Monitor v2 starting...');
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !ANTHROPIC_API_KEY || !SCRAPER_API_KEY) {
    console.error('❌ Missing env vars'); process.exit(1);
  }
  await bot.sendMessage(TELEGRAM_CHAT_ID, [
    '🎮 *Pokémon Center UK Monitor v2*',
    '🕐 Normal mode — every 2 hours',
    '✅ Stock status \\+ restock tracking',
    '📊 eBay UK resale data',
    '💰 Profit estimates',
    '🔕 Ignore buttons \\(tap again to unignore\\)',
    '',
    'Send /help for commands',
  ].join('\n'), { parse_mode: 'MarkdownV2' });

  await checkProducts();
  startMonitor(NORMAL_INTERVAL_MS);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
