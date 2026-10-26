// חיבור ל-WooCommerce דרך ה-REST API, עם המפתחות שנוצרו באתר.

import { config } from './config.js';

const BASE = `${config.woo.siteUrl}/wp-json/wc/v3`;

const AUTH =
  'Basic ' +
  Buffer.from(`${config.woo.consumerKey}:${config.woo.consumerSecret}`).toString('base64');

async function request(path, { method = 'GET', query = {}, body } = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: AUTH,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`ווקומרס החזיר תשובה לא תקינה (${response.status})`);
  }

  if (!response.ok) {
    const message = data?.message || `HTTP ${response.status}`;
    throw new Error(`ווקומרס: ${message}`);
  }

  return data;
}

// --- מוצרים ---

export function searchProducts(term, limit = 10) {
  return request('/products', {
    query: { search: term, per_page: limit, status: 'any', orderby: 'relevance' },
  });
}

export function getProduct(id) {
  return request(`/products/${id}`);
}

export function getVariations(productId) {
  return request(`/products/${productId}/variations`, { query: { per_page: 100 } });
}

export function updateProduct(id, fields) {
  return request(`/products/${id}`, { method: 'PUT', body: fields });
}

export function createProduct(fields) {
  return request('/products', { method: 'POST', body: fields });
}

export function createVariation(productId, fields) {
  return request(`/products/${productId}/variations`, { method: 'POST', body: fields });
}

export function updateVariation(productId, variationId, fields) {
  return request(`/products/${productId}/variations/${variationId}`, {
    method: 'PUT',
    body: fields,
  });
}

// סימון במלאי או אזל, עם או בלי ניהול כמות
export function setStock(product, { inStock, quantity, manage }) {
  const fields = {};

  if (manage !== undefined) fields.manage_stock = manage;

  if (quantity !== undefined && quantity !== null) {
    fields.manage_stock = true;
    fields.stock_quantity = quantity;
    fields.stock_status = quantity > 0 ? 'instock' : 'outofstock';
  } else if (inStock !== undefined) {
    fields.stock_status = inStock ? 'instock' : 'outofstock';
  }

  return product.variationOf
    ? updateVariation(product.variationOf, product.id, fields)
    : updateProduct(product.id, fields);
}

// --- הזמנות ---

export function getOrders(query = {}) {
  return request('/orders', { query: { per_page: 50, ...query } });
}

export function getOrder(id) {
  return request(`/orders/${id}`);
}

export function updateOrderStatus(id, status) {
  return request(`/orders/${id}`, { method: 'PUT', body: { status } });
}

export function addOrderNote(id, note) {
  return request(`/orders/${id}/notes`, {
    method: 'POST',
    body: { note, customer_note: false },
  });
}

// --- קטגוריות ותגיות, לשימוש מודול המוצר החדש ---

export function getCategories() {
  return request('/products/categories', { query: { per_page: 100 } });
}

export function getTags() {
  return request('/products/tags', { query: { per_page: 100 } });
}

// --- מדיה ומטא, דרך ה-API של וורדפרס ---
// הנתיב אחר מזה של ווקומרס, אבל אותם מפתחות עובדים.

const WP_BASE = `${config.woo.siteUrl}/wp-json/wp/v2`;

export async function uploadMedia(buffer, mimeType, title = 'product') {
  const extension = mimeType.includes('png') ? 'png' : 'jpg';
  const safeName = title.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60) || 'product';

  const response = await fetch(`${WP_BASE}/media`, {
    method: 'POST',
    headers: {
      Authorization: AUTH,
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${safeName}.${extension}"`,
    },
    body: buffer,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`העלאת התמונה נכשלה: ${data?.message || response.status}`);
  }

  return data;
}

// Yoast נכתב כ-meta על המוצר. עבור מוצרים זה עובד דרך הקונקטור.
export function setYoastMeta(productId, metaTitle, metaDescription) {
  const meta = {};
  if (metaTitle) meta._yoast_wpseo_title = metaTitle;
  if (metaDescription) meta._yoast_wpseo_metadesc = metaDescription;

  return fetch(`${WP_BASE}/product/${productId}`, {
    method: 'POST',
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ meta }),
  }).then(async (response) => {
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data?.message || `HTTP ${response.status}`);
    }
    return response.json();
  });
}

// --- דוחות ---

// מוצרים שנמכרו בתקופה נתונה, לבדיקת "נמכרו ואזלו"
export async function getSoldProducts(afterIso) {
  const sold = new Map();
  let page = 1;

  while (page <= 10) {
    const orders = await getOrders({
      after: afterIso,
      status: 'completed,processing',
      per_page: 100,
      page,
    });

    if (!orders.length) break;

    for (const order of orders) {
      for (const item of order.line_items || []) {
        const key = item.variation_id || item.product_id;
        const current = sold.get(key) || { id: key, name: item.name, quantity: 0 };
        current.quantity += item.quantity;
        sold.set(key, current);
      }
    }

    if (orders.length < 100) break;
    page += 1;
  }

  return [...sold.values()];
}
