// לימוד סגנון הכתיבה מהמוצרים שכבר קיימים באתר.
//
// במקום לתת לקלוד כללים מופשטים, נותנים לו דוגמאות אמיתיות
// מהקטגוריה שאליה המוצר החדש שייך.
//
// חשוב: חלק מהתיאורים באתר הודבקו מתוך ממשק של ChatGPT,
// ונגרר איתם כל מבנה העמוד — שכבות עטיפה, מזהי שיחה ומחלקות עיצוב.
// בתיאור אחד נמדדו 33,335 תווים שמתוכם כ-180 הם טקסט אמיתי.
// בלי קילוף, הבוט היה לומד את הפיגום הזה ולא את הכתיבה.

import * as woo from './woo.js';
import { categoryChain } from './competitors.js';

const cache = new Map();
const TTL_MS = 6 * 60 * 60 * 1000;

// מוציא טקסט נקי מתוך HTML, בלי ספריות חיצוניות
export function stripHtml(html) {
  if (!html) return '';

  let text = String(html);

  // מה שבתוך התגיות האלה הוא קוד ולא תוכן
  text = text.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ');

  // שומרים על גבולות פסקאות לפני שמוחקים תגיות
  text = text.replace(/<\/(p|div|section|h[1-6]|li|tr)\s*>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  text = text.replace(/<[^>]+>/g, ' ');

  // ישויות HTML נפוצות
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');

  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

// שורות שהן טקסט קבוע של האתר ולא כתיבה על המוצר
const BOILERPLATE = [
  /תמונת המוצר מעובדת על ידי/,
  /משלוח חינם/,
  /זמן המשלוח/,
];

function cleanDescription(html) {
  const text = stripHtml(html);

  return text
    .split('\n')
    .filter((line) => line.length > 2 && !BOILERPLATE.some((rx) => rx.test(line)))
    .join('\n');
}

// --- איסוף הדוגמאות ---

async function categoryIdsFor(categoryName) {
  const chain = await categoryChain(categoryName);
  const categories = await woo.getCategories();

  const byName = new Map(categories.map((c) => [String(c.name).trim(), c]));

  return chain.map((name) => byName.get(name)?.id).filter(Boolean);
}

// מחזיר דוגמאות כתיבה מהקטגוריה, ואם אין מספיק — גם מההורה שלה
export async function examplesFor(categoryName, limit = 4) {
  const key = String(categoryName || 'כללי');
  const hit = cache.get(key);

  if (hit && Date.now() - hit.at < TTL_MS) return hit.examples;

  const examples = [];

  try {
    const ids = await categoryIdsFor(categoryName);

    for (const id of ids) {
      if (examples.length >= limit) break;

      const products = await woo.getProductsInCategory(id, limit * 2);

      for (const product of products) {
        if (examples.length >= limit) break;

        const description = cleanDescription(product.description);
        const shortDescription = stripHtml(product.short_description);

        // מוצר בלי תיאור אמיתי לא מלמד כלום
        if (description.length < 40) continue;

        examples.push({
          name: product.name,
          shortDescription,
          // מגבילים את האורך, כדי שדוגמה אחת לא תבלע את הפרומפט
          description: description.slice(0, 700),
        });
      }
    }
  } catch (error) {
    console.error('קריאת דוגמאות סגנון נכשלה:', error.message);
  }

  cache.set(key, { at: Date.now(), examples });
  return examples;
}

// מנסח את הדוגמאות לבלוק שנכנס לפרומפט
export function asPromptBlock(examples) {
  if (!examples?.length) return '';

  const blocks = examples.map((example, index) => {
    return [
      `דוגמה ${index + 1}:`,
      `שם: ${example.name}`,
      example.shortDescription ? `תיאור קצר: ${example.shortDescription}` : '',
      `תיאור: ${example.description}`,
    ].filter(Boolean).join('\n');
  });

  return [
    'כך כתובים המוצרים הקיימים באתר. חקה את הסגנון, האורך והמקצב שלהם.',
    'אל תעתיק מהם מילים או עובדות, רק את אופן הכתיבה.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
