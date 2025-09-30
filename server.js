const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const dotenv = require('dotenv');
const { randomUUID } = require('crypto');
const pino = require('pino');
const fs = require('fs');
const multer = require('multer');

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const ORIGIN = process.env.ORIGIN || `http://localhost:${PORT}`;
const USE_LLM = String(process.env.USE_LLM || 'true').toLowerCase() === 'true';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const USE_LLM_TOOLING = String(process.env.USE_LLM_TOOLING || 'true').toLowerCase() === 'true';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateTypingDelayMs(text) {
  const content = String(text || '');
  const approxWords = Math.max(1, Math.round(content.length / 5));
  const wordsPerMinute = 140; // human-like 120–160 wpm
  const minutes = approxWords / wordsPerMinute;
  let ms = minutes * 60000;
  ms += 250; // small base latency
  const jitter = ms * 0.1 * (Math.random() * 2 - 1);
  ms += jitter;
  ms = Math.max(600, Math.min(ms, 8000));
  return Math.round(ms);
}

// Optional: WooCommerce fetch for tool calls
let wc = null;
try {
  wc = require('./integrations/woocommerce');
} catch (_) {}

function normalizeSearchQuery(raw) {
  const s = String(raw || '').toLowerCase();
  const map = [
    ['sshirt', 'shirt'],
    ['tshart', 'tshirt'],
    ['t-shirt', 'tshirt'],
    ['smarwatch', 'smartwatch'],
    ['earbud', 'earbuds'],
    ['airbud', 'earbuds'],
    ['mobil', 'mobile'],
    ['মোবাইল', 'mobile'],
    ['ঘড়ি', 'watch'],
    ['ঘড়ী', 'watch'],
    ['শার্ট', 'shirt'],
  ];
  let out = s;
  for (const [from, to] of map) {
    out = out.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }
  const tokens = out.split(/[^a-z0-9]+/).filter(t => t.length > 1);
  const unique = Array.from(new Set(tokens));
  return unique.join(' ').trim();
}

function expandQueryVariants(q) {
  const vars = new Set([q]);
  if (q.includes('tshirt')) { vars.add(q.replace(/tshirt/g, 't shirt')); }
  if (q.includes('watch')) { vars.add(q.replace(/watch/g, 'smartwatch')); }
  if (q.includes('earbuds')) { vars.add(q.replace(/earbuds/g, 'earbud')); }
  return Array.from(vars).filter(Boolean);
}
function getWaitMessage(toolName) {
  const suffixes = [
    'একটু অপেক্ষা করুন, দেখে জানাচ্ছি…',
    'অল্প সময় দিন, চেক করে জানাচ্ছি…',
    'দয়া করে একটু অপেক্ষা করবেন, যাচাই করছি…',
    'একটু অপেক্ষা করুন—তথ্য মিলিয়ে জানাচ্ছি…'
  ];
  const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
  switch (toolName) {
    case 'search_products':
      return `পণ্যগুলো খুঁজে দেখছি—${suffix}`;
    case 'get_product_details':
      return `পণ্যের বিস্তারিত যাচাই করছি—${suffix}`;
    case 'estimate_shipping_eta':
      return `ডেলিভারি সময় যাচাই করছি—${suffix}`;
    case 'get_current_offer':
      return `বর্তমান অফার দেখছি—${suffix}`;
    default:
      return `একটু অপেক্ষা করুন, দেখে জানাচ্ছি…`;
  }
}

function toBanglaDigits(input) {
  const map = { '0':'০','1':'১','2':'২','3':'৩','4':'৪','5':'৫','6':'৬','7':'৭','8':'৮','9':'৯','.':'।' };
  return String(input).replace(/[0-9.]/g, d => map[d] || d);
}
let sql = null;
try {
  sql = require('./persistence/sqlite');
} catch (_) {}

