# 🎮 Pokémon Center UK Drop Monitor

Monitors Pokémon Center UK for new arrivals and restocks. Sends Telegram alerts with Claude-powered priority ratings and resale estimates.

---

## Features

- Watches **New Arrivals** and **Out of Stock** pages
- **Normal mode**: checks every 2 hours
- **Drop mode**: checks every 15 seconds (activate via Telegram)
- Filters out: plush, pin, badge, clothing, apparel, sticker, poster, keychain, mug, bottle, hat, bag, cushion, lamp, ornament
- Claude AI rates each product: priority (HIGH/MEDIUM/LOW) + estimated resale value
- Persists seen products so you don't get duplicate alerts

---

## Telegram Commands

| Command | Description |
|---|---|
| `/dropmode on` | Switch to 15-second check interval |
| `/dropmode off` | Switch back to 2-hour interval |
| `/status` | Show current mode and product count |
| `/check` | Run a manual check immediately |
| `/clearcache` | Reset seen products (re-alerts everything) |
| `/help` | Show command list |

---

## Local Setup (for testing)

```bash
# 1. Clone your repo
git clone https://github.com/YOUR_USERNAME/pokemon-center-uk-monitor
cd pokemon-center-uk-monitor

# 2. Install dependencies
npm install

# 3. Create .env from template
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# 4. Run locally
npm start
```

---

## Deploy to Render

### Step 1 — Push to GitHub

```bash
# In the project folder:
git init
git add .
git commit -m "Initial commit — Pokémon Center UK monitor"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/pokemon-center-uk-monitor.git
git push -u origin main
```

### Step 2 — Create Render Service

1. Go to [render.com](https://render.com) → **New** → **Web Service** (or use the `render.yaml` via Blueprint)
2. Connect your GitHub repo
3. Settings:
   - **Name**: `pokemon-center-uk-monitor`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node monitor.js`
   - **Instance Type**: Free (or Starter for reliability)

### Step 3 — Add Environment Variables

In Render dashboard → **Environment** tab, add:

| Key | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | `8997201869:AAFU6qxaNtCC8MCFZ1gR1JU6DBmLna7Nctc` |
| `TELEGRAM_CHAT_ID` | `6302801017` |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

### Step 4 — Deploy

Click **Deploy**. Render will build and start the monitor. You'll get a Telegram message confirming it's online.

---

## Future Pushes (auto-deploy)

```bash
git add .
git commit -m "Your change description"
git push
```

Render picks up the push and redeploys automatically.

---

## Alert Format Example

```
🔴 HIGH PRIORITY | 🆕 New Arrival
⚡ DROP MODE

📦 Scarlet & Violet — Prismatic Evolutions Elite Trainer Box
💷 Price: £54.99
📈 Est. Resale: £90–£130

💡 ETBs from this set have strong secondary market demand
🛒 Historically sells out within hours and resells 60–80% above retail

🔗 Buy Now
```
