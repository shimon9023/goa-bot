// כרטיס מתעדכן.
//
// במקום להציף את הצ'אט בהודעות סטטוס — "מתמלל", "שמעתי", "עובד על זה" —
// הבוט מחזיק הודעה אחת ומעדכן אותה. פחות גלילה, יותר ברור איפה עומדים.
//
// המגבלה: אם שמעון שלח הודעה אחרי הכרטיס, הכרטיס כבר לא למטה,
// ועריכה שלו תיעלם מעיניו. במצב כזה שולחים כרטיס חדש.
// מזהי ההודעות בטלגרם עולים, אז אפשר להשוות ולדעת מי אחרון.

import * as db from './db.js';
import { sendMessage, editMessageText } from './telegram.js';

// נקרא על כל הודעה נכנסת, כדי לדעת מתי שמעון דיבר אחרון
export async function noteUserMessage(userId, messageId) {
  const state = (await db.getState(userId)) || {};

  if ((state.lastUserMsgId || 0) >= messageId) return;

  await db.setState(userId, { ...state, lastUserMsgId: messageId });
}

function canEdit(state) {
  if (!state?.cardId) return false;
  // הכרטיס נערך רק כשהוא ההודעה האחרונה בצ'אט
  return state.cardId > (state.lastUserMsgId || 0);
}

// מציג טקסט בכרטיס. מעדכן אם אפשר, אחרת שולח חדש.
export async function show(chatId, userId, text, extra = {}) {
  const state = (await db.getState(userId)) || {};

  if (canEdit(state)) {
    try {
      await editMessageText(chatId, state.cardId, text, extra);
      await db.setState(userId, { ...state, cardText: text });
      return state.cardId;
    } catch (error) {
      console.error('עדכון הכרטיס נכשל, שולח חדש:', error.message);
    }
  }

  const sent = await sendMessage(chatId, text, extra);
  await db.setState(userId, { ...state, cardId: sent.message_id, cardText: text });

  return sent.message_id;
}

// מנתק את הכרטיס, כך שההודעה הבאה תהיה חדשה.
// משמש כשמה שמוצג הוא תוצאה שצריכה להישאר בצ'אט.
export async function release(userId) {
  const state = (await db.getState(userId)) || {};
  if (!state.cardId) return;

  await db.setState(userId, { ...state, cardId: null, cardText: '' });
}
