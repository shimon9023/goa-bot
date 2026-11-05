// הגדרות: ספים, שעות שקטות, מתחרים, משתמשים ותקרת הוצאה.

import * as db from './db.js';
import * as ai from './ai.js';
import * as competitors from './competitors.js';
import { supabase } from './db.js';
import { sendMessage, inlineKeyboard, button, mainKeyboard } from './telegram.js';

const LABELS = {
  unpackedHours: 'שעות עד התראה על הזמנה שלא נארזה',
  reminderEveryHours: 'כל כמה שעות לחזור ולהזכיר',
  duplicateWindowHours: 'חלון הזמן להזמנה כפולה',
  largeOrderAmount: 'סכום שנחשב הזמנה חריגה',
  monthlyCapUsd: 'תקרת הוצאה חודשית ל-AI, בדולר',
};

const ALERT_LABELS = {
  unpacked: 'הזמנה שלא נארזה',
  duplicate: 'הזמנה כפולה',
  largeOrder: 'הזמנה חריגה',
  failedPayments: 'ניסיונות תשלום כושלים',
};

export async function showMenu(chatId) {
  const settings = await db.getSettings();
  const spent = await ai.monthlySpend();

  const lines = [
    '<b>הגדרות</b>',
    '',
    `לא נארזה: ${settings.unpackedHours} שעות`,
    `תזכורת: כל ${settings.reminderEveryHours} שעות`,
    `הזמנה כפולה: ${settings.duplicateWindowHours} שעות`,
    `הזמנה חריגה: ${settings.largeOrderAmount} ₪`,
    `שעות שקטות: ${settings.quietHoursStart}:00 עד ${settings.quietHoursEnd}:00`,
    '',
    `הוצאת AI החודש: ${spent.toFixed(2)} דולר${settings.monthlyCapUsd ? ` מתוך ${settings.monthlyCapUsd}` : ''}`,
  ];

  await sendMessage(chatId, lines.join('\n'), {
    reply_markup: inlineKeyboard([
      [button('שנה ספים', 'set:thresholds')],
      [button('התראות', 'set:alerts')],
      [button('מתחרים', 'set:competitors')],
      [button('משתמשים', 'set:users')],
      [button('חיבור לגוגל', 'goog:status')],
      [button('יומן פעולות', 'set:log')],
      [button('בטל פעולה אחרונה', 'set:undo')],
    ]),
  });
}

// מסך מצומצם למי שקיבל הרשאת התראות בלבד.
// רק ספים והדלקה או כיבוי של התראות. בלי משתמשים, בלי חיבורים, בלי יומן.
export async function showAlertsOnly(chatId) {
  const settings = await db.getSettings();

  await sendMessage(
    chatId,
    [
      '<b>הגדרות התראות</b>',
      '',
      `לא נארזה: ${settings.unpackedHours} שעות`,
      `תזכורת: כל ${settings.reminderEveryHours} שעות`,
      `הזמנה כפולה: ${settings.duplicateWindowHours} שעות`,
      `הזמנה חריגה: ${settings.largeOrderAmount} ₪`,
      `שעות שקטות: ${settings.quietHoursStart}:00 עד ${settings.quietHoursEnd}:00`,
    ].join('\n'),
    {
      reply_markup: inlineKeyboard([
        [button('שנה ספים', 'set:thresholds')],
        [button('אילו התראות פעילות', 'set:alerts')],
      ]),
    }
  );
}

// --- ספים ---

export async function showThresholds(chatId) {
  const settings = await db.getSettings();

  const rows = Object.entries(LABELS).map(([key, label]) => [
    button(`${label}: ${settings[key] ?? 'לא מוגדר'}`, `set:edit:${key}`),
  ]);

  await sendMessage(chatId, 'מה לשנות?', { reply_markup: inlineKeyboard(rows) });
}

export async function promptForValue(chatId, userId, key) {
  await db.setState(userId, { module: 'settings', awaiting: 'value', key });
  await sendMessage(chatId, `${LABELS[key]}?\nכתוב מספר.`);
}

export async function saveValue(chatId, userId, key, text) {
  const value = Number(String(text).replace(/[^\d.]/g, ''));

  if (!value || Number.isNaN(value)) {
    await sendMessage(chatId, 'לא הבנתי את המספר. נסה שוב.');
    return;
  }

  await db.updateSettings({ [key]: value });
  await db.clearState(userId);

  await sendMessage(chatId, `${LABELS[key]} עודכן ל-${value}.`);
}