async function callOpenAIWithTools({ userText, history = [], onToolStart, getCustomer, summaryText }) {
  const systemPrompt = 'You are a friendly, human-like Bangla sales assistant. You can Procce Read image ,Output must be in Bangla and simple HTML (no markdown). Allowed tags: <b>, <strong>, <a href="...">, <br>, <img src="..." alt="...">. Tone: warm, concise, respectful; address the customer as “স্যার” (e.g., “জি স্যার”). Vary phrasing to avoid sounding robotic. Prefer short sentences; one idea per line; end with one focused question that moves the sale forward. Use Bengali numerals for prices. Avoid filler like “পেয়েছি/গট ইট”. When showing products, speak naturally about value/benefits before price; state availability (স্টকে আছে / স্টক আউট) clearly. Ask for budget only when it helps. Correct obvious misspellings and try a few keyword variants before concluding no results. For repeat orders, fetch saved details and show the actual values, then ask: “আগের তথ্যই ব্যবহার করবো, স্যার?”. Product names may remain in English; everything else in Bangla. No scripts or other tags.';
  const messages = [ { role: 'system', content: systemPrompt } ];
  if (summaryText) {
    messages.push({ role: 'system', content: `সংক্ষিপ্ত সারাংশ: ${summaryText}` });
  }
  // Append recent dialogue history (up to last 8 turns)
  const recent = history;
  for (const m of recent) {
    if (m.who === 'user') messages.push({ role: 'user', content: m.text });
    if (m.who === 'bot') messages.push({ role: 'assistant', content: m.text });
  }
  messages.push({ role: 'user', content: userText });
  const tools = USE_LLM_TOOLING ? [
    {
      type: 'function',
      function: {
        name: 'search_products',
        description: 'Search WooCommerce products and return concise info for recommendations',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query like watch, phone, earbuds' },
            per_page: { type: 'number', description: 'How many results to return (1-20)' },
            min_price: { type: 'number', description: 'Minimum budget in Taka' },
            max_price: { type: 'number', description: 'Maximum budget in Taka' },
            category: { type: 'string', description: 'WooCommerce category slug or id' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_categories',
        description: 'List WooCommerce product categories (optional search and limit)',
        parameters: {
          type: 'object',
          properties: { search: { type: 'string' }, per_page: { type: 'number' } },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_product_details',
        description: 'Get a single product by ID for price, stock, and image',
        parameters: {
          type: 'object',
          properties: { id: { type: 'number', description: 'WooCommerce product ID' } },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_variations',
        description: 'Fetch variations for a variable product to ask user for size/color',
        parameters: { type: 'object', properties: { product_id: { type: 'number' } }, required: ['product_id'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_current_offer',
        description: 'Get a simple current offer like free delivery or discount',
        parameters: { type: 'object', properties: {}, required: [] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'estimate_shipping_eta',
        description: 'Rough delivery ETA in Bangladesh by district',
        parameters: {
          type: 'object',
          properties: { district: { type: 'string', description: 'Customer district in Bangladesh' } },
          required: ['district']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'place_order',
        description: 'Place a WooCommerce COD order with customer details and line items',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            phone: { type: 'string' },
            address: { type: 'string' },
            district: { type: 'string' },
            upazila: { type: 'string' },
            items: { type: 'array', items: { type: 'object', properties: {
              product_id: { type: 'number' },
              variation_id: { type: 'number' },
              quantity: { type: 'number' }
            }}}
          },
          required: ['name','phone','address','district','items']
        }
      }
    }
    ,
    {
      type: 'function',
      function: {
        name: 'cancel_order',
        description: 'Cancel a WooCommerce order within 1 day of placement',
        parameters: {
          type: 'object',
          properties: { order_id: { type: 'string' } },
          required: ['order_id']
        }
      }
    }
    ,
    {
      type: 'function',
      function: {
        name: 'get_saved_customer',
        description: 'Get previously saved customer details to reuse for new orders',
        parameters: { type: 'object', properties: {}, required: [] }
      }
    }
  ] : undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.4, messages, tools, tool_choice: 'auto', max_tokens: 180 }),
    signal: controller.signal
  });
  clearTimeout(timeout);
  if (!res.ok) throw new Error(`LLM_HTTP_${res.status}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  const toolCalls = msg?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length && USE_LLM_TOOLING) {
    // Execute only the first tool call
    const call = toolCalls[0];
    if (typeof onToolStart === 'function') {
      try { onToolStart(call.function?.name || 'tool'); } catch (_) {}
    }
    if (call.type === 'function' && call.function?.name === 'search_products') {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) {}
      const rawQuery = String(args.query || '').trim();
      const normalized = normalizeSearchQuery(rawQuery);
      const variants = expandQueryVariants(normalized);
      const perPage = Math.min(20, Math.max(1, Number(args.per_page || 3)));
      const min_price = Number.isFinite(Number(args.min_price)) ? Number(args.min_price) : undefined;
      const max_price = Number.isFinite(Number(args.max_price)) ? Number(args.max_price) : undefined;
      const category = args.category != null ? String(args.category) : undefined;
      let results = [];
      if (wc && wc.isConfigured()) {
        for (const q of variants.length ? variants : [normalized || rawQuery]) {
          try {
            const batch = await wc.fetchProducts({ search: q, per_page: perPage, min_price, max_price, category });
            results = results.concat(batch);
            if (results.length >= perPage) break;
          } catch (_) {}
        }
        // Dedupe by id
        const seen = new Set();
        results = results.filter(p => (p && !seen.has(p.id) && seen.add(p.id)));
        results = results.slice(0, perPage);
      }
      const toolMessage = {
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({ ok: true, products: results })
      };
      const res2 = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.4, messages: [...messages, msg, toolMessage], max_tokens: 220 })
      });
      if (!res2.ok) throw new Error(`LLM_HTTP_${res2.status}`);
      const data2 = await res2.json();
      const finalReply = data2.choices?.[0]?.message?.content?.trim() || '';
      return { reply: finalReply, usedTool: true, toolName: 'search_products', products: results };
    }
    if (call.type === 'function' && call.function?.name === 'get_categories') {
      let args = {}; try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) {}
      let cats = [];
      if (wc && wc.isConfigured()) {
        try { cats = await wc.fetchCategories({ search: String(args.search||''), per_page: Number(args.per_page||20) }); } catch (_) { cats = []; }
      }
      const toolMessage = { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, categories: cats }) };
      const res2 = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.4, messages: [...messages, msg, toolMessage], max_tokens: 200 })
      });
      if (!res2.ok) throw new Error(`LLM_HTTP_${res2.status}`);
      const data2 = await res2.json();
      const finalReply = data2.choices?.[0]?.message?.content?.trim() || '';
      return { reply: finalReply, usedTool: true, toolName: 'get_categories' };
    }
    if (call.type === 'function' && call.function?.name === 'get_product_details') {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) {}
      const id = Number(args.id);
      let product = null;
      if (wc && wc.isConfigured() && Number.isFinite(id)) {
        try { product = await wc.fetchProductById(id); } catch (_) { product = null; }
      }
      const toolMessage = {
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({ ok: !!product, product })
      };
      const res2 = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.4, messages: [...messages, msg, toolMessage], max_tokens: 220 })
      });
      if (!res2.ok) throw new Error(`LLM_HTTP_${res2.status}`);
      const data2 = await res2.json();
      const finalReply = data2.choices?.[0]?.message?.content?.trim() || '';
      return { reply: finalReply, usedTool: true, toolName: 'get_product_details' };
    }
    if (call.type === 'function' && call.function?.name === 'get_variations') {
      let args = {}; try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) {}
      const pid = Number(args.product_id);
      let variations = [];
      if (wc && wc.isConfigured() && Number.isFinite(pid)) {
        try { variations = await wc.fetchVariations(pid); } catch (_) { variations = []; }
      }
      const toolMessage = { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, variations }) };
      const res2 = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.4, messages: [...messages, msg, toolMessage], max_tokens: 220 })
      });
      if (!res2.ok) throw new Error(`LLM_HTTP_${res2.status}`);
      const data2 = await res2.json();
      const finalReply = data2.choices?.[0]?.message?.content?.trim() || '';
      return { reply: finalReply, usedTool: true, toolName: 'get_variations' };
    }
    if (call.type === 'function' && call.function?.name === 'get_current_offer') {
      const offer = { text: 'আজ অর্ডার করলে ফ্রি ডেলিভারি।', code: 'FREE_DELIVERY', expires: null };
      const toolMessage = { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, offer }) };
      const res2 = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.4, messages: [...messages, msg, toolMessage], max_tokens: 200 })
      });
      if (!res2.ok) throw new Error(`LLM_HTTP_${res2.status}`);
      const data2 = await res2.json();
      const finalReply = data2.choices?.[0]?.message?.content?.trim() || '';
      return { reply: finalReply, usedTool: true, toolName: 'get_current_offer' };
    }
    if (call.type === 'function' && call.function?.name === 'estimate_shipping_eta') {
      let args = {}; try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) {}
      const district = String(args.district || '').toLowerCase();
      // Simple heuristic ETA
      const eta = district.includes('dhaka') || district.includes('ঢাকা') ? '১-২ দিন' : '২-৪ দিন';
      const toolMessage = { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, eta }) };
      const res2 = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.4, messages: [...messages, msg, toolMessage], max_tokens: 200 })
      });
      if (!res2.ok) throw new Error(`LLM_HTTP_${res2.status}`);
      const data2 = await res2.json();
      const finalReply = data2.choices?.[0]?.message?.content?.trim() || '';
      return { reply: finalReply, usedTool: true, toolName: 'estimate_shipping_eta' };
    }
    if (call.type === 'function' && call.function?.name === 'place_order') {
      let args = {}; try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) {}
      let placed = null; let errMsg = null; let eta = null;
      const district = String(args.district || '').toLowerCase();
      eta = (district.includes('dhaka') || String(args.district||'').includes('ঢাকা')) ? '১–২ দিন' : '২–৪ দিন';
      if (wc && wc.isConfigured()) {
        try {
          const resOrder = await wc.createOrder({
            name: String(args.name||''),
            phone: String(args.phone||''),
            address: String(args.address||''),
            district: String(args.district||''),
            upazila: String(args.upazila||''),
            items: Array.isArray(args.items) ? args.items : []
          });
          placed = { orderId: String(resOrder.number || resOrder.id), eta };
        } catch (e) {
          errMsg = String(e && e.message ? e.message : e);
        }
      } else {
        // Fallback demo order id
        placed = { orderId: String(Math.random().toString(36).slice(2,10)), eta };
      }
      const toolMessage = { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: !!placed && !errMsg, placed, error: errMsg }) };
      const res2 = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.4, messages: [...messages, msg, toolMessage], max_tokens: 240 })
      });
      if (!res2.ok) throw new Error(`LLM_HTTP_${res2.status}`);
      const data2 = await res2.json();
      const finalReply = data2.choices?.[0]?.message?.content?.trim() || '';
      return { reply: finalReply, usedTool: true, toolName: 'place_order', placed };
    }
    if (call.type === 'function' && call.function?.name === 'get_saved_customer') {
      const details = typeof getCustomer === 'function' ? (getCustomer() || null) : null;
      const toolMessage = { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: !!details, customer: details }) };
      const res2 = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.4, messages: [...messages, msg, toolMessage], max_tokens: 220 })
      });
      if (!res2.ok) throw new Error(`LLM_HTTP_${res2.status}`);
      const data2 = await res2.json();
      const finalReply = data2.choices?.[0]?.message?.content?.trim() || '';
      return { reply: finalReply, usedTool: true };
    }
    if (call.type === 'function' && call.function?.name === 'cancel_order') {
      let args = {}; try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) {}
      let cancelled = null; let errMsg = null;
      if (wc && wc.isConfigured()) {
        try {
          const resCancel = await wc.cancelOrder(String(args.order_id));
          cancelled = { orderId: String(resCancel.number || resCancel.id), status: resCancel.status };
        } catch (e) {
          errMsg = String(e && e.code ? e.code : (e && e.message ? e.message : e));
        }
      }
      const toolMessage = { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: !!cancelled && !errMsg, cancelled, error: errMsg }) };
      const res2 = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.4, messages: [...messages, msg, toolMessage], max_tokens: 240 })
      });
      if (!res2.ok) throw new Error(`LLM_HTTP_${res2.status}`);
      const data2 = await res2.json();
      const finalReply = data2.choices?.[0]?.message?.content?.trim() || '';
      return { reply: finalReply, usedTool: true, toolName: 'cancel_order', cancelled };
    }
  }
  return { reply: msg?.content?.trim() || '', usedTool: false };
}

const app = express();
app.use(cors({ origin: ORIGIN }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Static uploads directory
const UPLOAD_DIR = path.join(__dirname, 'uploads');
try { require('fs').mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}
app.use('/uploads', express.static(UPLOAD_DIR));

// File upload endpoint
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (file.originalname || '').split('.').pop() || 'bin';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'NO_FILE' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ ok: true, url });
});
// WooCommerce products API
try {
  const { fetchProducts, isConfigured } = require('./integrations/woocommerce');
  app.get('/api/products', async (req, res) => {
    try {
      if (!isConfigured()) {
        return res.status(503).json({ ok: false, error: 'WC_NOT_CONFIGURED' });
      }
      const search = String(req.query.search || '');
      const per_page = Math.min(24, Math.max(1, parseInt(String(req.query.per_page || '12'), 10)));
      const data = await fetchProducts({ search, per_page });
      res.json({ ok: true, data });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });
} catch (e) {
  // integrations optional
}

// Health endpoint
const startedAt = Date.now();
let activeSockets = 0;
app.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: Math.round((Date.now() - startedAt) / 1000), version: '1.0.0', activeSockets });
});

// Zapier webhook to ingest external chat events and persist as messages
app.post('/webhooks/zapier', async (req, res) => {
  console.log('Zapier webhook received');

  console.log('Zapier webhook received', req.body);
  
  try {
    const raw = req.body && (req.body.data ?? req.body);
    if (!raw) return res.status(400).type('text').send('MISSING_DATA');

    // Payload can be JSON string inside data, or already parsed object
    let payload;
    try {
      payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      return res.status(400).type('text').send('INVALID_JSON');
    }

    const senderPsid = String(
      payload.sender_psid || payload.psid || payload.senderId || payload.sender_id || 'anonymous'
    );
    const text = String(payload.text || payload.message || '').trim();
    const ts = payload.time ? Date.parse(payload.time) || Date.now() : Date.now();
    const locale = String(payload.locale || 'bn-BD');
    const pageId = payload.recipient_page_id ? String(payload.recipient_page_id) : undefined;

    const sessionId = `zap:${senderPsid}`;

    // Persist minimal session snapshot and user message
    if (sql) {
      try { await sql.saveSession({ sessionId, stage: 'ZAPIER', locale, lastSeenAt: Date.now(), reconnects: 0, seq: 0 }); } catch (_) {}
      try { if (text) await sql.saveMessage(sessionId, 'user', text, ts); } catch (_) {}
    }

    // If LLM disabled or missing API key, just echo
    if (!USE_LLM || !OPENAI_API_KEY) {
      return res.type('text').send('জি স্যার, কীভাবে সাহায্য করতে পারি?');
    }

    // Load history and summary for context
    let llmHistory = [];
    let summaryText = '';
    if (sql) {
      try { llmHistory = await sql.loadRecentMessages(sessionId, 30); } catch (_) {}
      try { const sumRow = await sql.loadSummary(sessionId); if (sumRow && sumRow.summary) summaryText = sumRow.summary; } catch (_) {}
    }

    // Call LLM with tools
    let result = { reply: 'জি স্যার, কীভাবে সাহায্য করতে পারি?', usedTool: false };
    try {
      result = await callOpenAIWithTools({ userText: text, history: llmHistory, summaryText, onToolStart: () => {}, getCustomer: async () => (sql ? await sql.loadCustomer(sessionId) : null) });
    } catch (e) {
      // fall back to default message
    }

    const reply = result && result.reply ? result.reply : 'জি স্যার, কীভাবে সাহায্য করতে পারি?';
    const tsBot = Date.now();
    if (sql) {
      try { await sql.saveMessage(sessionId, 'bot', reply, tsBot); } catch (_) {}
      if (summaryText) { try { await sql.saveSummary(sessionId, summaryText); } catch (_) {} }
    }

    // Build guaranteed-plain-text string: replace <br> with newlines, strip all tags, decode basic entities
    let plain = String(reply || '')
      .replace(/<br\s*\/?>(\n)?/gi, '\n')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    // Decode common HTML entities
    plain = plain
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(parseInt(d, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    if (!plain) plain = 'জি স্যার, কীভাবে সাহায্য করতে পারি?';
    return res.type('text').send(plain);
  } catch (err) {
    return res.status(500).type('text').send(String((err && err.message) || err || 'ERROR'));
  }
});

// Facebook Messenger webhook (separate from Socket chat)
try {
  const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || '';
  const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN || '';

  // Verification (GET)
  app.get('/webhooks/facebook', (req, res) => {
    console.log('Facebook webhook verification');
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  // Receive messages (POST)
  app.post('/webhooks/facebook', async (req, res) => {
    try {
      const body = req.body;
      if (body.object !== 'page') return res.sendStatus(404);
      // Respond immediately to Meta
      res.sendStatus(200);

      if (!USE_LLM || !OPENAI_API_KEY || !FB_PAGE_TOKEN) return;

      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          const senderId = event.sender && event.sender.id;
          const messageText = event.message && event.message.text;
          if (!senderId || !messageText) continue;

          // Create or reuse a pseudo-session for this PSID
          const fbSessionId = `fb:${senderId}`;
          const sess = sessions.get(fbSessionId) || {
            sessionId: fbSessionId,
            stage: 'FB',
            locale: 'bn-BD',
            lastSeenAt: Date.now(),
            reconnects: 0,
            seq: 0,
            messages: [],
            lastWaitAt: 0,
            customer: null,
            pendingOrder: null,
          };
          sessions.set(fbSessionId, sess);
          if (sql) sql.saveSession(sess);

          // Persist user message
          const tsU = Date.now();
          sess.messages.push({ who: 'user', text: messageText, ts: tsU });
          if (sql) { try { sql.saveMessage(fbSessionId, 'user', messageText, tsU); } catch (_) {} }

          // FB typing indicator helper
          const fbTyping = async (on) => {
            try {
              await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${FB_PAGE_TOKEN}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipient: { id: senderId }, sender_action: on ? 'typing_on' : 'typing_off' })
              });
            } catch (_) {}
          };

          await fbTyping(true);
          try {
            // Load recent messages for context
            let llmHistory = sess.messages;
            let summaryText = '';
            if (sql) {
              try {
                llmHistory = await sql.loadRecentMessages(fbSessionId, 30);
                const sumRow = await sql.loadSummary(fbSessionId);
                if (sumRow && sumRow.summary) summaryText = sumRow.summary;
              } catch (_) {}
            }

            const result = await callOpenAIWithTools({ userText: messageText, history: llmHistory, summaryText, onToolStart: () => {}, getCustomer: () => sess.customer });
            const reply = result.reply || 'জি স্যার, কীভাবে সাহায্য করতে পারি?';

            // Send message to FB (strip HTML for safety)
            const sendText = async (text) => {
              await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${FB_PAGE_TOKEN}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipient: { id: senderId }, message: { text } })
              });
            };

            // Small delay if no tool used
            if (!result.usedTool) {
              await sleep(Math.min(1200, Math.max(400, reply.length * 10)));
            }

            await sendText(reply.replace(/<br\s*\/?>(\n)?/gi, '\n').replace(/<[^>]+>/g, ''));

            // Save bot reply
            const tsB = Date.now();
            sess.messages.push({ who: 'bot', text: reply, ts: tsB });
            if (sql) { try { sql.saveMessage(fbSessionId, 'bot', reply, tsB); } catch (_) {} }
            if (sql && summaryText) { try { sql.saveSummary(fbSessionId, summaryText); } catch (_) {} }
          } catch (err) {
            try {
              await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${FB_PAGE_TOKEN}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipient: { id: senderId }, message: { text: 'দুঃখিত স্যার, একটু পর আবার চেষ্টা করুন।' } })
              });
            } catch (_) {}
          } finally {
            await fbTyping(false);
          }
        }
      }
    } catch (e) {
      // Swallow errors; webhook must return 200 quickly
    }
  });
} catch (_) {
  // FB webhook optional
}

// HTTP server + Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  path: '/socket.io',
  serveClient: true,
  cors: { origin: ORIGIN },
  pingInterval: 20000, // 20s heartbeat from server
  pingTimeout: 60000   // allow up to 60s before considering the connection lost
});

// Namespace for chat
const chat = io.of('/chat');

// Simple in-memory session map
const sessions = new Map();

// Heartbeat settings
const HEARTBEAT_INTERVAL_MS = 20000; // 20s
const HEARTBEAT_TIMEOUT_MS = 45000; // 45s

chat.on('connection', async (socket) => {
  activeSockets += 1;
  const sessionId = socket.handshake.auth?.sessionId || randomUUID();
  let created = !sessions.has(sessionId);
  const session = sessions.get(sessionId) || {
    sessionId,
    stage: 'WELCOME',
    locale: 'bn-BD',
    lastSeenAt: Date.now(),
    reconnects: 0,
    seq: 0,
    messages: [], // { who: 'user'|'bot', text, ts }
    lastWaitAt: 0,
    customer: null, // { name, phone, address, district, upazila, email }
    pendingOrder: null,
  };
  sessions.set(sessionId, session);
  if (sql) sql.saveSession(session);

  // If server restarted or memory lost, hydrate from SQLite so LLM has context
  if (sql && session.messages.length === 0) {
    try {
      const persisted = await sql.loadRecentMessages(sessionId, 16);
      if (persisted && persisted.length) {
        session.messages = persisted;
        created = false;
      }
      const cust = await sql.loadCustomer(sessionId);
      if (cust) session.customer = cust;
    } catch (_) {}
  }

  socket.join(sessionId);
  socket.data.sessionId = sessionId;
  if (created) {
    socket.emit('server:message', { text: 'হ্যালো! আমি আপনার সহায়ক। আজ কোন পণ্যটি খুঁজছেন?', stage: session.stage, ts: Date.now() });
  } else {
    // Replay recent history (last 10), both user and bot, after client's lastTs
    const doReplay = async () => {
      const clientLastTs = Number(socket.handshake.auth?.lastTs || 0);
      let recent = session.messages;
      if (sql) {
        try { recent = await sql.loadRecentMessages(sessionId, 100); } catch (_) {}
      }
      const toSend = recent.filter(m => !clientLastTs || !m.ts || m.ts > clientLastTs);
      if (toSend.length) {
        socket.emit('server:history', toSend.map(m => ({ who: m.who, text: m.text, ts: m.ts })));
      }
    };
    doReplay();
  }

  let lastHeartbeatAt = Date.now();
  const heartbeat = setInterval(() => {
    // Rely on Socket.IO pingInterval/pingTimeout for liveness; just emit metrics
    socket.emit('server:metrics', { sessionId, stage: session.stage, elapsedMs: Date.now() - session.lastSeenAt });
  }, HEARTBEAT_INTERVAL_MS);

  socket.on('client:message', async (payload, ack) => {
    lastHeartbeatAt = Date.now();
    session.lastSeenAt = Date.now();
    const seq = ++session.seq;
    const safeText = String(payload?.text || '').slice(0, 1000);
    logger.info({ sessionId, seq, text: safeText }, 'client:message');
    if (ack) ack({ ok: true, seq });
    // Save user message
    const uts = Date.now();
    session.messages.push({ who: 'user', text: safeText, ts: uts });
    if (sql) { try { sql.saveMessage(sessionId, 'user', safeText, uts); } catch (_) {} }
    if (sql) { try { session.lastSeenAt = uts; sql.saveSession(session); } catch (_) {} }

    // Respect cooldown if we recently hit rate limits
    try {
      if (session.coolDownUntil && Date.now() < session.coolDownUntil) {
        const waitMs = session.coolDownUntil - Date.now();
        const now = Date.now();
        if (!session.lastWaitAt || (now - session.lastWaitAt) > 5000) {
          const msg = getWaitMessage('search_products');
          session.lastWaitAt = now;
          chat.to(sessionId).emit('server:message', { text: msg, stage: session.stage, ts: now, keepTyping: true });
          session.messages.push({ who: 'bot', text: msg, ts: now });
          if (sql) { try { sql.saveMessage(sessionId, 'bot', msg, now); } catch (_) {} }
        }
        await sleep(Math.min(6000, Math.max(1200, waitMs)));
      }
    } catch (_) {}

    // Show typing immediately and keep it on until we finalize a reply
    chat.to(sessionId).emit('server:typing', { isTyping: true });
    // Generate reply via LLM; retry once and fall back gracefully
    try {
      let reply = '';
      if (USE_LLM) {
        if (!OPENAI_API_KEY) {
          chat.to(sessionId).emit('server:error', { code: 'LLM_CONFIG', message: 'LLM unavailable: set OPENAI_API_KEY on server.' });
          return;
        }
        // typing already on
        // Rely on AI to handle short messages without manual delays
        // Load recent history from SQLite to ensure continuity after refresh/restart
        let llmHistory = session.messages;
        let summaryText = '';
        if (sql) {
          try {
            llmHistory = await sql.loadRecentMessages(sessionId, 40);
            const sumRow = await sql.loadSummary(sessionId);
            if (sumRow && sumRow.summary) summaryText = sumRow.summary;
          } catch (_) {}
        } else {
          llmHistory = llmHistory.slice(-40);
        }
        let llmReply = '';
        let usedTool = false;
        let toolName;
        let placed;
        const invokeLLM = (historyToUse) => callOpenAIWithTools({ userText: safeText, history: historyToUse, summaryText, onToolStart: (toolNameParam) => {
          const now = Date.now();
          // Rate-limit the polite wait message to at most once per 5 seconds
          if (!session.lastWaitAt || (now - session.lastWaitAt) > 5000) {
            const msg = getWaitMessage(toolNameParam);
            session.lastWaitAt = now;
            chat.to(sessionId).emit('server:message', { text: msg, stage: session.stage, ts: now, keepTyping: true });
            session.messages.push({ who: 'bot', text: msg, ts: now });
            if (sql) { try { sql.saveMessage(sessionId, 'bot', msg, now); } catch (_) {} }
          }
          // typing stays on
        }, getCustomer: () => session.customer });
        try {
          // Simple per-session throttle to avoid 429 bursts
          const now = Date.now();
          const since = now - (session.lastLLMAt || 0);
          if (since < 2500) await sleep(2500 - since);
          const res1 = await invokeLLM(llmHistory);
          llmReply = res1.reply; usedTool = res1.usedTool; toolName = res1.toolName; placed = res1.placed;
          session.lastLLMAt = Date.now();
        } catch (e) {
          const msgStr = String(e && e.message ? e.message : e);
          if (msgStr.includes('LLM_HTTP_429')) {
            // First retry after short backoff with trimmed context
            await sleep(3000 + Math.floor(Math.random()*400));
            const trimmed1 = Array.isArray(llmHistory) ? llmHistory.slice(-25) : [];
            try {
              const res2 = await invokeLLM(trimmed1);
              llmReply = res2.reply; usedTool = res2.usedTool; toolName = res2.toolName; placed = res2.placed;
              session.lastLLMAt = Date.now();
            } catch (e2) {
              // Second retry with longer backoff and ultra-trimmed context
              await sleep(5000 + Math.floor(Math.random()*600));
              const trimmed2 = Array.isArray(llmHistory) ? llmHistory.slice(-12) : [];
              const res3 = await invokeLLM(trimmed2);
              llmReply = res3.reply; usedTool = res3.usedTool; toolName = res3.toolName; placed = res3.placed;
              session.lastLLMAt = Date.now();
              // Enter cooldown to avoid burst
              session.coolDownUntil = Date.now() + 10000;
            }
          } else {
            throw e;
          }
        }
        reply = llmReply;
        // When tool used, skip artificial delay
        if (usedTool) {
          const ts = Date.now();
          if (toolName === 'place_order') {
            if (placed && placed.orderId) {
              // Emit structured confirm and nice message
              const confirm = { summary: 'অর্ডার প্লেস হয়েছে ✅', eta: placed.eta || '২–৪ দিন', orderId: String(placed.orderId) };
              chat.to(sessionId).emit('server:confirm', confirm);
              const nice = `<b>ধন্যবাদ!</b> আপনার অর্ডার আইডি: <strong>${confirm.orderId}</strong><br>আনুমানিক ডেলিভারি: ${confirm.eta}. আপডেটের জন্য যোগাযোগ করতে চাইলে জানাবেন।`;
              chat.to(sessionId).emit('server:message', { text: nice, stage: session.stage, ts });
              session.messages.push({ who: 'bot', text: nice, ts });
              if (sql) { try { sql.saveMessage(sessionId, 'bot', nice, ts); } catch (_) {} }
            } else {
              const fail = 'দুঃখিত, অর্ডার সম্পন্ন করা যায়নি। একটু পরে আবার চেষ্টা করবেন, বা সাপোর্টে যোগাযোগ করুন।';
              chat.to(sessionId).emit('server:message', { text: fail, stage: session.stage, ts });
              session.messages.push({ who: 'bot', text: fail, ts });
              if (sql) { try { sql.saveMessage(sessionId, 'bot', fail, ts); } catch (_) {} }
            }
          } else {
            // Let the AI render tool results in a single human-style message
            chat.to(sessionId).emit('server:message', { text: reply || '…', stage: session.stage, ts });
            session.messages.push({ who: 'bot', text: reply || '…', ts });
            if (sql) { try { sql.saveMessage(sessionId, 'bot', reply || '…', ts); } catch (_) {} }

            // If products were searched, send images in a separate follow-up message
            if (toolName === 'search_products') {
              try {
                // Persist last shown products for quick order flow
                if (Array.isArray(res1?.products)) {
                  session.lastProducts = res1.products.map(p => ({
                    product_id: Number(p?.id),
                    name: String(p?.name || ''),
                    price: p?.price,
                    image: (p?.images && p.images[0] && p.images[0].src) || (p?.image && p.image.src) || '',
                    link: p?.permalink || p?.link || ''
                  })).filter(x => Number.isFinite(x.product_id));
                }
              } catch (_) {}

              try {
                const list = Array.isArray(res1?.products) ? res1.products : [];
                const imgs = list
                  .map(p => {
                    const src = (p?.images && p.images[0] && p.images[0].src) || (p?.image && p.image.src) || '';
                    const name = String(p?.name || 'product');
                    const safeName = name.replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]));
                    const link = p?.permalink || p?.link || '';
                    const price = (p?.price != null && p.price !== '') ? `${toBanglaDigits(p.price)} টাকা` : '';
                    if (!src) return '';
                    const imgTag = `<img src="${src}" alt="${safeName}">`;
                    const titleLine = `<b>${safeName}</b>${price ? ` — ${price}` : ''}`;
                    const block = link
                      ? `<a href="${link}" target="_blank" rel="noopener noreferrer nofollow">${imgTag}</a><br>${titleLine}`
                      : `${imgTag}<br>${titleLine}`;
                    return `${block}<br><br>`;
                  })
                  .filter(Boolean)
                  .slice(0, 8);
                if (imgs.length) {
                  const html = imgs.join('');
                  const ts2 = Date.now();
                  chat.to(sessionId).emit('server:message', { text: html, stage: session.stage, ts: ts2 });
                  session.messages.push({ who: 'bot', text: html, ts: ts2 });
                  if (sql) { try { sql.saveMessage(sessionId, 'bot', html, ts2); } catch (_) {} }
                }
              } catch (_) {}
            }
          }
          chat.to(sessionId).emit('server:typing', { isTyping: false });
          return;
        }
      }
      if (!reply) {
        reply = 'বুঝেছি। আপনি কি দৈনন্দিন ব্যবহার নাকি গিফট হিসেবে চান? 🙂';
      }
      const delay = calculateTypingDelayMs(reply);
      await sleep(delay);
      chat.to(sessionId).emit('server:typing', { isTyping: false });
      // If reply contains image URLs from product data, we may wrap as [img]URL[/img] lines
      const ts = Date.now();
      chat.to(sessionId).emit('server:message', { text: reply, stage: session.stage, ts });
      session.messages.push({ who: 'bot', text: reply, ts });
      if (sql) { try { sql.saveMessage(sessionId, 'bot', reply, ts); } catch (_) {} }
      // Opportunistically refresh summary after every bot reply (cheap single-shot)
      try {
        if (sql) {
          const brief = llmHistory.concat([{ who: 'assistant', text: reply }]).slice(-20);
          const sumPrompt = 'নিম্নে কথোপকথনের সারাংশ ২-৩টি বাক্যে লিখুন (গ্রাহকের চাহিদা, বাজেট, জেলা, আগ্রহ)।';
          const sumMessages = [ { role: 'system', content: sumPrompt } ];
          for (const m of brief) {
            if (m.who === 'user') sumMessages.push({ role: 'user', content: m.text });
            if (m.who === 'assistant' || m.who === 'bot') sumMessages.push({ role: 'assistant', content: m.text });
          }
          const resS = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({ model: OPENAI_MODEL, messages: sumMessages })
          });
          if (resS.ok) {
            const dataS = await resS.json();
            const summary = dataS.choices?.[0]?.message?.content?.trim() || '';
            if (summary) sql.saveSummary(sessionId, summary);
          }
        }
      } catch (_) {}
    } catch (err) {
      logger.warn({ err: String(err) }, 'LLM error');
      chat.to(sessionId).emit('server:typing', { isTyping: false });
      const fallback = 'দুঃখিত, একটু সমস্যা হয়েছে। বলবেন কি—আপনার বাজেট কতের মধ্যে?';
      const ts = Date.now();
      chat.to(sessionId).emit('server:message', { text: fallback, stage: session.stage, ts });
      session.messages.push({ who: 'bot', text: fallback, ts });
      if (sql) { try { sql.saveMessage(sessionId, 'bot', fallback, ts); } catch (_) {} }
    } finally {
      // Ensure typing indicator is turned off in any code path
      chat.to(sessionId).emit('server:typing', { isTyping: false });
    }
  });

  // Image analysis via LLM vision
  socket.on('client:image', async (payload, ack) => {
    const imgUrl = String(payload?.url || '').trim();
    if (!imgUrl) { if (ack) ack({ ok: false, error: 'NO_URL' }); return; }
    // Persist the user image as a message so it replays after refresh
    try {
      const its = Date.now();
      const imageMarker = `ATTACHMENT::${imgUrl}`;
      sessions.get(socket.data.sessionId)?.messages.push({ who: 'user', text: imageMarker, ts: its });
      if (sql) { try { sql.saveMessage(socket.data.sessionId, 'user', imageMarker, its); } catch (_) {} }
    } catch (_) {}
    chat.to(sessionId).emit('server:typing', { isTyping: true });
    try {
      const systemPrompt = 'You are a helpful sales assistant. Based on the image, briefly suggest possible products, categories, brands, models, colors, or styles in English product names but with the rest in Bangla. Always address the customer as “স্যার”. If uncertain, phrase it as a possibility (e.g., “It seems like…” / “It could be…”), and never say it’s impossible. Always ask 1 follow-up question. HTML is supported: <b>, <strong>, <a>, <br>, <img>.';

      // const systemPrompt = 'আপনি একটি সহায়ক বিক্রয় সহকারী। ছবির ভিত্তিতে সম্ভাব্য পণ্য/ক্যাটেগরি/ব্র্যান্ড/মডেল/রঙ/স্টাইল অনুমান করে বাংলায় সংক্ষেপে বলুন এবং ১টি ফলো-আপ প্রশ্ন করুন। অনিশ্চিত হলে সম্ভাবনা হিসেবে বলুন (যেমন “মনে হচ্ছে…/সম্ভবত…”), সরাসরি অসম্ভব বলবেন না। পণ্যের নাম ইংরেজি থাকতে পারে, বাকিটা বাংলায়। HTML সমর্থিত: <b>, <strong>, <a>, <br>, <img>. সর্বদা “স্যার” বলে সম্বোধন করুন।';
      // If URL is local (/uploads/...), convert to data: URL so OpenAI can fetch it
      let imageContent;
      try {
        if (imgUrl.startsWith('/uploads/')) {
          const filename = path.basename(imgUrl);
          const abs = path.join(UPLOAD_DIR, filename);
          const buf = fs.readFileSync(abs);
          const ext = (imgUrl.split('.').pop() || 'jpg').toLowerCase();
          const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
          const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
          imageContent = { type: 'image_url', image_url: { url: dataUrl } };
        } else if (imgUrl.startsWith('http')) {
          // Fetch remote image and convert to data URL for reliability
          try {
            logger.info({ sessionId, imgUrl }, 'vision:fetch_remote_image');
            const r = await fetch(imgUrl);
            if (!r.ok) throw new Error(`HTTP_${r.status}`);
            const ab = await r.arrayBuffer();
            const buf = Buffer.from(ab);
            let mime = r.headers.get('content-type') || '';
            if (!/^image\//i.test(mime)) {
              const ext = (imgUrl.split('.').pop() || 'jpg').toLowerCase();
              mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
            }
            const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
            imageContent = { type: 'image_url', image_url: { url: dataUrl } };
          } catch (_) {
            imageContent = { type: 'image_url', image_url: { url: imgUrl } };
          }
        } else {
          const abs = path.isAbsolute(imgUrl) ? imgUrl : path.join(__dirname, imgUrl);
          try {
            const buf = fs.readFileSync(abs);
            const ext = (imgUrl.split('.').pop() || 'jpg').toLowerCase();
            const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
            const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
            imageContent = { type: 'image_url', image_url: { url: dataUrl } };
          } catch (_) {
            imageContent = { type: 'image_url', image_url: { url: `${ORIGIN}${imgUrl}` } };
          }
        }
      } catch (_) {
        imageContent = { type: 'image_url', image_url: { url: `${ORIGIN}${imgUrl}` } };
      }
      // Prefer Responses API with base64 data URL to ensure model can access the image
      async function callResponsesOnce(dataUrl) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          logger.info({ sessionId, hasDataUrl: !!dataUrl, urlLen: (dataUrl||'').length , url: dataUrl}, 'vision:request_responses');
          const res = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({
              model: 'gpt-4o-mini',
              input: [{
                role: 'user',
                content: [
                  { type: 'input_text', text: 'ছবিটি সংক্ষেপে বিশ্লেষণ করুন এবং সম্ভাব্য পণ্য/ক্যাটেগরি/ব্র্যান্ড উল্লেখ করুন। শেষে ১টি ফলো-আপ প্রশ্ন করুন।' },
                  { type: 'input_image', image_url: (imageContent?.image_url?.url || dataUrl) }
                ]
              }],
              max_output_tokens: 300,
              temperature: 0.4
            }),
            signal: controller.signal
          });
          if (!res.ok) {
            const bodyText = await res.text().catch(() => '');
            logger.warn({ sessionId, status: res.status, body: bodyText.slice(0, 500) }, 'vision:responses_http_error');
            throw new Error(`LLM_HTTP_${res.status}`);
          }
          const json = await res.json();
          const outText = json?.output_text || (json?.output?.[0]?.content?.[0]?.text) || '';
          logger.info({ sessionId, ok: true, chars: outText.length }, 'vision:response_responses');
          return json;
        } finally {
          clearTimeout(timeout);
        }
      }

      // Build a pure data URL in case imageContent is not a data URL
      let ensuredDataUrl = imageContent?.image_url?.url;
      if (!ensuredDataUrl?.startsWith('data:')) {
        try {
          if (imgUrl.startsWith('/uploads/')) {
            const filename = path.basename(imgUrl);
            const abs = path.join(UPLOAD_DIR, filename);
            const buf = fs.readFileSync(abs);
            const ext = (imgUrl.split('.').pop() || 'jpg').toLowerCase();
            const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
            ensuredDataUrl = `data:${mime};base64,${buf.toString('base64')}`;
          }
        } catch (_) {}
      }

      let reply = '';
      try {
        const r1 = await callResponsesOnce(ensuredDataUrl);
        reply = (r1 && (r1.output_text || r1.output?.[0]?.content?.[0]?.text)) || '';
        if (!reply) throw new Error('EMPTY');
      } catch (e) {
        logger.warn({ sessionId, err: String(e && e.message ? e.message : e) }, 'vision:responses_failed');
        // Fallback to Chat Completions vision style
        const messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [ { type: 'text', text: 'ছবিটি বিশ্লেষণ করুন এবং কীওয়ার্ড দিন।' }, imageContent ] }
        ];
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          logger.info({ sessionId }, 'vision:request_chat');
          const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.4, messages, max_tokens: 220 }),
            signal: controller.signal
          });
          if (!res.ok) throw new Error(`LLM_HTTP_${res.status}`);
          const data = await res.json();
          reply = data.choices?.[0]?.message?.content?.trim() || '';
          logger.info({ sessionId, ok: true, chars: reply.length }, 'vision:response_chat');
        } finally { clearTimeout(timeout); }
      }
      if (!reply) reply = 'স্যার, ছবিটি পেয়েছি। আপনি কি নির্দিষ্ট কোনো পণ্য খুঁজছেন?';
      // Keep vision reply internal; do not show this descriptive text to the user
      const visionInternal = reply;

      // Try to derive a product search from the vision reply and image
      if (wc && wc.isConfigured()) {
        try {
          // Extract a concise search intent via LLM (JSON only)
          const extractMessages = [
            { role: 'system', content: 'Return ONLY strict JSON with fields: {"query": string, "category": string|null, "per_page": number|null}. No commentary.' },
            { role: 'user', content: `Vision reply: ${reply}\n\nGive best guess for query (e.g., \"smartwatch\", \"earbuds\", \"tshirt\"). If unsure, use a general category like \"gadget\".` }
          ];
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.2, messages: extractMessages, max_tokens: 100 })
          });
          let intent = { query: '' };
          if (r.ok) {
            const j = await r.json();
            const txt = j?.choices?.[0]?.message?.content?.trim() || '{}';
            try { intent = JSON.parse(txt); } catch (_) { intent = { query: '' }; }
          }
          const qRaw = String(intent?.query || '').trim();
          if (qRaw) {
            const query = normalizeSearchQuery(qRaw);
            const per_page = Math.min(8, Math.max(3, Number(intent?.per_page || 6)));
            logger.info({ sessionId, query, per_page }, 'vision:auto_search');
            // Polite wait message once
            const now = Date.now();
            if (!session.lastWaitAt || (now - session.lastWaitAt) > 5000) {
              const waitMsg = getWaitMessage('search_products');
              session.lastWaitAt = now;
              chat.to(sessionId).emit('server:message', { text: waitMsg, stage: session.stage, ts: now, keepTyping: true });
              session.messages.push({ who: 'bot', text: waitMsg, ts: now });
              if (sql) { try { sql.saveMessage(sessionId, 'bot', waitMsg, now); } catch (_) {} }
            }
            let products = [];
            try { products = await wc.fetchProducts({ search: query, per_page }); } catch (_) { products = []; }
            // Send a concise intro message instead of raw vision description
            try {
              const intro = `জি স্যার, মনে হচ্ছে ${query} — নীচে কিছু মিল আছে:`;
              const tsIntro = Date.now();
              chat.to(sessionId).emit('server:message', { text: intro, stage: session.stage, ts: tsIntro });
              session.messages.push({ who: 'bot', text: intro, ts: tsIntro });
              if (sql) { try { sql.saveMessage(sessionId, 'bot', intro, tsIntro); } catch (_) {} }
            } catch (_) {}
            // Persist last shown products for quick order flow
            try {
              session.lastProducts = products.map(p => ({
                product_id: Number(p?.id),
                name: String(p?.name || ''),
                price: p?.price,
                image: (p?.images && p.images[0] && p.images[0].src) || (p?.image && p.image.src) || '',
                link: p?.permalink || p?.link || ''
              })).filter(x => Number.isFinite(x.product_id));
            } catch (_) {}
            // Send images in a separate follow-up message
            const imgs = products
              .map(p => {
                const src = (p?.images && p.images[0] && p.images[0].src) || (p?.image && p.image.src) || '';
                const name = String(p?.name || 'product');
                const safeName = name.replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]));
                const link = p?.permalink || p?.link || '';
                const price = (p?.price != null && p.price !== '') ? `${toBanglaDigits(p.price)} টাকা` : '';
                if (!src) return '';
                const imgTag = `<img src="${src}" alt="${safeName}">`;
                const titleLine = `<b>${safeName}</b>${price ? ` — ${price}` : ''}`;
                const block = link
                  ? `<a href="${link}" target="_blank" rel="noopener noreferrer nofollow">${imgTag}</a><br>${titleLine}`
                  : `${imgTag}<br>${titleLine}`;
                return `${block}<br><br>`;
              })
              .filter(Boolean)
              .slice(0, 8);
            if (imgs.length) {
              const html = imgs.join('');
              const ts2 = Date.now();
              chat.to(sessionId).emit('server:message', { text: html, stage: session.stage, ts: ts2 });
              session.messages.push({ who: 'bot', text: html, ts: ts2 });
              if (sql) { try { sql.saveMessage(sessionId, 'bot', html, ts2); } catch (_) {} }
            }
            if (!imgs.length) {
              const ask = 'আপনি কোন রঙ/ডিজাইন বা বাজেট পছন্দ করবেন, স্যার? জানালে ঠিক মিলিয়ে দেখাচ্ছি।';
              const tsAsk = Date.now();
              chat.to(sessionId).emit('server:message', { text: ask, stage: session.stage, ts: tsAsk });
              session.messages.push({ who: 'bot', text: ask, ts: tsAsk });
              if (sql) { try { sql.saveMessage(sessionId, 'bot', ask, tsAsk); } catch (_) {} }
            }
          }
        } catch (e) {
          logger.warn({ sessionId, err: String(e && e.message ? e.message : e) }, 'vision:auto_search_failed');
          // If we cannot auto-search, send a short human message instead of the raw analysis
          try {
            const tsShort = Date.now();
            const shortMsg = 'ছবির ভিত্তিতে ধারণা পেলাম, স্যার। আপনি কোন দিকটা প্রাধান্য দেবেন—ডিজাইন, রঙ, নাকি বাজেট?';
            chat.to(sessionId).emit('server:message', { text: shortMsg, stage: session.stage, ts: tsShort });
            session.messages.push({ who: 'bot', text: shortMsg, ts: tsShort });
            if (sql) { try { sql.saveMessage(sessionId, 'bot', shortMsg, tsShort); } catch (_) {} }
          } catch (_) {}
        }
      }
      if (ack) ack({ ok: true });
    } catch (e) {
      // Gentle fallback
      logger.warn({ sessionId, err: String(e && e.message ? e.message : e) }, 'vision:failed');
      chat.to(sessionId).emit('server:message', { text: 'একটু নেটওয়ার্ক সমস্যা হয়েছে স্যার—দয়া করে আবার ছবিটি পাঠাবেন?', stage: session.stage, ts: Date.now() });
      if (ack) ack({ ok: false, error: 'VISION_ERROR' });
    } finally {
      chat.to(sessionId).emit('server:typing', { isTyping: false });
    }
  });

  socket.on('client:orderDetails', async (details, ack) => {
    lastHeartbeatAt = Date.now();
    logger.info({ sessionId, details }, 'client:orderDetails');
    // Validate minimal fields
    const def = session.customer || {};
    const name = String((details?.name ?? def.name) || '').trim();
    const phone = String((details?.phone ?? def.phone) || '').trim();
    const address = String((details?.address ?? def.address) || '').trim();
    const district = String((details?.district ?? def.district) || '').trim();
    const upazila = String((details?.upazila ?? def.upazila) || '').trim();
    const bdPhoneOk = /^\+?8801[3-9]\d{8}$/.test(phone) || /^01[3-9]\d{8}$/.test(phone);
    if (!name || !bdPhoneOk || !address) {
      const msg = !bdPhoneOk ? 'মোবাইল নম্বরটি সঠিক নয়। অনুগ্রহ করে BD মোবাইল নম্বর দিন (01XXXXXXXXX).' : 'নাম ও ঠিকানা প্রয়োজন।';
      chat.to(sessionId).emit('server:message', { text: msg, stage: session.stage, ts: Date.now() });
      if (ack) ack({ ok: false, error: 'VALIDATION' });
      return;
    }
    // Items: if not provided, fallback to last shown products (first one) as quick order
    let items = Array.isArray(details?.items) ? details.items : [];
    if ((!items || items.length === 0) && Array.isArray(session.lastProducts) && session.lastProducts.length) {
      items = [{ product_id: Number(session.lastProducts[0].product_id), quantity: 1 }];
    }
    if (!items || items.length === 0) {
      chat.to(sessionId).emit('server:message', { text: 'কোন পণ্যটি নিতে চান? তালিকা থেকে একটি নির্বাচন করুন বা লিংক পাঠান।', stage: session.stage, ts: Date.now() });
      if (ack) ack({ ok: false, error: 'NO_ITEMS' });
      return;
    }
    try {
      if (wc && wc.isConfigured()) {
        // If user provided shipping choice, pass it; else offer options
        let shipping = details?.shipping;
        if (!shipping) {
          try {
            const opts = await wc.listShippingOptions(district);
            const optsHtml = opts.map((o, i) => `<b>${i+1}.</b> ${o.method_title} — ফি: ${o.total} টাকা`).join('<br>');
            const ask = `শিপিং অপশন নির্বাচন করুন:<br>${optsHtml}<br>উদাহরণ: 1 লিখুন।`;
            chat.to(sessionId).emit('server:message', { text: ask, stage: session.stage, ts: Date.now() });
            if (ack) ack({ ok: false, error: 'NEED_SHIPPING', options: opts });
            return;
          } catch (_) {}
        }
        const res = await wc.createOrder({ name, phone, address, district, upazila, items, email: details?.email ?? def.email, shipping });
        const etaStr = (String(district).toLowerCase().includes('dhaka') || String(district).includes('ঢাকা')) ? '১–২ দিন' : '২–৪ দিন';
    const confirm = { summary: 'অর্ডার প্লেস হয়েছে ✅', eta: etaStr, orderId: String(res.number || res.id) };
        chat.to(sessionId).emit('server:confirm', confirm);
        const tsNow = Date.now();
        const nice = `<b>ধন্যবাদ!</b> আপনার অর্ডার আইডি: <strong>${confirm.orderId}</strong><br>আনুমানিক ডেলিভারি: ${confirm.eta}. আপডেটের জন্য যোগাযোগ করতে চাইলে জানাবেন।`;
        chat.to(sessionId).emit('server:message', { text: nice, stage: session.stage, ts: tsNow });
        session.messages.push({ who: 'bot', text: nice, ts: tsNow });
    if (sql) { try { sql.saveMessage(sessionId, 'bot', nice, tsNow); } catch (_) {} }
        // Persist customer defaults for subsequent orders
        session.customer = { name, phone, address, district, upazila, email: (details?.email ?? def.email) };
        if (sql) { try { sql.saveSession(session); sql.saveCustomer(sessionId, session.customer); } catch (_) {} }
        if (ack) ack({ ok: true, orderId: confirm.orderId, reusedCustomer: !!def.name });
      } else {
        const orderId = randomUUID().slice(0, 8);
        const etaStr = (String(district).toLowerCase().includes('dhaka') || String(district).includes('ঢাকা')) ? '১–২ দিন' : '২–৪ দিন';
        const confirm = { summary: 'অর্ডার রিসিভড ✅', eta: etaStr, orderId };
        chat.to(sessionId).emit('server:confirm', confirm);
        const tsNow = Date.now();
        const nice = `<b>ধন্যবাদ!</b> আপনার অর্ডার আইডি: <strong>${orderId}</strong><br>আনুমানিক ডেলিভারি: ${confirm.eta}. আপডেটের জন্য যোগাযোগ করতে চাইলে জানাবেন।`;
        chat.to(sessionId).emit('server:message', { text: nice, stage: session.stage, ts: tsNow });
        session.messages.push({ who: 'bot', text: nice, ts: tsNow });
    if (sql) { try { sql.saveMessage(sessionId, 'bot', nice, tsNow); } catch (_) {} }
        session.customer = { name, phone, address, district, upazila, email: (details?.email ?? def.email) };
        if (sql) { try { sql.saveSession(session); sql.saveCustomer(sessionId, session.customer); } catch (_) {} }
        if (ack) ack({ ok: true, orderId, reusedCustomer: !!def.name });
      }
    } catch (err) {
      chat.to(sessionId).emit('server:message', { text: 'দুঃখিত, অর্ডার সম্পন্ন করা যায়নি। পরে চেষ্টা করুন।', stage: session.stage, ts: Date.now() });
      if (ack) ack({ ok: false, error: 'WC_ERROR' });
    }
  });

  socket.on('disconnect', (reason) => {
    activeSockets = Math.max(0, activeSockets - 1);
    clearInterval(heartbeat);
    logger.info({ sessionId, reason }, 'socket disconnected');
  });
});

server.listen(PORT, () => {
  logger.info({ port: PORT }, 'server started');
});


