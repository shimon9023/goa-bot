// שכבת הזיכרון של הבוט, מעל סופהבייס.
// כאן נשמרים מצב השיחה, ההגדרות, יומן הפעולות וההתראות שכבר נשלחו.

import { createClient } from '@supabase/supabase-js';
import { config, defaultSettings } from './config.js';

export const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { persistSession: false },
});

// --- מצב שיחה ---
// שומר על מה המשתמש באמצע, כדי שההודעה הבאה שלו תתפרש נכון.

export async function getState(userId) {
  const { data } = await supabase
    .from('bot_sessions')
    .select('state')
    .eq('user_id', String(userId))
    .maybeSingle();

  return data?.state || null;
}

export async function setState(userId, state) {
  await supabase
    .from('bot_sessions')
    .upsert(
      { user_id: String(userId), state, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
}

export async function clearState(userId) {
  await supabase.from('bot_sessions').delete().eq('user_id', String(userId));
}

// --- הגדרות ---

let settingsCache = null;

export async function getSettings() {
  if (settingsCache) return settingsCache;

  const { data } = await supabase
    .from('bot_settings')
    .select('value')
    .eq('key', 'main')
    .maybeSingle();

  settingsCache = { ...defaultSettings, ...(data?.value || {}) };
  return settingsCache;
}

export async function updateSettings(patch) {
  const current = await getSettings();
  const merged = { ...current, ...patch };

  await supabase
    .from('bot_settings')
    .upsert({ key: 'main', value: merged, updated_at: new Date().toISOString() }, { onConflict: 'key' });

  settingsCache = merged;
  return merged;
}

// --- יומן פעולות ---
// כל שינוי שהבוט עושה באתר נרשם כאן, כדי שאפשר יהיה לראות מה קרה ולבטל.

export async function logAction({ userId, action, target, before, after }) {
  const { data } = await supabase
    .from('bot_actions')
    .insert({
      user_id: String(userId),
      action,
      target,
      before_value: before ?? null,
      after_value: after ?? null,
    })
    .select('id')
    .single();

  return data?.id;
}

export async function getLastAction(userId) {
  const { data } = await supabase
    .from('bot_actions')
    .select('*')
    .eq('user_id', String(userId))
    .eq('undone', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data || null;
}

export async function markUndone(actionId) {
  await supabase.from('bot_actions').update({ undone: true }).eq('id', actionId);
}

export async function getRecentActions(limit = 20) {
  const { data } = await supabase
    .from('bot_actions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  return data || [];
}

// --- התראות ---
// רישום מה כבר נשלח, כדי לא להציק פעמיים על אותה הזמנה.

export async function wasAlertSent(orderId, kind) {
  const { data } = await supabase
    .from('bot_alerts')
    .select('id, sent_at')
    .eq('order_id', String(orderId))
    .eq('kind', kind)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data || null;
}

export async function recordAlert(orderId, kind) {
  await supabase.from('bot_alerts').insert({ order_id: String(orderId), kind });
}

export async function muteOrder(orderId) {
  await supabase
    .from('bot_muted_orders')
    .upsert({ order_id: String(orderId) }, { onConflict: 'order_id' });
}

export async function isOrderMuted(orderId) {
  const { data } = await supabase
    .from('bot_muted_orders')
    .select('order_id')
    .eq('order_id', String(orderId))
    .maybeSingle();

  return Boolean(data);
}

// --- תור התראות לשעות שקטות ---

export async function queueQuietAlert(text) {
  await supabase.from('bot_quiet_queue').insert({ text });
}

export async function drainQuietQueue() {
  const { data } = await supabase.from('bot_quiet_queue').select('*').order('created_at');

  if (!data?.length) return [];

  await supabase
    .from('bot_quiet_queue')
    .delete()
    .in('id', data.map((row) => row.id));

  return data;
}
