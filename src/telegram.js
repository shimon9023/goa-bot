// עטיפה דקה סביב ה-API של טלגרם. הכול עובר דרך fetch, בלי ספרייה חיצונית.

import { createHmac } from 'node:crypto';

import { config } from './config.js';

const API = `https://api.telegram.org/bot${config.telegram.token}`;

async function call(method, payload) {
  const response = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));

  if (!data.ok) {
    const reason = data.description || `HTTP ${response.status}`;
    throw new Error(`Telegram ${method} failed: ${reason}`);
  }

  return data.result;
}

export function sendMessage(chatId, text, extra = {}) {
  return call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

export async function editMessageText(chatId, messageId, text, extra = {}) {
  try {
    return await call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (error) {
    // טלגרם מתלונן כשמעדכנים הודעה לאותו תוכן בדיוק.
    // זה לא כישלון, פשוט אין מה לשנות.
    if (error.message.includes('message is not modified')) return null;
    throw error;
  }
}

export function answerCallbackQuery(callbackQueryId, text = '') {
  return call('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
  });
}

export function sendPhoto(chatId, photoUrl, caption = '', extra = {}) {
  return call('sendPhoto', {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: 'HTML',
    ...extra,
  });
}

// גלריית תמונות בהודעה אחת, במקום הודעה לכל תמונה
export function sendMediaGroup(chatId, photoUrls, caption = '') {
  const media = photoUrls.slice(0, 10).map((url, index) => ({
    type: 'photo',
    media: url,
    ...(index === 0 && caption ? { caption, parse_mode: 'HTML' } : {}),
  }));

  return call('sendMediaGroup', { chat_id: chatId, media });
}

export function getFile(fileId) {
  return call('getFile', { file_id: fileId });
}

export function fileUrl(filePath) {
  return `https://api.telegram.org/file/bot${config.telegram.token}/${filePath}`;
}

export function getWebhookInfo() {
  return call('getWebhookInfo', {});
}

export function setWebhook(url, { dropPending = false } = {}) {
  return call('setWebhook', {
    url,
    secret_token: config.telegram.webhookSecret,
    allowed_updates: ['message', 'callback_query'],
    // בתוכנית החינמית השרת נרדם, וההודעה שמעירה אותו ממתינה בתור.
    // מחיקת התור בעלייה הייתה מוחקת בדיוק אותה, אז כברירת מחדל לא מוחקים.
    drop_pending_updates: dropPending,
  });
}

// --- אימות מיני אפליקציה ---
// טלגרם חותם את הנתונים שהוא מעביר למיני אפליקציה. בלי הבדיקה הזו
// כל אחד שיודע את הכתובת יכול לקרוא לנתיבים שלה.

export function verifyInitData(initData) {
  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');

  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(config.telegram.token).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest('hex');

  if (expected !== hash) return null;

  // חתימה ישנה מדי היא חשודה
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 24 * 60 * 60) return null;

  try {
    return JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
}

// --- בניית מקלדות ---

// המקלדת הקבועה שמופיעה מתחת לשדה ההקלדה.
// נבנית לפי ההרשאות, כך שכל אחד רואה רק את מה שמותר לו.
export function keyboardFor(buttons, { settings = false } = {}) {
  const rows = [];

  // שניים בשורה, חוץ מכפתור ארוך שמקבל שורה לעצמו
  let pending = null;

  for (const text of buttons) {
    if (text.length > 14) {
      if (pending) { rows.push([{ text: pending }]); pending = null; }
      rows.push([{ text }]);
      continue;
    }

    if (pending) { rows.push([{ text: pending }, { text }]); pending = null; }
    else pending = text;
  }

  if (pending) rows.push([{ text: pending }]);

  const last = [];
  if (settings) last.push({ text: 'הגדרות' });
  last.push({ text: 'התחל מההתחלה' });
  rows.push(last);

  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

// המקלדת של הבעלים. נשארת כברירת מחדל במקומות שלא מכירים את ההרשאות.
export const mainKeyboard = keyboardFor(
  ['ניהול מלאי', 'מוצר חדש', 'הזמנות', 'בדיקות', 'הוספה לרשימת העלאה'],
  { settings: true }
);

// כפתורים מתחת להודעה מסוימת
export function inlineKeyboard(rows) {
  return { inline_keyboard: rows };
}

export function button(text, data) {
  return { text, callback_data: data };
}

export function webAppButton(text, url) {
  return { text, web_app: { url } };
}
