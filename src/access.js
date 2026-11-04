// מי מורשה להשתמש בבוט, ומה מותר לו.
//
// שמעון והמשתמשים שברשימת השרת הם בעלים: הם רואים הכול.
// עובד מחסן רואה רק את קליטת המוצרים.
// מי שלא מוכר מגיע לשמעון לאישור, ועד שהוא מאשר הבוט לא עונה לו.

import { config } from './config.js';
import * as db from './db.js';
import * as warehouse from './warehouse.js';
import { sendMessage, inlineKeyboard, button } from './telegram.js';

export const ROLE = {
  owner: 'owner',
  warehouse: 'warehouse',
};

export function isOwner(userId) {
  const list = config.telegram.allowedUserIds;
  if (!list.length) return String(userId) === String(config.telegram.ownerId);
  return list.includes(String(userId));
}

export async function roleOf(userId) {
  if (isOwner(userId)) return ROLE.owner;

  const user = await db.getUser(userId);
  const areas = user?.areas || [];

  if (areas.includes(ROLE.warehouse)) return ROLE.warehouse;

  return null;
}

export function displayName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || (user.username ? `@${user.username}` : `משתמש ${user.id}`);
}

// --- בקשת גישה ---

export async function handleStranger(chatId, user) {
  const existing = await db.getUser(user.id);
  const areas = existing?.areas || [];

  if (areas.includes('rejected')) return;

  if (areas.includes('pending')) {
    await sendMessage(chatId, 'הבקשה שלך כבר ממתינה לאישור. אני אודיע לך כשהיא תאושר.');
    return;
  }

  const name = displayName(user);

  await db.upsertUser({ userId: user.id, name, areas: ['pending'] });

  await sendMessage(
    chatId,
    [
      'שלום. הבוט הזה סגור.',
      '',
      'שלחתי בקשת גישה. תקבל הודעה כשהיא תאושר.',
    ].join('\n')
  );

  if (!config.telegram.ownerId) return;

  await sendMessage(
    config.telegram.ownerId,
    [
      '🔑 <b>בקשת גישה חדשה</b>',
      '',
      `שם: ${name}`,
      user.username ? `שם משתמש: @${user.username}` : '',
      `מזהה: <code>${user.id}</code>`,
      '',
      'אישור ייתן לו גישה לקליטת מוצרים מהמחסן בלבד.',
    ].filter(Boolean).join('\n'),
    {
      reply_markup: inlineKeyboard([
        [button('אשר כעובד מחסן', `acc:ok:${user.id}`), button('דחה', `acc:no:${user.id}`)],
      ]),
    }
  );
}

export async function approve(ownerChatId, userId) {
  const user = await db.getUser(userId);

  await db.upsertUser({ userId, name: user?.name, areas: [ROLE.warehouse] });

  await sendMessage(ownerChatId, `✅ ${user?.name || userId} אושר כעובד מחסן.`);

  try {
    await sendMessage(userId, 'הגישה שלך אושרה.');
    await warehouse.welcome(userId, userId);
  } catch (error) {
    console.error('לא הצלחתי להודיע למשתמש שאושר:', error.message);
  }
}

export async function reject(ownerChatId, userId) {
  const user = await db.getUser(userId);

  await db.upsertUser({ userId, name: user?.name, areas: ['rejected'] });

  await sendMessage(ownerChatId, `הבקשה של ${user?.name || userId} נדחתה.`);
}

// --- ניהול מתוך ההגדרות ---

export async function showUsers(chatId) {
  const users = await db.listUsers();

  if (!users.length) {
    await sendMessage(chatId, 'אין עדיין משתמשים נוספים. כשמישהו יפתח את הבוט תקבל בקשת אישור.');
    return;
  }

  const label = (areas) => {
    if (areas?.includes(ROLE.warehouse)) return 'עובד מחסן';
    if (areas?.includes('pending')) return 'ממתין לאישור';
    if (areas?.includes('rejected')) return 'נדחה';
    return 'בלי הרשאות';
  };

  const rows = users.map((user) => [
    button(`${user.name || user.user_id} · ${label(user.areas)}`, 'noop'),
    button('הסר', `acc:rm:${user.user_id}`),
  ]);

  const pending = users.filter((user) => user.areas?.includes('pending'));

  for (const user of pending) {
    rows.push([button(`אשר את ${user.name || user.user_id}`, `acc:ok:${user.user_id}`)]);
  }

  await sendMessage(chatId, '<b>משתמשים</b>', { reply_markup: inlineKeyboard(rows) });
}

export async function remove(chatId, userId) {
  await db.removeUser(userId);
  await sendMessage(chatId, 'הוסר. אם הוא יפתח את הבוט שוב תקבל בקשה חדשה.');
}
