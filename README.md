### MyChatbot — WooCommerce‑এর জন্য এআই কাস্টমার সাপোর্ট ও সেলস সহায়ক

এটি একটি এআই‑চালিত, বাংলা‑প্রথম, মানবসদৃশ চ্যাটবট। রিয়েল‑টাইম চ্যাট (Socket.IO), ইমেজ বোঝা, WooCommerce REST API দিয়ে পণ্য অনুসন্ধান, নিরাপদ অর্ডার প্লেস/ক্যানসেল, এবং SQLite‑এ কনটেক্সট পার্সিস্টেন্স—সব একসাথে। Facebook Messenger ও Zapier‑এর জন্য পৃথক webhook অন্তর্ভুক্ত।

### Features
- **Bangla-first conversational AI** using GPT‑4o with tool-calling
- **Realistic typing experience** and Messenger-style typing animation
- **WooCommerce integration**: product search, product details, variations, shipping options, create/cancel orders
- **Image understanding**: user uploads images; the bot analyzes and auto-searches relevant products
- **Persistent context**: SQLite-backed sessions, messages, and rolling conversation summaries
- **Session continuity** across refreshes and server restarts; avoids duplicate greetings for returning users
- **Facebook Messenger** webhook (reuses same LLM + SQLite context)
- **Zapier webhook** that returns AI replies as plain text for immediate use
- **Production hardening**: rate limiting, retries, error handling, logging, CORS, and env validation
- **UI**: simple web client with chat bubbles, quick replies, image upload, and a light/dark theme toggle [[memory:6981981]]

### Demo (লোকালি)
1) সার্ভার চালু করুন
```bash
npm install
npm run dev
```
2) অ্যাপ খুলুন: `http://localhost:3000`

### কী কী এন্ডপয়েন্ট
- Static site: `GET /` (serves `public/`)
- Health: `GET /healthz`
- WooCommerce products (backend proxy): `GET /api/products?search=watch&per_page=12`
- File upload (image): `POST /api/upload` (multipart, field: `file`)
- Socket.IO namespace: `/chat` (real-time messaging)
- Facebook webhook: `GET/POST /webhooks/facebook` (verification + receive)
- Zapier webhook: `POST /webhooks/zapier` → returns plain text AI reply

### Environment Variables
Core
```bash
PORT=3000
ORIGIN=http://localhost:3000
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
USE_LLM_TOOLING=true
SQLITE_PATH=/absolute/path/to/data.sqlite # optional, defaults to project/data.sqlite
```

WooCommerce
```bash
WC_BASE_URL=https://yourstore.com
WC_CONSUMER_KEY=ck_...
WC_CONSUMER_SECRET=cs_...
WC_USE_ZONE_SHIPPING=true                 # optional
WC_SHIPPING_METHOD_ID=flat_rate           # fallback
WC_SHIPPING_TITLE="Flat Rate"            # fallback
WC_SHIPPING_FEE=0.00                      # fallback
```

Facebook Messenger
```bash
FB_PAGE_TOKEN=YOUR_PAGE_ACCESS_TOKEN
FB_VERIFY_TOKEN=YOUR_VERIFY_TOKEN
```

### Local Development
```bash
npm install
npm run dev
```
Project structure
```
mychatbot/
  public/                # frontend (HTML/CSS/JS)
  integrations/          # WooCommerce integration
  persistence/           # SQLite helpers
  uploads/               # user uploads (served statically)
  server.js              # Express + Socket.IO + webhooks
  README.md
```

### Frontend (public/)
- `index.html` — chat UI shell
- `styles.css` — clean chat layout, images, typing animation
- `app.js` — Socket.IO client, local history, image upload, quick replies, safe bot HTML rendering

### Backend (server.js)
- Express server with static files, REST routes, and webhooks
- Socket.IO `/chat` namespace for real-time chat with typing indicators
- GPT‑4o tool-calling: search products, product details, variations, shipping ETA/options, place/cancel order, get categories, get current offer
- SQLite persistence: `sessions`, `messages`, `customers`, `summaries`
- Image analysis via OpenAI (Responses API), auto-derived product search
- Rate limiting, typed wait messages, retries on 429 with trimmed context + summary

### WooCommerce Integration
Module: `integrations/woocommerce.js`
- `fetchProducts`, `fetchProductById`, `fetchCategories`, `fetchVariations`
- `createOrder`, `cancelOrder`
- `listShippingOptions`
Notes:
- Use a Read/Write API key for orders (Read-only is insufficient)
- Variable products require a valid `variation_id` in line items

### Image Uploads and Vision
- Upload via `POST /api/upload` (multipart, field: `file`)
- Files are served under `/uploads/...`
- Images are stored in chat history (as attachments) and replayed on reconnect
- Vision extracts intent; bot searches WooCommerce and responds with relevant products

### Facebook Messenger Webhook
Verification
```text
GET /webhooks/facebook?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=12345
```
Receive (POST)
- Reuses the same LLM + SQLite context
- Sends typing indicators and replies via the Graph API

Setup steps
1) Create a Meta App → add Messenger product
2) Generate Page Access Token → set `FB_PAGE_TOKEN`
3) Set `FB_VERIFY_TOKEN`
4) Verify webhook callback URL (HTTPS required)
5) Subscribe your Page to the app

### Zapier Webhook (Plain Text AI Reply)
Endpoint: `POST /webhooks/zapier`
- Body format:
```json
{ "data": "{\"sender_psid\":\"432111...\",\"text\":\"hello\",\"time\":\"2025-09-30T18:41:56.489Z\"}" }
```
- Returns `text/plain` with an AI-composed Bangla reply (HTML stripped)

### Persistence (SQLite)
Tables (created automatically):
- `sessions` — per-session metadata
- `messages` — chat turns with timestamps
- `customers` — saved details for reorder flows
- `summaries` — rolling short conversation summary

Recommended PRAGMAs for durability (enabled in code):
- WAL mode, `busy_timeout`, and indexes on `(session_id, ts)`

### Production Hardening Checklist
- CORS allow-list using `ORIGIN`
- Helmet, compression, and static asset caching
- Input validation and length limits on socket/REST payloads
- Per-session cooldowns, retry/backoff on 429
- Only confirm orders when a real Woo order ID is returned
- Log redaction for secrets; structured logs
- Docker + reverse proxy (TLS) recommended; use a process manager (PM2/systemd)

### Quick Troubleshooting
- Orders 401: use WooCommerce key with Read/Write permissions
- Orders empty items: ensure `line_items` include `product_id` (+ `variation_id` for variable)
- Vision errors: ensure `OPENAI_API_KEY` set; images uploaded correctly; retry (backoff built-in)
- FB bot not responding: verify webhook URL, subscribe Page, valid tokens, HTTPS reachable

### License
MIT — see LICENSE if provided.

Bengali Sales Chatbot (Node.js + Raw JS + Socket.IO)

Quick Start

```bash
npm install
npm run dev
# open http://localhost:3000
```

.env example
Copy the following into a file named `.env` in the project root:

```bash
PORT=3000
ORIGIN=http://localhost:3000
LOG_LEVEL=info

# Optional LLM integration
USE_LLM=false
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini

# Offers
OFFER_RULESET=default

# WooCommerce (DhakaCarts)
WC_BASE_URL=https://dhakacarts.com
WC_CONSUMER_KEY=
WC_CONSUMER_SECRET=
```

Scripts
- dev: start local server
- start: production run
- health: check `/healthz`

Notes
- Toggle LLM by setting `USE_LLM=true` and `OPENAI_API_KEY`.
- Default origin is `http://localhost:3000`.
