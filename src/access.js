// מי מורשה להשתמש בבוט, ומה מותר לו.
//
// שמעון והמשתמשים שברשימת השרת הם בעלים: הם רואים הכול.
// לכל שאר המשתמשים יש רשימת אזורים, והתפריט הראשי נבנה ממנה.
// מי שלא מוכר מגיע לשמעון לאישור, ועד שהוא מאשר הבוט לא עונה לו.

import { config } from './config.js';
import * as db from './db.js';
import { sendMessage, editMessageText, inlineKeyboard, button, keyboardFor } from './telegram.js';

// האזורים שאפשר לחלק. הסדר כאן הוא הסדר בתפריט ובמסך ההרשאות.
// "הגדרות" המלאות לא נמצאות כאן בכוונה: משם אפשר לנתק את גוגל
// ולאשר משתמשים, וזה נשאר רק לבעלים.
export const AREAS = [
  { key: 'intake', button: 'הוספה לרשימת העלאה' },
  { key: 'inventory', button: 'ניהול מלאי' },
  { key: 'orders', button: 'הזמנות' },
  { key: 'products', button: 'מוצר חדש' },
  { key: 'checks', button: 'בדיקות' },
  { key: 'alerts', button: 'הגדרות התראות' },
];

const AREA_KEYS = AREAS.map((area) => area.key);

export function isOwner(userId) {
  const list = config.telegram.allowedUserIds;
  if (!list.length) return String(userId) === String(config.telegram.ownerId);
  return list.includes(String(userId));
}

// מחזיר את האזורים של המשתמש, או null אם אין לו גישה בכלל.
// לבעלים מחזיר את הכול ועוד הגדרות מלאות.
export async function areasOf(userId) {
  if (isOwner(userId)) return [...AREA_KEYS, 'settings'];

  const user = await db.getUser(userId);
  const areas = (user?.areas || []).filter((area) => AREA_KEYS.includes(area));

  return areas.length ? areas : null;
}

export function can(areas, key) {
  return Array.isArray(areas) && areas.includes(key);
}

export function keyboard(areas) {
  const full = can(areas, 'settings');

  const buttons = AREAS
    // למי שיש הגדרות מלאות אין טעם בכפתור נפרד להתראות, זה בתוכו
    .filter((area) => can(areas, area.key) && !(full && area.key === 'alerts'))
    .map((area) => area.button);

  return keyboardFor(buttons, { settings: full });
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
    ['שלום. הבוט הזה סגור.', '', 'שלחתי בקשת גישה. תקבל הודעה כשהיא תאושר.'].join('\n')
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
    ].filter(Boolean).join('\n'),
    {
      reply_markup: inlineKeyboard([
        [button('אשר ובחר הרשאות', `acc:ok:${user.id}`), button('דחה', `acc:no:${user.id}`)],
      ]),
    }
  );
}

export async function approve(ownerChatId, userId) {
  const user = await db.getUser(userId);

  // מאושר, אבל עדיין בלי שום אזור. הוא לא רואה כלום עד שבוחרים לו.
  await db.upsertUser({ userId, name: user?.name, areas: [] });

  await showPermissions(ownerChatId, userId);
}

export async function reject(ownerChatId, userId) {
  const user = await db.getUser(userId);

  await db.upsertUser({ userId, name: user?.name, areas: ['rejected'] });

  await sendMessage(ownerChatId, `הבקשה של ${user?.name || userId} נדחתה.`);
}

// --- מסך ההרשאות ---

function permissionRows(userId, areas) {
  const rows = AREAS.map((area) => [
    button(
      `${areas.includes(area.key) ? '✅' : '⬜️'}  ${area.button}`,
      `acc:area:${userId}:${area.key}`
    ),
  ]);

  rows.push([button('סיום', `acc:done:${userId}`)]);

  return rows;
}

