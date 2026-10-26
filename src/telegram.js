// עטיפה דקה סביב ה-API של טלגרם. הכול עובר דרך fetch, בלי ספרייה חיצונית.

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

export function editMessageText(chatId, messageId, text, extra = {}) {
  return call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
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

// --- בניית מקלדות ---

// המקלדת הקבועה שמופיעה מתחת לשדה ההקלדה
export const mainKeyboard = {
  keyboard: [
    [{ text: 'ניהול מלאי' }, { text: 'מוצר חדש' }],
    [{ text: 'הזמנות' }, { text: 'בדיקות' }],
    [{ text: 'הגדרות' }, { text: 'התחל מההתחלה' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

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
