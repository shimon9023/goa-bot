// התכונות הגלובליות של האתר: בחר טעם, בחר צבע, בחר גודל וכו'.
//
// למה זה קיים: עד עכשיו הבוט יצר לכל מוצר תכונה מקומית חדשה בשם "טעם".
// התוצאה היא שהערכים לא מתחברים לשום דבר קיים, אי אפשר לסנן לפיהם,
// וכל מוצר חי בעולם משלו. כאן מחברים אותו לתכונות האמיתיות.

import * as woo from './woo.js';
import * as ai from './ai.js';

let cache = { at: 0, list: [] };
const TTL_MS = 30 * 60 * 1000;

// מנרמל לצורך השוואה: בלי ניקוד, בלי רווחים כפולים, בלי "בחר" בהתחלה
function normalize(text) {
  return String(text || '')
    .replace(/[֑-ׇ]/g, '')
    .replace(/^בחר[יו]?\s+/, '')
    .replace(/["'״׳.,!?()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export async function load({ force = false } = {}) {
  if (!force && cache.list.length && Date.now() - cache.at < TTL_MS) return cache.list;

  const attributes = await woo.getAttributes();

  const withTerms = await Promise.all(
    attributes.map(async (attribute) => {
      try {
        const terms = await woo.getAttributeTerms(attribute.id);
        return { ...attribute, terms: terms || [] };
      } catch (error) {
        console.error(`קריאת ערכי "${attribute.name}" נכשלה:`, error.message);
        return { ...attribute, terms: [] };
      }
    })
  );

  cache = { at: Date.now(), list: withTerms };
  return withTerms;
}

// מוצא את התכונה לפי השם שקלוד החזיר. סובלני להבדלי ניסוח,
// כי קלוד עלול להחזיר "טעם" במקום "בחר טעם".
export async function find(name) {
  if (!name) return null;

  const list = await load();
  const wanted = normalize(name);

  return (
    list.find((attribute) => normalize(attribute.name) === wanted) ||
    list.find((attribute) => normalize(attribute.name).includes(wanted)) ||
    list.find((attribute) => wanted.includes(normalize(attribute.name))) ||
    null
  );
}

export function findTerm(attribute, value) {
  if (!attribute || !value) return null;

  const wanted = normalize(value);
  return (attribute.terms || []).find((term) => normalize(term.name) === wanted) || null;
}

// מוודא שכל הערכים קיימים בתכונה. מה שחסר נוצר עם סלאג באנגלית.
// מחזיר לכל ערך את השם הסופי ואם הוא נוצר עכשיו.
export async function ensureTerms(attribute, values) {
  const unique = [...new Set(values.filter(Boolean).map((value) => String(value).trim()))];
  const resolved = [];
  const missing = [];

  for (const value of unique) {
    const existing = findTerm(attribute, value);

    if (existing) resolved.push({ value, name: existing.name, created: false });
    else missing.push(value);
  }

  if (!missing.length) return resolved;

  let slugs = {};
  try {
    slugs = await ai.englishSlugs(missing);
  } catch (error) {
    console.error('יצירת סלאגים נכשלה, ווקומרס ייצר אותם לבד:', error.message);
  }

  for (const value of missing) {
    try {
      const slug = String(slugs[value] || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

      const term = await woo.createAttributeTerm(attribute.id, { name: value, slug });
      resolved.push({ value, name: term.name, created: true, slug: term.slug });
    } catch (error) {
      console.error(`יצירת הערך "${value}" נכשלה:`, error.message);
      resolved.push({ value, name: value, created: false, failed: error.message });
    }
  }

  // התכונה השתנתה, המטמון כבר לא מעודכן
  cache = { at: 0, list: [] };

  return resolved;
}

// רשימה מקוצרת לפרומפט של ניתוח התמונות
export async function forPrompt() {
  const list = await load();

  return list.map((attribute) => ({
    name: attribute.name,
    terms: (attribute.terms || []).map((term) => ({ name: term.name })),
  }));
}
