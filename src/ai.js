// המוח: Claude לכתיבה והבנת תמונות, Gemini לתמלול הקלטות וליצירת תמונות.
// כל קריאה נרשמת כדי שתקרת ההוצאה החודשית תדע מה קרה.

import { config } from './config.js';
import { supabase } from './db.js';
import {
  SHORT_DESCRIPTION_RULES,
  DESCRIPTION_RULES,
  META_RULES,
  VISION_RULES,
  SHELF_RULES,
} from './writing-rules.js';

// שמות המודלים. גוגל מוציאה גרסאות משימוש מדי פעם,
// אז אפשר לעקוף דרך משתני סביבה בלי לגעת בקוד.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash';
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

// מחירים לפי מיליון טוקנים, לחישוב העלות המשוערת
const PRICE_PER_MILLION = { input: 2, output: 10 };

// --- רישום הוצאה ---

async function recordSpend({ kind, inputTokens = 0, outputTokens = 0, images = 0 }) {
  const cost =
    (inputTokens / 1_000_000) * PRICE_PER_MILLION.input +
    (outputTokens / 1_000_000) * PRICE_PER_MILLION.output +
    images * 0.04;

  try {
    await supabase.from('bot_ai_spend').insert({
      kind,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      images,
      cost_usd: Number(cost.toFixed(4)),
    });
  } catch (error) {
    console.error('רישום ההוצאה נכשל:', error.message);
  }

  return cost;
}

export async function monthlySpend() {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const { data } = await supabase
    .from('bot_ai_spend')
    .select('cost_usd')
    .gte('created_at', start.toISOString());

  return (data || []).reduce((sum, row) => sum + Number(row.cost_usd || 0), 0);
}

// עוצר פעולות AI אם עברנו את התקרה שבהגדרות
export async function assertWithinBudget(settings) {
  const cap = settings?.monthlyCapUsd;
  if (!cap) return;

  const spent = await monthlySpend();

  if (spent >= cap) {
    throw new Error(
      `הגעת לתקרת ההוצאה החודשית (${cap} דולר). פעולות AI מושבתות עד שתעלה אותה בהגדרות.`
    );
  }
}

// --- Claude ---

