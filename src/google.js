// חיבור לגוגל: שיטס ודרייב.
//
// למה OAuth ולא חשבון שירות: חשבון שירות הוא "משתמש" בלי נפח אחסון משלו
// בדרייב, אז כל ניסיון שלו להעלות קובץ לתיקייה בחשבון גוגל רגיל נכשל
// בהודעה "Service Accounts do not have storage quota".
// לכן הבוט מתחבר בשם החשבון של שמעון עצמו: הקבצים שייכים לו,
// הם יושבים בדרייב שלו, והנפח הוא הנפח שלו.
//
// ההרשאה היחידה שמבקשים היא drive.file, שנותנת גישה רק לקבצים
// שהבוט עצמו יצר. הוא לא רואה שום דבר אחר בדרייב.

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import { config } from './config.js';
import * as db from './db.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

const FOLDER_NAME = 'GOA - מוצרים מהמחסן';
const SHEET_NAME = 'מוצרים מהמחסן';
const TAB = 'רשימה';

// הכותרות של הגיליון. הסדר כאן הוא הסדר בפועל, אל תשנה בלי לעדכן את ROW.
export const HEADERS = [
  'מזהה',
  'תאריך',
  'מי צילם',
  'תיאור',
  'כמות',
  'מחיר מינימלי',
  'מספר תמונות',
  'תמונות בדרייב',
  'סטטוס',
  'מוצר באתר',
  'מזהי טלגרם',
];

export const COL = {
  id: 0,
  date: 1,
  who: 2,
  description: 3,
  quantity: 4,
  minPrice: 5,
  photoCount: 6,
  driveLinks: 7,
  status: 8,
  productUrl: 9,
  fileIds: 10,
};

export const STATUS = {
  pending: 'ממתין',
  created: 'נוצר',
  rejected: 'נדחה',
};

// --- אחסון החיבור ---
// נשמר בסופהבייס ולא במשתני סביבה, כדי ששמעון יוכל לחבר ולנתק
// מתוך הבוט בלי לגעת בהגדרות השרת.

let memo = null;

async function stored() {
  if (memo) return memo;
  memo = (await db.getStore('google')) || {};
  return memo;
}

async function save(patch) {
  const current = await stored();
  memo = { ...current, ...patch };
  await db.setStore('google', memo);
  return memo;
}

export async function isConnected() {
  const data = await stored();
  return Boolean(data.refreshToken);
}

export async function status() {
  const data = await stored();

  return {
    connected: Boolean(data.refreshToken),
    account: data.account || '',
    sheetUrl: data.sheetId ? `https://docs.google.com/spreadsheets/d/${data.sheetId}` : '',
    folderUrl: data.folderId ? `https://drive.google.com/drive/folders/${data.folderId}` : '',
  };
}

export async function disconnect() {
  memo = {};
  await db.setStore('google', {});
}

// --- שלב ההתחברות ---

function redirectUri() {
  if (!config.publicBaseUrl) throw new Error('חסר PUBLIC_BASE_URL, אי אפשר לחבר את גוגל.');
  return `${config.publicBaseUrl}/google/callback`;
}

function requireClient() {
  const { clientId, clientSecret } = config.google;

  if (!clientId || !clientSecret) {
    throw new Error('חסרים GOOGLE_CLIENT_ID ו-GOOGLE_CLIENT_SECRET בהגדרות השרת.');
  }

  return { clientId, clientSecret };
}

// מייצר קישור חד פעמי. ה-state הוא סוד קצר תוקף, כדי שרק מי שלחץ
// בבוט יוכל להשלים את החיבור.
export async function startAuth() {
  const { clientId } = requireClient();
  const state = randomUUID();

  await save({ pendingState: state, pendingUntil: Date.now() + 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });

  return `${AUTH_URL}?${params}`;
}

export async function finishAuth(code, state) {
  const data = await stored();

  if (!data.pendingState || state !== data.pendingState) {
    throw new Error('הקישור לא תקף. בקש קישור חדש מתוך הבוט.');
  }

  if (Date.now() > (data.pendingUntil || 0)) {
    throw new Error('הקישור פג. בקש קישור חדש מתוך הבוט.');
  }

  const { clientId, clientSecret } = requireClient();

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.refresh_token) {
    const reason = body.error_description || body.error || `HTTP ${response.status}`;
    throw new Error(`גוגל לא החזיר הרשאה קבועה: ${reason}`);
  }

  await save({
    refreshToken: body.refresh_token,
    accessToken: body.access_token,
    accessUntil: Date.now() + (body.expires_in || 3600) * 1000 - 60_000,
    pendingState: null,
    pendingUntil: 0,
  });

  return ensureWorkspace();
}

