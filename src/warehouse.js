// קליטת מוצרים מהמחסן.
//
// העובד במחסן רואה רק את זה: הוא מצלם מוצר, כותב עליו כמה מילים אם הוא רוצה,
// ולוחץ על כפתור אחד. מה שנאסף נכנס לגיליון בשיטס, התמונות עולות לדרייב,
// והמוצר ממתין שם עד ששמעון יוצר אותו באתר.

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import * as db from './db.js';
import * as ai from './ai.js';
import * as google from './google.js';
import { sendMessage, editMessageText, inlineKeyboard, button, getFile, fileUrl } from './telegram.js';

const MAX_PHOTOS = 12;

// --- מצב המוצר הפתוח ---

async function openItem(userId) {
  const state = await db.getState(userId);

  if (state?.module === 'warehouse') return state;

  return { module: 'warehouse', photos: [], notes: [], cardMessageId: null };
}

function summary(item) {
  const photos = item.photos?.length || 0;
  const notes = (item.notes || []).join(' ').trim();

  const lines = [
    '<b>📦 מוצר פתוח</b>',
    '',
    photos ? `${photos} תמונות` : 'עוד לא צילמת',
  ];

  if (notes) lines.push('', `<i>${escapeHtml(notes)}</i>`);

  lines.push('', 'אפשר להוסיף עוד תמונות או לכתוב עוד.', 'כשסיימת עם המוצר הזה, לחץ שמור.');

  return lines.join('\n');
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const saveButton = inlineKeyboard([[button('שמור', 'wh:save')]]);

// מציג את הכרטיס, ומעדכן את אותה הודעה במקום להציף את הצ'אט
async function showCard(chatId, userId, item) {
  const text = summary(item);

  if (item.cardMessageId) {
    try {
      await editMessageText(chatId, item.cardMessageId, text, { reply_markup: saveButton });
      await db.setState(userId, item);
      return;
    } catch (error) {
      console.error('עדכון כרטיס המחסן נכשל:', error.message);
    }
  }

  const sent = await sendMessage(chatId, text, { reply_markup: saveButton });
  item.cardMessageId = sent.message_id;
  await db.setState(userId, item);
}

// --- קליטה ---

export async function welcome(chatId, userId) {
  const item = { module: 'warehouse', photos: [], notes: [], cardMessageId: null };
  await db.setState(userId, item);

  await sendMessage(
    chatId,
    [
      '<b>קליטת מוצרים מהמחסן</b>',
      '',
      'צלם את המוצר ושלח לי את התמונות. אפשר כמה תמונות לאותו מוצר,',
      'למשל צבעים או גדלים שונים.',
      '',
      'אם אתה יודע עליו משהו, כתוב לי: שם, כמות שיש במלאי,',
      'והמחיר שמופיע על המדבקה.',
      '',
      'כשסיימת עם המוצר, לחץ שמור ונעבור למוצר הבא.',
    ].join('\n')
  );
}

export async function addPhotos(chatId, userId, photoSizes) {
  const item = await openItem(userId);

  if ((item.photos?.length || 0) >= MAX_PHOTOS) {
    await sendMessage(chatId, `הגעת ל-${MAX_PHOTOS} תמונות למוצר הזה. לחץ שמור ונתחיל מוצר חדש.`);
    return;
  }

  // טלגרם שולח כמה גדלים, לוקחים את הגדול ביותר.
  // שומרים מזהה קובץ ולא קישור, כי הקישור מכיל את הטוקן ופג אחרי שעה.
  const largest = photoSizes[photoSizes.length - 1];
  item.photos = [...(item.photos || []), largest.file_id];

  await showCard(chatId, userId, item);
}

export async function addNote(chatId, userId, text) {
  const clean = String(text || '').trim();
  if (!clean) return;

  const item = await openItem(userId);
  item.notes = [...(item.notes || []), clean];

  await showCard(chatId, userId, item);
}

export async function addVoice(chatId, userId, voice) {
  const file = await getFile(voice.file_id);
  const transcript = await ai.transcribe(fileUrl(file.file_path));

  await addNote(chatId, userId, transcript);
}

// --- שמירה ---

async function downloadPhoto(fileId) {
  const file = await getFile(fileId);
  const response = await fetch(fileUrl(file.file_path));

  if (!response.ok) throw new Error(`הורדת התמונה נכשלה: HTTP ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const header = response.headers.get('content-type') || '';
  const mimeType = header.startsWith('image/') ? header : 'image/jpeg';

  return { buffer, mimeType };
}

export async function save(chatId, userId, who) {
  const item = await openItem(userId);
  const photos = item.photos || [];
  const notes = (item.notes || []).join(' ').trim();

  if (!photos.length && !notes) {
    await sendMessage(chatId, 'עוד לא קיבלתי כלום. שלח תמונה של המוצר ואז לחץ שמור.');
    return;
  }

  await sendMessage(chatId, 'שומר, רגע אחד.');

  // מחלצים כמות ומחיר מתוך מה שהעובד כתב
  let parsed = { description: notes, quantity: '', minPrice: '' };

  if (notes) {
    try {
      parsed = await ai.readWarehouseNote(notes);
    } catch (error) {
      console.error('פענוח ההערה של המחסן נכשל:', error.message);
    }
  }

  // מעלים את התמונות לדרייב
  const links = [];
  const failed = [];
  const id = randomUUID().slice(0, 8);
  const baseName = (parsed.description || 'מוצר').slice(0, 40).replace(/[\\/:*?"<>|]/g, ' ').trim();

  for (const [index, fileId] of photos.entries()) {
    try {
      const { buffer, mimeType } = await downloadPhoto(fileId);
      const extension = mimeType.includes('png') ? 'png' : 'jpg';
      const uploaded = await google.uploadPhoto(
        buffer,
        mimeType,
        `${id} ${baseName} ${index + 1}.${extension}`
      );
      links.push(uploaded.link);
    } catch (error) {
      console.error('העלאת תמונה לדרייב נכשלה:', error.message);
      failed.push(index + 1);
    }
  }

  const row = [];
  row[google.COL.id] = id;
  row[google.COL.date] = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  row[google.COL.who] = who || '';
  row[google.COL.description] = parsed.description || notes;
  row[google.COL.quantity] = parsed.quantity ?? '';
  row[google.COL.minPrice] = parsed.minPrice ?? '';
  row[google.COL.photoCount] = photos.length;
  row[google.COL.driveLinks] = links.join('\n');
  row[google.COL.status] = google.STATUS.pending;
  row[google.COL.productUrl] = '';
  row[google.COL.fileIds] = photos.join(',');

  // ממלאים חורים, כדי ששיטס לא יזיז עמודות
  for (let i = 0; i < google.HEADERS.length; i += 1) {
    if (row[i] === undefined) row[i] = '';
  }

  await google.appendRow(row);

  // מנקים את הכרטיס הפתוח ומתחילים מוצר חדש
  await db.setState(userId, { module: 'warehouse', photos: [], notes: [], cardMessageId: null });

  const confirmation = [
    '✅ <b>נשמר</b>',
    '',
    parsed.description ? escapeHtml(parsed.description) : 'בלי תיאור',
    photos.length ? `${photos.length} תמונות` : '',
    parsed.quantity ? `כמות: ${escapeHtml(String(parsed.quantity))}` : '',
    parsed.minPrice ? `מחיר מינימלי: ${escapeHtml(String(parsed.minPrice))} ₪` : '',
    failed.length ? `\n⚠️ ${failed.length} תמונות לא עלו לדרייב. שמעון יקבל על זה הודעה.` : '',
    '',
    'מוכן למוצר הבא.',
  ].filter(Boolean).join('\n');

  await sendMessage(chatId, confirmation);

  return { id, failed: failed.length, description: parsed.description || notes };
}

// --- הצגת הרשימה לשמעון ---

export function describeRow(row) {
  const c = row.cells;

  return [
    c[google.COL.description] || 'בלי תיאור',
    c[google.COL.quantity] ? `כמות ${c[google.COL.quantity]}` : '',
    c[google.COL.minPrice] ? `${c[google.COL.minPrice]} ₪` : '',
    c[google.COL.photoCount] ? `${c[google.COL.photoCount]} תמונות` : '',
  ].filter(Boolean).join(' · ');
}

export function rowFileIds(row) {
  return String(row.cells[google.COL.fileIds] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

// הטקסט שעובר ליצירת המוצר, כולל מה שהעובד ידע
export function rowBrief(row) {
  const c = row.cells;

  return [
    c[google.COL.description] || '',
    c[google.COL.minPrice] ? `המחיר שמופיע על המדבקה: ${c[google.COL.minPrice]} ₪` : '',
    c[google.COL.quantity] ? `יש במלאי ${c[google.COL.quantity]} יחידות` : '',
  ].filter(Boolean).join('\n');
}