function permissionText(user, areas) {
  const name = user?.name || user?.user_id || 'משתמש';

  return [
    `<b>הרשאות של ${name}</b>`,
    '',
    areas.length
      ? 'הכפתורים המסומנים יופיעו אצלו בתפריט.'
      : 'אין לו כרגע שום הרשאה, אז הבוט לא עונה לו.',
    '',
    'לחיצה מדליקה או מכבה.',
  ].join('\n');
}

export async function showPermissions(chatId, userId, messageId = null) {
  const user = await db.getUser(userId);
  const areas = (user?.areas || []).filter((area) => AREA_KEYS.includes(area));

  const text = permissionText(user, areas);
  const markup = inlineKeyboard(permissionRows(userId, areas));

  if (messageId) {
    await editMessageText(chatId, messageId, text, { reply_markup: markup });
    return;
  }

  await sendMessage(chatId, text, { reply_markup: markup });
}

export async function toggleArea(chatId, userId, areaKey, messageId) {
  if (!AREA_KEYS.includes(areaKey)) return;

  const user = await db.getUser(userId);
  const current = (user?.areas || []).filter((area) => AREA_KEYS.includes(area));

  const next = current.includes(areaKey)
    ? current.filter((area) => area !== areaKey)
    : [...current, areaKey];

  await db.upsertUser({ userId, name: user?.name, areas: next });
  await showPermissions(chatId, userId, messageId);
}

// סוגר את המסך ומודיע למשתמש מה הוא קיבל
export async function finishPermissions(chatId, userId, messageId) {
  const user = await db.getUser(userId);
  const areas = (user?.areas || []).filter((area) => AREA_KEYS.includes(area));

  const names = AREAS.filter((area) => areas.includes(area.key)).map((area) => area.button);

  await editMessageText(
    chatId,
    messageId,
    [
      `<b>${user?.name || userId}</b>`,
      '',
      names.length ? names.map((name) => `• ${name}`).join('\n') : 'בלי הרשאות. הבוט לא יענה לו.',
    ].join('\n')
  );

  if (!areas.length) return;

  try {
    await sendMessage(userId, 'הגישה שלך אושרה. הנה מה שאתה יכול לעשות:', {
      reply_markup: keyboard(areas),
    });
  } catch (error) {
    console.error('לא הצלחתי להודיע למשתמש שאושר:', error.message);
  }
}

// --- רשימת המשתמשים ---

export async function showUsers(chatId) {
  const users = await db.listUsers();

  if (!users.length) {
    await sendMessage(chatId, 'אין עדיין משתמשים נוספים. כשמישהו יפתח את הבוט תקבל בקשת אישור.');
    return;
  }

  const rows = [];
  const lines = ['<b>משתמשים</b>', ''];

  for (const user of users) {
    const areas = user.areas || [];
    const granted = AREAS.filter((area) => areas.includes(area.key)).map((area) => area.button);

    let state = granted.join(', ');
    if (areas.includes('pending')) state = 'ממתין לאישור';
    else if (areas.includes('rejected')) state = 'נדחה';
    else if (!granted.length) state = 'בלי הרשאות';

    lines.push(`${user.name || user.user_id} · ${state}`);

    if (areas.includes('pending')) {
      rows.push([
        button(`אשר את ${user.name || user.user_id}`, `acc:ok:${user.user_id}`),
        button('דחה', `acc:no:${user.user_id}`),
      ]);
    } else if (!areas.includes('rejected')) {
      rows.push([
        button(`הרשאות של ${user.name || user.user_id}`, `acc:edit:${user.user_id}`),
        button('הסר', `acc:rm:${user.user_id}`),
      ]);
    } else {
      rows.push([button(`הסר את ${user.name || user.user_id}`, `acc:rm:${user.user_id}`)]);
    }
  }

  await sendMessage(chatId, lines.join('\n'), { reply_markup: inlineKeyboard(rows) });
}

export async function remove(chatId, userId) {
  await db.removeUser(userId);
  await sendMessage(chatId, 'הוסר. אם הוא יפתח את הבוט שוב תקבל בקשה חדשה.');
}