async function accessToken() {
  const data = await stored();

  if (!data.refreshToken) {
    throw new Error('גוגל לא מחובר. היכנס להגדרות בבוט ולחץ על חיבור לגוגל.');
  }

  if (data.accessToken && Date.now() < (data.accessUntil || 0)) {
    return data.accessToken;
  }

  const { clientId, clientSecret } = requireClient();

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: data.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.access_token) {
    const reason = body.error_description || body.error || `HTTP ${response.status}`;

    // invalid_grant פירושו שההרשאה בוטלה או פגה. אין טעם לנסות שוב.
    if (body.error === 'invalid_grant') {
      await save({ refreshToken: null, accessToken: null, accessUntil: 0 });
      throw new Error('החיבור לגוגל פג. היכנס להגדרות בבוט וחבר מחדש.');
    }

    throw new Error(`רענון ההרשאה של גוגל נכשל: ${reason}`);
  }

  await save({
    accessToken: body.access_token,
    accessUntil: Date.now() + (body.expires_in || 3600) * 1000 - 60_000,
  });

  return body.access_token;
}

async function api(url, options = {}) {
  const token = await accessToken();

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const reason = body?.error?.message || body?.error_description || `HTTP ${response.status}`;
    throw new Error(`גוגל: ${reason}`);
  }

  return body;
}

// --- יצירת התיקייה והגיליון ---
// הבוט יוצר אותם בעצמו, ולכן ההרשאה הצרה drive.file מספיקה.

export async function ensureWorkspace() {
  const data = await stored();

  let folderId = data.folderId;
  let sheetId = data.sheetId;

  if (!folderId) {
    const folder = await api('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });

    folderId = folder.id;
  }

  if (!sheetId) {
    const sheet = await api('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: { title: SHEET_NAME },
        sheets: [{ properties: { title: TAB, gridProperties: { frozenRowCount: 1 } } }],
      }),
    });

    sheetId = sheet.spreadsheetId;

    // מעבירים את הגיליון לתוך התיקייה, כדי שהכול יישב יחד
    await api(
      `https://www.googleapis.com/drive/v3/files/${sheetId}?addParents=${folderId}&fields=id`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    ).catch((error) => console.error('העברת הגיליון לתיקייה נכשלה:', error.message));

    await api(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`${TAB}!A1`)}?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [HEADERS] }),
      }
    );
  }

  const about = await api(
    'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)'
  ).catch(() => null);

  await save({
    folderId,
    sheetId,
    account: about?.user?.emailAddress || data.account || '',
  });

  return status();
}

async function requireSheet() {
  const data = await stored();
  if (data.sheetId && data.folderId) return data;

  await ensureWorkspace();
  return stored();
}

// --- העלאת תמונה לדרייב ---

export async function uploadPhoto(buffer, mimeType, name) {
  const { folderId } = await requireSheet();
  const token = await accessToken();

  const boundary = `goa${randomUUID().replace(/-/g, '')}`;
  const metadata = JSON.stringify({ name, parents: [folderId] });

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      'utf8'
    ),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);

  const response = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.id) {
    const reason = result?.error?.message || `HTTP ${response.status}`;
    throw new Error(`העלאת התמונה לדרייב נכשלה: ${reason}`);
  }

  return {
    id: result.id,
    link: result.webViewLink || `https://drive.google.com/file/d/${result.id}/view`,
  };
}

// --- קריאה וכתיבה בגיליון ---

function range(a1) {
  return encodeURIComponent(`${TAB}!${a1}`);
}

export async function appendRow(values) {
  const { sheetId } = await requireSheet();

  await api(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range('A:Z')}:append` +
      '?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [values] }),
    }
  );
}

// מחזיר את כל השורות, כל אחת עם מספר השורה בגיליון כדי שאפשר יהיה לעדכן אותה
export async function readRows() {
  const { sheetId } = await requireSheet();

  const body = await api(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range('A2:Z')}`
  );

  return (body.values || [])
    .map((cells, index) => ({ rowNumber: index + 2, cells }))
    .filter((row) => row.cells.some((cell) => String(cell || '').trim()));
}

export async function findRow(id) {
  const rows = await readRows();
  return rows.find((row) => String(row.cells[COL.id] || '').trim() === String(id).trim()) || null;
}

export async function pendingRows() {
  const rows = await readRows();
  return rows.filter((row) => (row.cells[COL.status] || STATUS.pending) === STATUS.pending);
}

const COLUMN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export async function updateCell(rowNumber, columnIndex, value) {
  const { sheetId } = await requireSheet();
  const letter = COLUMN_LETTERS[columnIndex];

  await api(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range(`${letter}${rowNumber}`)}` +
      '?valueInputOption=USER_ENTERED',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[value]] }),
    }
  );
}

export async function markCreated(rowNumber, productUrl) {
  await updateCell(rowNumber, COL.status, STATUS.created);
  await updateCell(rowNumber, COL.productUrl, productUrl);
}