async function callClaude({ system, messages, maxTokens = 2000 }) {
  if (!config.ai.anthropicKey) {
    throw new Error('חסר מפתח של Anthropic. הוסף ANTHROPIC_API_KEY בהגדרות השרת.');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.ai.anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Claude: ${data?.error?.message || response.status}`);
  }

  await recordSpend({
    kind: 'claude',
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  });

  return (data.content || []).map((block) => block.text || '').join('').trim();
}

// מבקש מקלוד תשובה בפורמט JSON ומנקה עטיפות קוד אם הן חזרו
async function callClaudeJson({ system, messages, maxTokens = 2000 }) {
  const raw = await callClaude({
    system: `${system}\n\nהחזר JSON תקין בלבד, בלי טקסט לפניו או אחריו.`,
    messages,
    maxTokens,
  });

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('לא הצלחתי לקרוא את התשובה של קלוד.');
  }
}

// --- כתיבת תוכן מוצר ---

export async function writeProductContent({
  spokenText,
  imageDescription,
  categories,
  tags,
  webContext = '',
}) {
  const system = `${DESCRIPTION_RULES}

---

בנוסף לתיאור המלא, אתה כותב גם תיאור קצר. הכללים שלו:

${SHORT_DESCRIPTION_RULES.split('## המשימה: תיאור קצר')[1]}

---

הקטגוריות הקיימות באתר (מותר לבחור רק מתוכן):
${categories.map((c) => `- ${c.name}`).join('\n')}

התגיות הקיימות באתר (מותר לבחור רק מתוכן):
${tags.map((t) => `- ${t.name}`).join('\n')}

אל תמציא קטגוריה או תגית חדשה. אם שום דבר לא מתאים, החזר רשימה ריקה.`;

  const parts = [
    spokenText ? `מה שמעון אמר על המוצר:\n${spokenText}` : '',
    imageDescription ? `מה רואים בתמונה:\n${imageDescription}` : '',
    webContext ? `מידע שנמצא באינטרנט:\n${webContext}` : '',
  ].filter(Boolean);

  return callClaudeJson({
    system,
    maxTokens: 3000,
    messages: [
      {
        role: 'user',
        content: `${parts.join('\n\n')}

החזר JSON במבנה הזה:
{
  "name": "שם המוצר",
  "categories": ["שם קטגוריה קיימת"],
  "tags": ["שם תגית קיימת"],
  "shortDescription": "משפט אחד בלבד, עד 15 מילים",
  "description": "תיאור מלא, פסקאות מופרדות בשורה ריקה",
  "priceFromUser": null,
  "productKind": "סוג המוצר במילה או שתיים, למשל חד פעמי, גחלים, נוזל סולט",
  "isBulk": false,
  "notes": "דברים שלא היית בטוח לגביהם"
}

אם שמעון אמר מחיר, שים אותו ב-priceFromUser כמספר. אם לא אמר, השאר null.
isBulk הוא true רק אם זה פריט שנקנה בכמות, כמו פאקט ניירות, פילטרים או שקיות ניקוטין.
אל תכתוב מטא כאן. המטא נכתב בשלב נפרד.`,
      },
    ],
  });
}

// --- מטא SEO, בקריאה נפרדת עם הכללים שלו ---

export async function writeMeta({ name, description, price, productKind, isBulk }) {
  const priceNote = price
    ? `מחיר המוצר: ${price} ₪`
    : 'אין מחיר. כתוב את הכותרת בלי מחיר, וציין בהערות שחסר מחיר.';

  return callClaudeJson({
    system: META_RULES,
    maxTokens: 1200,
    messages: [
      {
        role: 'user',
        content: `שם המוצר: ${name}
סוג המוצר: ${productKind || 'לא ידוע'}
${priceNote}
פריט שנקנה בכמות: ${isBulk ? 'כן' : 'לא'}

התיאור של המוצר:
${description}

החזר JSON:
{
  "metaTitle": "הכותרת",
  "metaDescription": "התיאור",
  "titleLength": 0,
  "descriptionLength": 0,
  "angle": "משפט אחד, למה זה ינצח את המתחרים"
}

titleLength ו-descriptionLength הם ספירת התווים בפועל. ודא שהם בטווח לפני שאתה מחזיר.`,
      },
    ],
  });
}

// תיקון תוכן לפי הערה חופשית
export async function reviseProductContent(current, instruction) {
  return callClaudeJson({
    system: DESCRIPTION_RULES,
    maxTokens: 3000,
    messages: [
      {
        role: 'user',
        content: `זה התוכן הנוכחי:
${JSON.stringify(current, null, 2)}

שמעון ביקש: ${instruction}

החזר את אותו מבנה JSON, מתוקן.`,
      },
    ],
  });
}

// --- זיהוי סוג הקובץ ---
// טלגרם מגיש קבצים כ-application/octet-stream, ו-Claude ו-Gemini דוחים את זה.
// מזהים לפי חתימת הבתים הראשונים, ואם לא זיהינו, לפי הסיומת.

function sniffMime(buffer, url = '', fallback = 'image/jpeg') {
  const head = buffer.subarray(0, 12);

  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head[0] === 0x89 && head[1] === 0x50) return 'image/png';
  if (head[0] === 0x47 && head[1] === 0x49) return 'image/gif';
  if (head.subarray(0, 4).toString('ascii') === 'RIFF') {
    const kind = head.subarray(8, 12).toString('ascii');
    if (kind === 'WEBP') return 'image/webp';
    if (kind === 'WAVE') return 'audio/wav';
  }
  if (head.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return 'audio/mpeg';
  if (head.subarray(4, 8).toString('ascii') === 'ftyp') return 'audio/mp4';

  const ext = (url.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  const byExt = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp',
    oga: 'audio/ogg', ogg: 'audio/ogg', opus: 'audio/ogg',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
  }[ext];

  return byExt || fallback;
}

// מוריד קובץ ומחזיר אותו עם סוג אמין
async function fetchWithMime(url, fallback) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('לא הצלחתי להוריד את הקובץ.');

  const buffer = Buffer.from(await response.arrayBuffer());
  const declared = response.headers.get('content-type') || '';

  // סומכים על מה שהשרת אמר רק אם זה באמת סוג מדיה
  const trusted = /^(image|audio)\/(jpeg|png|gif|webp|ogg|mpeg|mp4|wav)$/.test(declared);

  return { buffer, mimeType: trusted ? declared : sniffMime(buffer, url, fallback) };
}

// --- קריאת תמונות ---

async function imageBlock(imageUrl) {
  const { buffer, mimeType } = await fetchWithMime(imageUrl, 'image/jpeg');

  return {
    type: 'image',
    source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') },
  };
}

export async function describeProductImage(imageUrl) {
  return callClaude({
    system: VISION_RULES,
    maxTokens: 800,
    messages: [
      {
        role: 'user',
        content: [await imageBlock(imageUrl), { type: 'text', text: 'מה אתה רואה?' }],
      },
    ],
  });
}

// קריאת צילום מדף לעדכון מלאי
export async function readShelfPhoto(imageUrl, knownProducts = []) {
  const system = `${SHELF_RULES}

המוצרים שקיימים באתר:
${knownProducts.map((p) => `- ${p.name}`).join('\n')}

התאם כל מוצר שאתה מזהה לשם מהרשימה. אם אין התאמה טובה, סמן כלא ודאי.`;

  return callClaudeJson({
    system,
    maxTokens: 2000,
    messages: [
      {
        role: 'user',
        content: [
          await imageBlock(imageUrl),
          {
            type: 'text',
            text: `החזר JSON:
{ "items": [ { "name": "שם מהרשימה", "quantity": 12, "uncertain": false } ] }`,
          },
        ],
      },
    ],
  });
}

// --- פירוק רשימת מלאי חופשית ---

export async function parseStockList(text, knownProducts = []) {
  const system = `אתה מפרק רשימת עדכון מלאי שנאמרה בעברית חופשית.

המוצרים שקיימים באתר:
${knownProducts.map((p) => `- ${p.name}`).join('\n')}

התאם כל פריט לשם מהרשימה. אם אין התאמה ברורה, סמן כלא ודאי.`;

  return callClaudeJson({
    system,
    maxTokens: 1500,
    messages: [
      {
        role: 'user',
        content: `הרשימה: ${text}

החזר JSON:
{ "items": [ { "name": "שם מהרשימה", "quantity": 50, "uncertain": false } ] }`,
      },
    ],
  });
}

// --- Gemini: קריאה שעובדת עם שני פורמטי המפתח ---
// גוגל עברה ממפתחות שמתחילים ב-AIza למפתחות שמתחילים ב-AQ.
// הישנים נשלחים ככותרת x-goog-api-key, החדשים לפעמים דורשים Bearer.
// מנסים את הדרך הרגילה, ואם חוזר 401 מנסים את השנייה.

async function callGemini(model, body) {
  if (!config.ai.geminiKey) {
    throw new Error('חסר מפתח של Gemini. הוסף GEMINI_API_KEY בהגדרות השרת.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const key = config.ai.geminiKey;

  const attempts = [
    { 'x-goog-api-key': key },
    { Authorization: `Bearer ${key}` },
  ];

  let lastError = '';

  for (const authHeader of attempts) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok) return data;

    lastError = data?.error?.message || `HTTP ${response.status}`;

    // רק שגיאת הרשאה מצדיקה ניסיון בדרך השנייה
    if (response.status !== 401 && response.status !== 403) break;
  }

  throw new Error(`Gemini: ${lastError}`);
}

// --- Gemini: תמלול הקלטות ---

export async function transcribe(audioUrl) {
  const { buffer, mimeType } = await fetchWithMime(audioUrl, 'audio/ogg');

  const data = await callGemini(GEMINI_TEXT_MODEL, {
    contents: [
      {
        parts: [
          { text: 'תמלל את ההקלטה הזו לעברית. החזר רק את התמלול, בלי הסברים.' },
          { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
        ],
      },
    ],
  });

  await recordSpend({
    kind: 'transcribe',
    inputTokens: data.usageMetadata?.promptTokenCount || 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
  });

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

  if (!text) throw new Error('לא הצלחתי לתמלל את ההקלטה.');

  return text;
}

// --- Gemini: עריכת תמונות מוצר ---

// שני מסלולי פרומפטים. שמעון משפר אותם ומחליף כאן.
export const IMAGE_PROMPTS = {
  product: `צלם מחדש את המוצר הזה כתמונת מוצר לחנות מקוונת.
רקע נקי ואחיד, תאורה רכה ואחידה, בלי צללים חדים.
המוצר במרכז, חד לגמרי, בפרופורציות אמיתיות.
אל תשנה את המוצר עצמו, את הצבע שלו ואת הטקסט שעליו.`,

  clothing: {
    shirt: `צלם מחדש את הפריט הזה כתמונת מוצר.
הצג אותו פרוס ישר מלמעלה, בלי קמטים, על רקע נקי ואחיד.
שמור על הצבע המדויק ועל ההדפס כפי שהם.`,

    pants: `צלם מחדש את הפריט הזה כתמונת מוצר.
הצג אותו מקופל בצורה מסודרת על רקע נקי ואחיד.
שמור על הצבע המדויק ועל הפרטים כפי שהם.`,

    pajama: `צלם מחדש את הפריט הזה כתמונת מוצר.
הצג את הסט פרוס בצורה מסודרת על רקע נקי ואחיד, כך שרואים את שני החלקים.
שמור על הצבע המדויק ועל ההדפס כפי שהם.`,
  },
};

export async function generateProductImage(imageUrl, { kind = 'product', clothingType = 'shirt', correctionHint = '' } = {}) {
  const basePrompt =
    kind === 'clothing'
      ? IMAGE_PROMPTS.clothing[clothingType] || IMAGE_PROMPTS.clothing.shirt
      : IMAGE_PROMPTS.product;

  // ההערה של שמעון נדבקת בסוף, כמו correctionHint ב-AI Studio
  const prompt = correctionHint ? `${basePrompt}\n\n${correctionHint}` : basePrompt;

  const { buffer, mimeType } = await fetchWithMime(imageUrl, 'image/jpeg');

  const data = await callGemini(GEMINI_IMAGE_MODEL, {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
        ],
      },
    ],
  });

  await recordSpend({ kind: 'image', images: 1 });

  const part = (data.candidates?.[0]?.content?.parts || []).find((p) => p.inline_data || p.inlineData);
  const inline = part?.inline_data || part?.inlineData;

  if (!inline?.data) throw new Error('Gemini לא החזיר תמונה.');

  return {
    buffer: Buffer.from(inline.data, 'base64'),
    mimeType: inline.mime_type || inline.mimeType || 'image/png',
  };
}

// --- שמירת משוב על תמונות, לשיפור הפרומפטים ---

export async function saveImageFeedback({ productName, beforeUrl, note, afterUrl }) {
  try {
    await supabase.from('bot_image_feedback').insert({
      product_name: productName,
      before_url: beforeUrl,
      note,
      after_url: afterUrl,
    });
  } catch (error) {
    console.error('שמירת המשוב נכשלה:', error.message);
  }
}

// --- הבנת כוונה מטקסט חופשי ---
// כל הודעה שאינה כפתור עוברת כאן. קלוד מחזיר מה הוא הבין,
// והבוט מציג את זה לאישור לפני שהוא נוגע באתר.

export async function readIntent(text, { products = [], recentOrders = [] } = {}) {
  const system = `אתה מתרגם בקשות בעברית חופשית לפעולות בחנות של GOA.

הפעולות האפשריות:
- stock_in: לסמן מוצר כזמין במלאי
- stock_out: לסמן מוצר כאזל
- stock_qty: לקבוע כמות מדויקת
- product_info: להציג את מצב המוצר בלי לשנות כלום
- orders_pending: להציג הזמנות שממתינות לאריזה
- order_question: שאלה על הזמנה מסוימת או על ההזמנות
- sold_out_report: להציג מוצרים שנמכרו ואזלו
- new_product: להתחיל יצירת מוצר חדש
- unknown: לא הבנת מה רוצים

המוצרים שנמצאו בחנות לפי החיפוש:
${products.length ? products.map((p) => `- ${p.name} (מזהה ${p.id})`).join('\n') : '(לא נמצאו מוצרים מתאימים)'}

כללים:
- בחר productId רק מתוך הרשימה למעלה. אם אין התאמה ברורה, השאר null.
- אם המשתמש מזכיר מוצר שלא ברשימה, זה unknown עם הסבר.
- confidence הוא מספר בין 0 ל-1.`;

  return callClaudeJson({
    system,
    maxTokens: 800,
    messages: [
      {
        role: 'user',
        content: `הבקשה: ${text}

${recentOrders.length ? `הזמנות אחרונות:\n${JSON.stringify(recentOrders)}` : ''}

החזר JSON:
{
  "action": "אחת מהפעולות",
  "productId": null,
  "productName": "השם כפי שמופיע ברשימה, או null",
  "quantity": null,
  "confidence": 0.9,
  "summary": "משפט אחד בעברית: מה אתה עומד לעשות",
  "question": "אם לא הבנת, מה לשאול את שמעון. אחרת null"
}`,
      },
    ],
  });
}

// --- שאלות חופשיות על הזמנות ---

export async function answerOrderQuestion(question, orders) {
  return callClaude({
    system: `אתה עונה לשמעון על שאלות לגבי ההזמנות בחנות שלו.
ענה קצר ולעניין, בעברית. אם המידע לא נמצא בנתונים, תגיד שלא מצאת.`,
    maxTokens: 1000,
    messages: [
      {
        role: 'user',
        content: `ההזמנות האחרונות:
${JSON.stringify(orders, null, 2)}

השאלה: ${question}`,
      },
    ],
  });
}
