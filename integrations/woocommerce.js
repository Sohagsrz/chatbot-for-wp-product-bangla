const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const WC_BASE_URL = process.env.WC_BASE_URL || 'https://dhakacarts.com';
const WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY || '';
const WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET || '';
const WC_SHIPPING_METHOD_ID = process.env.WC_SHIPPING_METHOD_ID || 'flat_rate';
const WC_SHIPPING_TITLE = process.env.WC_SHIPPING_TITLE || 'Flat Rate';
const WC_SHIPPING_FEE = process.env.WC_SHIPPING_FEE || '0.00';
// Optional: auto-pick shipping by district from WC zones/methods
const WC_USE_ZONE_SHIPPING = String(process.env.WC_USE_ZONE_SHIPPING || 'true').toLowerCase() === 'true';

const CACHE_TTL_MS = 60 * 1000; // 60s
let cache = { ts: 0, key: '', data: [] };
let shippingCache = { ts: 0, zones: [], methodsByZone: {} };

function buildAuthQuery() {
  const params = new URLSearchParams();
  params.set('consumer_key', WC_CONSUMER_KEY);
  params.set('consumer_secret', WC_CONSUMER_SECRET);
  return params.toString();
}

function isConfigured() {
  return Boolean(WC_CONSUMER_KEY && WC_CONSUMER_SECRET);
}

function safeProductFields(p) {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    price: p.price,
    regular_price: p.regular_price,
    sale_price: p.sale_price,
    on_sale: p.on_sale,
    permalink: p.permalink,
    images: Array.isArray(p.images) ? p.images.slice(0, 3).map(i => ({ src: i.src, alt: i.alt })) : [],
    short_description: p.short_description,
    stock_status: p.stock_status,
    categories: Array.isArray(p.categories) ? p.categories.map(c => c.name) : [],
  };
}

async function fetchProducts({ search = '', per_page = 12, min_price, max_price, category } = {}) {
  if (!isConfigured()) {
    throw new Error('WC_NOT_CONFIGURED');
  }
  const key = `${search}|${per_page}|${min_price ?? ''}|${max_price ?? ''}|${category ?? ''}`;
  const now = Date.now();
  if (cache.key === key && now - cache.ts < CACHE_TTL_MS) {
    return cache.data;
  }
  const qs = new URLSearchParams();
  if (search) qs.set('search', search);
  qs.set('per_page', String(Math.min(50, Math.max(1, per_page))));
  qs.set('status', 'publish');
  if (category) qs.set('category', String(category));
  const auth = buildAuthQuery();
  const url = `${WC_BASE_URL.replace(/\/$/, '')}/wp-json/wc/v3/products?${qs.toString()}&${auth}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn({ status: res.status, text }, 'wc fetch products failed');
    throw new Error(`WC_HTTP_${res.status}`);
  }
  const data = await res.json();
  let mapped = Array.isArray(data) ? data.map(safeProductFields) : [];
  // Filter by price range client-side to be safe across WC versions
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : Number(String(v||'').replace(/[^0-9.]/g,''));
  };
  if (min_price != null) {
    const min = Number(min_price);
    if (Number.isFinite(min)) mapped = mapped.filter(p => toNum(p.price || p.sale_price || p.regular_price) >= min);
  }
  if (max_price != null) {
    const max = Number(max_price);
    if (Number.isFinite(max)) mapped = mapped.filter(p => toNum(p.price || p.sale_price || p.regular_price) <= max);
  }
  cache = { ts: now, key, data: mapped };
  return mapped;
}

async function fetchProductById(id) {
  if (!isConfigured()) throw new Error('WC_NOT_CONFIGURED');
  const auth = buildAuthQuery();
  const url = `${WC_BASE_URL.replace(/\/$/, '')}/wp-json/wc/v3/products/${id}?${auth}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`WC_HTTP_${res.status}`);
  const p = await res.json();
  return safeProductFields(p);
}

async function fetchCategories({ search = '', per_page = 50 } = {}) {
  if (!isConfigured()) throw new Error('WC_NOT_CONFIGURED');
  const auth = buildAuthQuery();
  const qs = new URLSearchParams();
  if (search) qs.set('search', search);
  qs.set('per_page', String(Math.min(100, Math.max(1, per_page))));
  const url = `${WC_BASE_URL.replace(/\/$/, '')}/wp-json/wc/v3/products/categories?${qs.toString()}&${auth}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WC_HTTP_${res.status}`);
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map(c => ({ id: c.id, name: c.name, slug: c.slug, count: c.count }));
}