// --- הפעלה וכיבוי של התראות ---

export async function showAlertToggles(chatId) {
  const settings = await db.getSettings();

  const rows = Object.entries(ALERT_LABELS).map(([key, label]) => [
    button(`${settings.alerts[key] ? '🟢' : '🔴'} ${label}`, `set:toggle:${key}`),
  ]);

  await sendMessage(chatId, 'אילו התראות פעילות?', { reply_markup: inlineKeyboard(rows) });
}

export async function toggleAlert(chatId, key) {
  const settings = await db.getSettings();
  const alerts = { ...settings.alerts, [key]: !settings.alerts[key] };

  await db.updateSettings({ alerts });
  await showAlertToggles(chatId);
}

// --- מתחרים ---

export async function showCompetitors(chatId) {
  const list = await competitors.listCompetitors();

  if (!list.length) {
    await sendMessage(chatId, 'אין מתחרים מוגדרים.', {
      reply_markup: inlineKeyboard([[button('הוסף מתחרה', 'set:addcomp')]]),
    });
    return;
  }

  const lines = ['<b>מתחרים</b>', ''];
  const rows = [];

  for (const competitor of list) {
    lines.push(`${competitor.name} · ${(competitor.categories || []).join(', ') || 'כל הקטגוריות'}`);
    rows.push([button(`הסר ${competitor.name}`, `set:rmcomp:${competitor.id}`)]);
  }

  rows.push([button('הוסף מתחרה', 'set:addcomp')]);

  await sendMessage(chatId, lines.join('\n'), { reply_markup: inlineKeyboard(rows) });
}

export async function promptForCompetitor(chatId, userId) {
  await db.setState(userId, { module: 'settings', awaiting: 'competitor' });

  await sendMessage(
    chatId,
    [
      'שלח בשורה אחת: שם, כתובת האתר, וקטגוריות מופרדות בפסיק.',
      '',
      'לדוגמה:',
      '<code>סמוקר, https://smoker.co.il, נרגילות, גחלים</code>',
    ].join('\n')
  );
}

export async function saveCompetitor(chatId, userId, text) {
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);

  if (parts.length < 2) {
    await sendMessage(chatId, 'צריך לפחות שם וכתובת. נסה שוב.');
    return;
  }

  const [name, siteUrl, ...categories] = parts;

  await competitors.addCompetitor({ name, siteUrl, categories });
  await db.clearState(userId);

  await sendMessage(chatId, `${name} נוסף לרשימת המתחרים.`);
}

// --- משתמשים ---
// הניהול עבר ל-access.js: משתמש חדש פותח את הבוט, ושמעון מאשר אותו
// בכפתור. אין יותר הוספה ידנית עם מזהים ואזורים.

// --- יומן וביטול ---

export async function showLog(chatId) {
  const actions = await db.getRecentActions(15);

  if (!actions.length) {
    await sendMessage(chatId, 'היומן ריק.');
    return;
  }

  const lines = ['<b>יומן פעולות</b>', ''];

  for (const action of actions) {
    const when = new Date(action.created_at).toLocaleString('he-IL', {
      timeZone: 'Asia/Jerusalem',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    const undone = action.undone ? ' (בוטל)' : '';
    lines.push(`${when} · ${action.action} · ${action.target || ''}${undone}`);
  }

  await sendMessage(chatId, lines.join('\n'));
}

export async function undoLast(chatId, userId) {
  const action = await db.getLastAction(userId);

  if (!action) {
    await sendMessage(chatId, 'אין פעולה לבטל.');
    return;
  }

  if (action.action !== 'stock_update') {
    await sendMessage(
      chatId,
      `הפעולה האחרונה היא "${action.action}", ואותה אני לא יודע לבטל אוטומטית.\nאפשר לבטל רק עדכוני מלאי.`
    );
    return;
  }

  const woo = await import('./woo.js');
  const before = action.before_value || {};
  const [productId, variationId] = String(action.target).split(':').map(Number);

  const fields = {
    stock_status: before.stock_status,
    stock_quantity: before.stock_quantity,
    manage_stock: before.manage_stock,
  };

  if (variationId) await woo.updateVariation(productId, variationId, fields);
  else await woo.updateProduct(productId, fields);

  await db.markUndone(action.id);

  await sendMessage(chatId, 'הפעולה בוטלה והמלאי הוחזר למה שהיה.');
}
