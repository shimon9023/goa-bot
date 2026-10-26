// מחסן תמונות זמני.
//
// למה הוא קיים: מפתחות ווקומרס לא מורשים להעלות לספריית המדיה של וורדפרס,
// וכל ניסיון נענה ב"אין לך הרשאות ליצור פוסטים".
// במקום זה הבוט מגיש את התמונה בכתובת ציבורית זמנית,
// ונותן לווקומרס רק קישור. ווקומרס מוריד את הקובץ בעצמו
// ומכניס אותו לספריית המדיה כמו כל תמונה אחרת.
//
// התמונות יושבות בזיכרון בלבד ונמחקות אחרי שעה.

import { randomUUID } from 'node:crypto';

const store = new Map();
const TTL_MS = 60 * 60 * 1000;

export function put(buffer, mimeType) {
  const id = randomUUID();
  store.set(id, { buffer, mimeType, at: Date.now() });
  return id;
}

export function get(id) {
  const item = store.get(id);
  if (!item) return null;

  if (Date.now() - item.at > TTL_MS) {
    store.delete(id);
    return null;
  }

  return item;
}

export function remove(id) {
  store.delete(id);
}

export function publicUrl(baseUrl, id, mimeType) {
  const extension = String(mimeType).includes('png') ? 'png' : 'jpg';
  return `${baseUrl}/img/${id}.${extension}`;
}

// ניקוי תקופתי, כדי שהזיכרון לא יתנפח
export function startCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [id, item] of store) {
      if (now - item.at > TTL_MS) store.delete(id);
    }
  }, 10 * 60 * 1000).unref();
}

export function size() {
  return store.size;
}