async function fetchVariations(productId, per_page = 50) {
  if (!isConfigured()) throw new Error('WC_NOT_CONFIGURED');
  const auth = buildAuthQuery();
  const url = `${WC_BASE_URL.replace(/\/$/, '')}/wp-json/wc/v3/products/${productId}/variations?per_page=${per_page}&${auth}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`WC_HTTP_${res.status}`);
  const data = await res.json();
  // map minimal variation info for prompting
  return (Array.isArray(data) ? data : []).map(v => ({
    id: v.id,
    price: v.price,
    stock_status: v.stock_status,
    attributes: Array.isArray(v.attributes) ? v.attributes.map(a => ({ name: a.name, option: a.option })) : []
  }));
}

async function fetchShippingZones() {
  const now = Date.now();
  if (now - shippingCache.ts < 5 * 60 * 1000 && shippingCache.zones.length) return shippingCache.zones;
  const auth = buildAuthQuery();
  const url = `${WC_BASE_URL.replace(/\/$/, '')}/wp-json/wc/v3/shipping/zones?${auth}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WC_HTTP_${res.status}`);
  const zones = await res.json();
  shippingCache.zones = zones;
  shippingCache.ts = now;
  return zones;
}

async function fetchZoneMethods(zoneId) {
  if (shippingCache.methodsByZone[zoneId]) return shippingCache.methodsByZone[zoneId];
  const auth = buildAuthQuery();
  const url = `${WC_BASE_URL.replace(/\/$/, '')}/wp-json/wc/v3/shipping/zones/${zoneId}/methods?${auth}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WC_HTTP_${res.status}`);
  const methods = await res.json();
  shippingCache.methodsByZone[zoneId] = methods;
  return methods;
}

async function chooseShippingForDistrict(district) {
  if (!WC_USE_ZONE_SHIPPING) return { method_id: WC_SHIPPING_METHOD_ID, method_title: WC_SHIPPING_TITLE, total: WC_SHIPPING_FEE };
  try {
    const zones = await fetchShippingZones();
    // Heuristic: single zone (Bangladesh) with multiple flat_rate instances titled in Bangla
    const zone = zones?.[0];
    if (!zone) return { method_id: WC_SHIPPING_METHOD_ID, method_title: WC_SHIPPING_TITLE, total: WC_SHIPPING_FEE };
    const methods = await fetchZoneMethods(zone.id);
    const d = String(district || '').toLowerCase();
    // Match titles by contains
    let preferred;
    for (const m of methods) {
      const title = (m.settings?.title?.value || m.title || '').toLowerCase();
      if (d.includes('ঢাকা') && (title.includes('ঢাকা ভেতর') || title.includes('dhaka') && title.includes('inside'))) { preferred = m; break; }
      if (d && !d.includes('ঢাকা') && (title.includes('ঢাকার বাইরে') || title.includes('outside'))) preferred = m;
    }
    const m = preferred || methods.find(x => x.method_id === 'flat_rate') || methods[0];
    const total = (m?.settings?.cost?.value ?? m?.settings?.cost ?? '0').toString();
    const method_title = (m?.settings?.title?.value || m?.title || WC_SHIPPING_TITLE).toString();
    const method_id = (m?.method_id || WC_SHIPPING_METHOD_ID).toString();
    return { method_id, method_title, total: total || '0.00' };
  } catch (e) {
    logger.warn({ err: String(e) }, 'chooseShippingForDistrict failed, using defaults');
    return { method_id: WC_SHIPPING_METHOD_ID, method_title: WC_SHIPPING_TITLE, total: WC_SHIPPING_FEE };
  }
}

async function listShippingOptions(district) {
  try {
    const zones = await fetchShippingZones();
    const zone = zones?.[0];
    if (!zone) return [{ method_id: WC_SHIPPING_METHOD_ID, method_title: WC_SHIPPING_TITLE, total: WC_SHIPPING_FEE }];
    const methods = await fetchZoneMethods(zone.id);
    return methods.map(m => ({
      method_id: String(m.method_id || 'flat_rate'),
      method_title: String(m.settings?.title?.value || m.title || 'Shipping'),
      total: String(m.settings?.cost?.value ?? m.settings?.cost ?? '0.00')
    }));
  } catch (e) {
    logger.warn({ err: String(e) }, 'listShippingOptions failed');
    return [{ method_id: WC_SHIPPING_METHOD_ID, method_title: WC_SHIPPING_TITLE, total: WC_SHIPPING_FEE }];
  }
}

async function createOrder({ name, phone, address, district, upazila, items, email, postcode, shipping }) {
  if (!isConfigured()) throw new Error('WC_NOT_CONFIGURED');
  const sanitizedItems = Array.isArray(items) ? items
    .map(i => ({ product_id: Number(i.product_id), variation_id: i.variation_id ? Number(i.variation_id) : undefined, quantity: Math.max(1, Number(i.quantity || 1)) }))
    .filter(i => Number.isFinite(i.product_id) && i.product_id > 0) : [];
  if (!sanitizedItems.length) {
    const err = new Error('NO_ITEMS');
    err.code = 'NO_ITEMS';
    throw err;
  }
  const auth = buildAuthQuery();
  const url = `${WC_BASE_URL.replace(/\/$/, '')}/wp-json/wc/v3/orders?${auth}`;
  const [first_name, ...rest] = String(name || '').trim().split(/\s+/);
  const last_name = rest.join(' ');
  const payload = {
    payment_method: 'cod',
    payment_method_title: 'Cash on Delivery',
    set_paid: false,
    billing: {
      first_name,
      last_name,
      address_1: String(address || ''),
      city: String(district || ''),
      state: String(upazila || ''),
      country: 'BD',
      email: String(email || ''),
      phone: String(phone || ''),
      postcode: String(postcode || '')
    },
    shipping: {
      first_name,
      last_name,
      address_1: String(address || ''),
      city: String(district || ''),
      state: String(upazila || ''),
      country: 'BD',
      postcode: String(postcode || '')
    },
    line_items: sanitizedItems
  };
  // Drop invalid email to satisfy WC REST validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!payload.billing.email || !emailRegex.test(payload.billing.email)) {
    delete payload.billing.email;
  }
  // Attach shipping lines if configured
  const chosen = shipping && shipping.method_id ? shipping : await chooseShippingForDistrict(district);
  payload.shipping_lines = [ { method_id: String(chosen.method_id), method_title: String(chosen.method_title), total: String(chosen.total) } ];
  // Remove undefined variation_id fields
  payload.line_items = payload.line_items.map(li => {
    if (!li.variation_id) delete li.variation_id;
    return li;
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn({ status: res.status, text }, 'wc create order failed');
    throw new Error(`WC_HTTP_${res.status}`);
  }
  const data = await res.json();
  return { id: data.id, number: data.number, status: data.status };
}

async function getOrder(orderId) {
  if (!isConfigured()) throw new Error('WC_NOT_CONFIGURED');
  const auth = buildAuthQuery();
  const url = `${WC_BASE_URL.replace(/\/$/, '')}/wp-json/wc/v3/orders/${orderId}?${auth}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`WC_HTTP_${res.status}`);
  return await res.json();
}

async function cancelOrder(orderId) {
  if (!isConfigured()) throw new Error('WC_NOT_CONFIGURED');
  const order = await getOrder(orderId);
  const createdAt = Date.parse(order.date_created_gmt || order.date_created);
  const withinOneDay = isFinite(createdAt) && (Date.now() - createdAt) <= 24*60*60*1000;
  if (!withinOneDay) {
    const err = new Error('CANCEL_WINDOW_EXCEEDED');
    err.code = 'CANCEL_WINDOW_EXCEEDED';
    throw err;
  }
  const auth = buildAuthQuery();
  const url = `${WC_BASE_URL.replace(/\/$/, '')}/wp-json/wc/v3/orders/${orderId}?${auth}`;
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }) });
  if (!res.ok) throw new Error(`WC_HTTP_${res.status}`);
  const data = await res.json();
  return { id: data.id, number: data.number, status: data.status };
}

module.exports = { fetchProducts, fetchProductById, fetchCategories, fetchVariations, createOrder, getOrder, cancelOrder, isConfigured };


