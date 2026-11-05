// מחקר מתחרים: מחפש את המוצר אצל המתחרים של הקטגוריה
// ומחזיר טווח מחירים לכל אחד, עם קישור ישיר לעמוד המוצר.
// הבוט אף פעם לא קובע מחיר, רק מראה מה יש בשוק.

import { supabase } from './db.js';
import * as woo from './woo.js';

// --- היררכיית קטגוריות ---
// המתחרים מוגדרים לפי קטגוריה ראשית, אבל מוצר מסווג לתת-קטגוריה.
// בלי זה מוצר ב"מצתים" לא מוצא את המתחרים של "מוצרים לעישון".

let treeCache = { at: 0, byName: new Map(), byId: new Map() };

async function categoryTree() {
  // הקטגוריות כמעט לא משתנות, אז שעה של מטמון חוסכת פניות מיותרות
  if (treeCache.byId.size && Date.now() - treeCache.at < 60 * 60 * 1000) return treeCache;

  const categories = await woo.getCategories();

  const byId = new Map();
  const byName = new Map();

  for (const category of categories) {
    byId.set(category.id, category);
    byName.set(String(category.name).trim(), category);
  }

  treeCache = { at: Date.now(), byId, byName };
  return treeCache;
}

// מחזיר את הקטגוריה וכל ההורים שלה, מהספציפי לכללי
export async function categoryChain(name) {
  if (!name) return [];

  try {
    const { byId, byName } = await categoryTree();
    const start = byName.get(String(name).trim());

    if (!start) return [String(name).trim()];

    const chain = [];
    let current = start;
    const seen = new Set();

    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(String(current.name).trim());
      current = current.parent ? byId.get(current.parent) : null;
    }

    return chain;
  } catch (error) {
    console.error('קריאת היררכיית הקטגוריות נכשלה:', error.message);
    return [String(name).trim()];
  }
}

// --- ניהול רשימת המתחרים ---

export async function listCompetitors(category = null) {
  if (!category) {
    const { data } = await supabase.from('bot_competitors').select('*').order('name');
    return data || [];
  }

  // מחפשים מתחרים של הקטגוריה עצמה ושל כל ההורים שלה
  const chain = await categoryChain(category);

  const { data } = await supabase
    .from('bot_competitors')
    .select('*')
    .overlaps('categories', chain)
    .order('name');

  return data || [];
}

export async function addCompetitor({ name, siteUrl, categories }) {
  const { data } = await supabase
    .from('bot_competitors')
    .insert({ name, site_url: siteUrl, categories })
    .select()
    .single();

  return data;
}

export async function removeCompetitor(id) {
  await supabase.from('bot_competitors').delete().eq('id', id);
}

// --- חיפוש מוצר אצל מתחרה ---

// מנסה את החיפוש הפנימי של האתר. רוב החנויות בארץ על ווקומרס,
// אז הנתיב הזה עובד ברוב המקרים.
async function searchOnSite(siteUrl, term) {
  const base = siteUrl.replace(/\/+$/, '');
  const url = `${base}/?s=${encodeURIComponent(term)}&post_type=product`;

  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GOA-bot/1.0)' },
    redirect: 'follow',
  });

  if (!response.ok) throw new Error(`האתר החזיר ${response.status}`);

  return { html: await response.text(), searchUrl: url };
}

// מוציא מחירים מתוך HTML של עמוד תוצאות
function extractPrices(html) {
  const prices = [];

  // מחירים בתוך תגיות המחיר הסטנדרטיות של ווקומרס
  const matches = html.matchAll(
    /<span class="woocommerce-Price-amount[^"]*"[^>]*>.*?([\d,]+(?:\.\d{2})?)/gis
  );

  for (const match of matches) {
    const value = Number(match[1].replace(/,/g, ''));
    if (value > 0 && value < 100000) prices.push(value);
  }

  // אם לא נמצא כלום, ניסיון רחב יותר על סימן השקל
  if (!prices.length) {
    const fallback = html.matchAll(/₪\s*([\d,]+(?:\.\d{2})?)|([\d,]+(?:\.\d{2})?)\s*₪/g);
    for (const match of fallback) {
      const raw = match[1] || match[2];
      const value = Number(raw.replace(/,/g, ''));
      if (value > 0 && value < 100000) prices.push(value);
    }
  }

  return prices;
}

// מוציא את הקישור הראשון לעמוד מוצר
function extractFirstProductUrl(html, base) {
  const match = html.match(/<a[^>]+href="([^"]*\/product\/[^"]+)"/i);
  if (!match) return null;

  const href = match[1];
  return href.startsWith('http') ? href : `${base.replace(/\/+$/, '')}${href}`;
}

// --- המחקר עצמו ---

export async function researchPrice(productName, category = null) {
  const competitors = await listCompetitors(category);

  if (!competitors.length) {
    const chain = category ? await categoryChain(category) : [];

    return {
      found: false,
      message: category
        ? `אין מתחרים מוגדרים ל"${chain.join('" או "')}". אפשר להוסיף בהגדרות.`
        : 'אין מתחרים מוגדרים. אפשר להוסיף בהגדרות.',
      results: [],
    };
  }

  const results = await Promise.all(
    competitors.map(async (competitor) => {
      try {
        const { html, searchUrl } = await searchOnSite(competitor.site_url, productName);
        const prices = extractPrices(html);
        const productUrl = extractFirstProductUrl(html, competitor.site_url);

        if (!prices.length) {
          return {
            name: competitor.name,
            status: 'not_found',
            url: productUrl || searchUrl,
          };
        }

        const unique = [...new Set(prices)].sort((a, b) => a - b);

        return {
          name: competitor.name,
          status: 'ok',
          min: unique[0],
          max: unique[unique.length - 1],
          url: productUrl || searchUrl,
        };
      } catch (error) {
        return { name: competitor.name, status: 'error', error: error.message };
      }
    })
  );

  return { found: results.some((r) => r.status === 'ok'), results };
}

// --- ניסוח לתצוגה ---

export function formatResearch(research) {
  if (!research.found) {
    return research.message || 'לא מצאתי את המוצר אצל אף מתחרה.';
  }

  const lines = ['<b>מחירים אצל המתחרים</b>', ''];

  for (const result of research.results) {
    if (result.status === 'ok') {
      const range = result.min === result.max
        ? `${result.min} ₪`
        : `${result.min}-${result.max} ₪`;
      lines.push(`<a href="${result.url}">${result.name}</a>: ${range}`);
    } else if (result.status === 'not_found') {
      lines.push(`${result.name}: לא נמצא`);
    } else {
      lines.push(`${result.name}: לא הצלחתי לבדוק`);
    }
  }

  lines.push('');
  lines.push('המחיר נקבע על ידך בלבד.');

  return lines.join('\n');
}
