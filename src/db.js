// שכבת הזיכרון של הבוט, מעל סופהבייס.
// כאן נשמרים מצב השיחה, ההגדרות, יומן הפעולות וההתראות שכבר נשלחו.

import { createClient } from '@supabase/supabase-js';
import { config, defaultSettings } from './config.js';

export const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { persistSession: false },
});

// כל פנייה לסופהבייס עוברת כאן. בלי זה כשל נבלע בשקט,
// וזה בדיוק מה שגרם לטיוטות מוצר להיעלם בלי הודעת שגיאה.
async function run(label, query) {
  const { data, error } = await query;

  if (error) {
    const detail = error.message || error.code || 'שגיאה לא ידועה';
    console.error(`סופהבייס, ${label}: ${detail}`);
    throw new Error(`שמירה נכשלה (${label}): ${detail}`);
  }

  return data;
}

// לקריאות שמותר להן להיכשל בלי להפיל את הפעולה
async function tryRun(label, query) {
  try {
    return await run(label, query);
  } catch (error) {
    console.error(error.message);
    return null;
  }
}

// --- מצב שיחה ---
// שומר על מה המשתמש באמצע, כדי שההודעה הבאה שלו תתפרש נכון.

// מצב השיחה נקרא ונכתב הרבה פעמים בכל פעולה, וכל פנייה לסופהבייס
// היא הלוך-חזור שמורגש בזמן התגובה של הכפתורים.
// השרת רץ במופע יחיד, אז מטמון בזיכרון בטוח כאן.
const stateCache = new Map();

export async function getState(userId) {
  const key = String(userId);

  if (stateCache.has(key)) return stateCache.get(key);

  const data = await tryRun(
    'קריאת מצב',
    supabase.from('bot_sessions').select('state').eq('user_id', key).maybeSingle()
  );

  const state = data?.state || null;
  stateCache.set(key, state);

  return state;
}

export async function setState(userId, state) {
  const key = String(userId);

  // המטמון מתעדכן מיד, והכתיבה לסופהבייס רצה ברקע.
  // אם היא נכשלת זה נרשם בלוג, והמצב בזיכרון עדיין נכון להמשך השיחה.
  stateCache.set(key, state);

  await run(
    'שמירת מצב',
    supabase.from('bot_sessions').upsert(
      { user_id: key, state, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
  );
}

export async function clearState(userId) {
  const key = String(userId);
  stateCache.set(key, null);

  await tryRun('ניקוי מצב', supabase.from('bot_sessions').delete().eq('user_id', key));
}

// --- הגדרות ---

let settingsCache = null;

export async function getSettings() {
  if (settingsCache) return settingsCache;

  const data = await tryRun(
    'קריאת הגדרות',
    supabase.from('bot_settings').select('value').eq('key', 'main').maybeSingle()
  );

  settingsCache = { ...defaultSettings, ...(data?.value || {}) };
  return settingsCache;
}

export async function updateSettings(patch) {
  const current = await getSettings();
  const merged = { ...current, ...patch };

  await run(
    'שמירת הגדרות',
    supabase.from('bot_settings').upsert(
      { key: 'main', value: merged, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    )
  );

  settingsCache = merged;
  return merged;
}

// --- אחסון כללי ---
// שורות נפרדות ב-bot_settings, לדברים שהם לא "ההגדרות" עצמן:
// חיבור גוגל, אסימונים, וכל מצב שצריך לשרוד הפעלה מחדש של השרת.

export async function getStore(key) {
  const data = await tryRun(
    `קריאת ${key}`,
    supabase.from('bot_settings').select('value').eq('key', key).maybeSingle()
  );

  return data?.value || null;
}

export async function setStore(key, value) {
  await run(
    `שמירת ${key}`,
    supabase.from('bot_settings').upsert(
      { key, value, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    )
  );
}

// --- משתמשים והרשאות ---

export async function getUser(userId) {
  const data = await tryRun(
    'קריאת משתמש',
    supabase.from('bot_users').select('*').eq('user_id', String(userId)).maybeSingle()
  );

  return data || null;
}

export async function listUsers() {
  const data = await tryRun(
    'קריאת משתמשים',
    supabase.from('bot_users').select('*').order('created_at')
  );

  return data || [];
}

export async function upsertUser({ userId, name, areas }) {
  await run(
    'שמירת משתמש',
    supabase.from('bot_users').upsert(
      { user_id: String(userId), name: name || null, areas: areas || [] },
      { onConflict: 'user_id' }
    )
  );
}

export async function removeUser(userId) {
  await tryRun('מחיקת משתמש', supabase.from('bot_users').delete().eq('user_id', String(userId)));
}

// --- יומן פעולות ---
// כל שינוי שהבוט עושה באתר נרשם כאן, כדי שאפשר יהיה לראות מה קרה ולבטל.

export async function logAction({ userId, action, target, before, after }) {
  const data = await tryRun(
    'רישום ביומן',
    supabase.from('bot_actions').insert({
      user_id: String(userId),
      action,
      target,
      before_value: before ?? null,
      after_value: after ?? null,
    }).select('id').single()
  );

  return data?.id;
}

export async function getLastAction(userId) {
  const data = await tryRun(
    'קריאת פעולה אחרונה',
    supabase.from('bot_actions').select('*')
      .eq('user_id', String(userId))
      .eq('undone', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  );

  return data || null;
}

export async function markUndone(actionId) {
  await run('סימון ביטול', supabase.from('bot_actions').update({ undone: true }).eq('id', actionId));
}

export async function getRecentActions(limit = 20) {
  const data = await tryRun(
    'קריאת יומן',
    supabase.from('bot_actions').select('*').order('created_at', { ascending: false }).limit(limit)
  );

  return data || [];
}

// --- התראות ---
// רישום מה כבר נשלח, כדי לא להציק פעמיים על אותה הזמנה.

export async function wasAlertSent(orderId, kind) {
  const data = await tryRun(
    'בדיקת התראה',
    supabase.from('bot_alerts').select('id, sent_at')
      .eq('order_id', String(orderId))
      .eq('kind', kind)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  );

  return data || null;
}

export async function recordAlert(orderId, kind) {
  await tryRun('רישום התראה', supabase.from('bot_alerts').insert({ order_id: String(orderId), kind }));
}

export async function muteOrder(orderId) {
  await run(
    'השתקת הזמנה',
    supabase.from('bot_muted_orders').upsert({ order_id: String(orderId) }, { onConflict: 'order_id' })
  );
}

export async function isOrderMuted(orderId) {
  const data = await tryRun(
    'בדיקת השתקה',
    supabase.from('bot_muted_orders').select('order_id').eq('order_id', String(orderId)).maybeSingle()
  );

  return Boolean(data);
}

// --- תור התראות לשעות שקטות ---

export async function queueQuietAlert(text) {
  await tryRun('הוספה לתור השקט', supabase.from('bot_quiet_queue').insert({ text }));
}

export async function drainQuietQueue() {
  const data = await tryRun(
    'קריאת התור השקט',
    supabase.from('bot_quiet_queue').select('*').order('created_at')
  );

  if (!data?.length) return [];

  await tryRun(
    'ריקון התור השקט',
    supabase.from('bot_quiet_queue').delete().in('id', data.map((row) => row.id))
  );

  return data;
}
