// מחקר מתחרים: מחפש את המוצר אצל המתחרים של הקטגוריה
// ומחזיר טווח מחירים לכל אחד, עם קישור ישיר לעמוד המוצר.
// הבוט אף פעם לא קובע מחיר, רק מראה מה יש בשוק.

import { supabase } from './db.js';
import * as woo from './woo.js';
import * as ai from './ai.js';
import { stripHtml } from './html.js';

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

// מצמצם את ה-HTML לאזור התוצאות, כדי שקלוד לא יקרא תפריטים וכותרות תחתונות
function resultsSection(html) {
  const text = String(html);

  const start = text.search(/<(ul|div)[^>]*class="[^"]*products[^"]*"/i);
  if (start === -1) return text;

  return text.slice(start, start + 60000);
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
        const productUrl = extractFirstProductUrl(html, competitor.site_url);
        const pageText = stripHtml(resultsSection(html));

        // עמוד ריק באמת, אין טעם לשרוף קריאה לקלוד
        if (pageText.length < 30) {
          return { name: competitor.name, status: 'not_found', url: searchUrl };
        }

        const read = await ai.readCompetitorPage({
          productName,
          competitor: competitor.name,
          pageText,
        });

        if (!read.found || read.price === null) {
          return {
            name: competitor.name,
            status: 'not_found',
            url: productUrl || searchUrl,
            reason: read.reason,
          };
        }

        return {
          name: competitor.name,
          status: 'ok',
          price: read.price,
          matchedName: read.matchedName,
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
      lines.push(`<a href="${result.url}">${result.name}</a>: ${result.price} ₪`);
    } else if (result.status === 'not_found') {
      lines.push(`${result.name}: אין לו את המוצר`);
    } else {
      lines.push(`${result.name}: לא הצלחתי לבדוק`);
    }
  }

  lines.push('');
  lines.push('המחיר נקבע על ידך בלבד.');

  return lines.join('\n');
}
