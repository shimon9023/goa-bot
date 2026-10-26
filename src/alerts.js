// התראות אוטומטיות: לא נארזה, הזמנה כפולה, הזמנה חריגה.
// רצות כל שעה, מכבדות שעות שקטות והשתקה לפי הזמנה.

import cron from 'node-cron';
import * as woo from './woo.js';
import * as db from './db.js';
import { config } from './config.js';
import { sendMessage, inlineKeyboard, button } from './telegram.js';
import { waitingFor } from './orders.js';

const TZ = 'Asia/Jerusalem';

function nowInIsrael() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

// האם אנחנו בשעות השקטות
export async function isQuietNow() {
  const settings = await db.getSettings();
  const now = nowInIsrael();
  const hour = now.getHours();
  const isShabbat = now.getDay() === 6;

  if (isShabbat && !settings.quietOnShabbat) return false;

  const { quietHoursStart: start, quietHoursEnd: end } = settings;

  // חלון שעובר חצות
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

// שליחה שמכבדת שעות שקטות: מה שמגיע בלילה מצטבר לבוקר
async function deliver(text, replyMarkup = null) {
  if (await isQuietNow()) {
    await db.queueQuietAlert(text);
    return;
  }

  const targets = config.telegram.allowedUserIds.length
    ? config.telegram.allowedUserIds
    : [config.telegram.ownerId].filter(Boolean);

  for (const chatId of targets) {
    try {
      await sendMessage(chatId, text, replyMarkup ? { reply_markup: replyMarkup } : {});
    } catch (error) {
      console.error(`שליחת התראה ל-${chatId} נכשלה:`, error.message);
    }
  }
}

function muteButton(orderId) {
  return inlineKeyboard([[button('השתק התראות להזמנה הזו', `alert:mute:${orderId}`)]]);
}

// --- הזמנה שלא נארזה ---

async function checkUnpacked() {
  const settings = await db.getSettings();
  if (!settings.alerts.unpacked) return;

  const orders = await woo.getOrders({ status: 'processing,on-hold', per_page: 50 });

  for (const order of orders) {
    if (await db.isOrderMuted(order.id)) continue;

    const hoursWaiting = (Date.now() - new Date(order.date_created).getTime()) / 3600000;
    if (hoursWaiting < settings.unpackedHours) continue;

    const last = await db.wasAlertSent(order.id, 'unpacked');

    if (last) {
      const sinceLast = (Date.now() - new Date(last.sent_at).getTime()) / 3600000;
      if (sinceLast < settings.reminderEveryHours) continue;
    }

    const name = `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim();

    await deliver(
      [
        '⏰ <b>הזמנה ממתינה לאריזה</b>',
        '',
        `#${order.number} · ${name}`,
        `ממתינה ${waitingFor(order.date_created)}`,
        `סכום: ${order.total} ₪`,
      ].join('\n'),
      muteButton(order.id)
    );

    await db.recordAlert(order.id, 'unpacked');
  }
}

// --- הזמנה כפולה ---
// אותו לקוח לפי טלפון, אימייל או כתובת, בתוך חלון הזמן שבהגדרות.

async function checkDuplicates() {
  const settings = await db.getSettings();
  if (!settings.alerts.duplicate) return;

  const since = new Date(Date.now() - settings.duplicateWindowHours * 3600000).toISOString();
  const orders = await woo.getOrders({ after: since, per_page: 100 });

  const groups = new Map();

  for (const order of orders) {
    const keys = [
      order.billing?.phone,
      order.billing?.email,
      order.shipping?.address_1,
    ].filter(Boolean).map((value) => value.trim().toLowerCase());

    for (const key of keys) {
      const list = groups.get(key) || [];
      if (!list.find((o) => o.id === order.id)) list.push(order);
      groups.set(key, list);
    }
  }

  const reported = new Set();

  for (const [, list] of groups) {
    if (list.length < 2) continue;

    const signature = list.map((o) => o.id).sort().join('-');
    if (reported.has(signature)) continue;
    reported.add(signature);

    const first = list[0];
    if (await db.isOrderMuted(first.id)) continue;
    if (await db.wasAlertSent(signature, 'duplicate')) continue;

    const name = `${first.billing?.first_name || ''} ${first.billing?.last_name || ''}`.trim();

    await deliver(
      [
        '👀 <b>יכול להיות שזו הזמנה כפולה</b>',
        '',
        `${name} ביצע ${list.length} הזמנות בתוך ${settings.duplicateWindowHours} שעות:`,
        ...list.map((o) => `#${o.number} · ${o.total} ₪`),
      ].join('\n'),
      muteButton(first.id)
    );

    await db.recordAlert(signature, 'duplicate');
  }
}

// --- הזמנה חריגה בסכום ---

async function checkLargeOrders() {
  const settings = await db.getSettings();
  if (!settings.alerts.largeOrder) return;

  const since = new Date(Date.now() - 2 * 3600000).toISOString();
  const orders = await woo.getOrders({ after: since, per_page: 50 });

  for (const order of orders) {
    if (Number(order.total) < settings.largeOrderAmount) continue;
    if (await db.isOrderMuted(order.id)) continue;
    if (await db.wasAlertSent(order.id, 'large')) continue;

    const name = `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim();

    await deliver(
      [
        '💰 <b>הזמנה חריגה בסכום</b>',
        '',
        `#${order.number} · ${name}`,
        `${order.total} ₪`,
        `${(order.line_items || []).length} פריטים`,
      ].join('\n'),
      muteButton(order.id)
    );

    await db.recordAlert(order.id, 'large');
  }
}

// --- שחרור התור של שעות השקט ---

async function flushQuietQueue() {
  if (await isQuietNow()) return;

  const queued = await db.drainQuietQueue();
  if (!queued.length) return;

  const text = [
    `<b>הצטברו ${queued.length} התראות מהלילה</b>`,
    '',
    ...queued.map((row) => row.text),
  ].join('\n\n');

  const targets = config.telegram.allowedUserIds.length
    ? config.telegram.allowedUserIds
    : [config.telegram.ownerId].filter(Boolean);

  for (const chatId of targets) {
    try {
      await sendMessage(chatId, text);
    } catch (error) {
      console.error(`שחרור התור ל-${chatId} נכשל:`, error.message);
    }
  }
}

export async function runAllChecks() {
  const checks = [
    ['לא נארזה', checkUnpacked],
    ['כפולה', checkDuplicates],
    ['חריגה', checkLargeOrders],
  ];

  for (const [name, fn] of checks) {
    try {
      await fn();
    } catch (error) {
      console.error(`בדיקת ${name} נכשלה:`, error.message);
    }
  }
}

export function startSchedulers() {
  // בדיקות כל שעה
  cron.schedule('7 * * * *', runAllChecks, { timezone: TZ });

  // שחרור מה שהצטבר בלילה, בשבע בבוקר
  cron.schedule('0 7 * * *', flushQuietQueue, { timezone: TZ });

  console.log('מתזמן ההתראות פעיל');
}
