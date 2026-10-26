// מודול הזמנות: רשימת ממתינות לאריזה, מסך הליקוט וסגירת הזמנה.

import * as woo from './woo.js';
import * as db from './db.js';
import { config } from './config.js';
import {
  sendMessage,
  inlineKeyboard,
  button,
  webAppButton,
  mainKeyboard,
} from './telegram.js';

const PENDING_STATUSES = 'processing,on-hold';

// כמה זמן ההזמנה כבר ממתינה, בשפה אנושית
export function waitingFor(dateCreated) {
  const created = new Date(dateCreated);
  const hours = Math.floor((Date.now() - created.getTime()) / 3600000);

  if (hours < 1) return 'פחות משעה';
  if (hours < 24) return `${hours} שעות`;

  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} ימים ו-${rest} שעות` : `${days} ימים`;
}

export function shippingTitle(order) {
  const line = (order.shipping_lines || [])[0];
  return line?.method_title || 'ללא משלוח';
}

export async function showPendingOrders(chatId) {
  const orders = await woo.getOrders({ status: PENDING_STATUSES, per_page: 30 });

  if (!orders.length) {
    await sendMessage(chatId, 'אין הזמנות שממתינות לאריזה. הכול נקי.', {
      reply_markup: mainKeyboard,
    });
    return;
  }

  const lines = [`<b>ממתינות לאריזה: ${orders.length}</b>`, ''];
  const rows = [];

  for (const order of orders) {
    lines.push(
      `#${order.number} · ${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim()
    );
    lines.push(`ממתינה ${waitingFor(order.date_created)} · ${shippingTitle(order)}`);
    lines.push('');

    const pickingUrl = `${config.publicBaseUrl}/picking/${order.id}?u=${chatId}`;

    rows.push([webAppButton(`#${order.number} · ליקוט`, pickingUrl)]);
  }

  await sendMessage(chatId, lines.join('\n').trim(), {
    reply_markup: inlineKeyboard(rows),
  });
}

// המידע שמסך הליקוט מקבל
export async function buildPickingPayload(orderId) {
  const order = await woo.getOrder(orderId);

  const items = [];

  for (const item of order.line_items || []) {
    let imageUrl = null;

    try {
      const product = await woo.getProduct(item.product_id);
      imageUrl = product.images?.[0]?.src || null;
    } catch {
      imageUrl = null;
    }

    items.push({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      sku: item.sku || '',
      image: imageUrl,
    });
  }

  const shipping = order.shipping || {};

  return {
    id: order.id,
    number: order.number,
    shippingMethod: shippingTitle(order),
    waitingFor: waitingFor(order.date_created),
    customer: {
      name: `${shipping.first_name || order.billing?.first_name || ''} ${
        shipping.last_name || order.billing?.last_name || ''
      }`.trim(),
      phone: order.billing?.phone || '',
      address: [shipping.address_1, shipping.address_2, shipping.city]
        .filter(Boolean)
        .join(', '),
    },
    note: order.customer_note || '',
    total: order.total,
    items,
  };
}

// סגירת הזמנה: משנה סטטוס בווקומרס ותו לא.
// החיבור הקיים של Shipnest הוא זה שמעביר הלאה את מה שצריך.
export async function completeOrder(orderId, userId) {
  const before = await woo.getOrder(orderId);

  await woo.updateOrderStatus(orderId, 'completed');

  await db.logAction({
    userId,
    action: 'order_completed',
    target: String(orderId),
    before: { status: before.status },
    after: { status: 'completed' },
  });

  return before.number;
}
