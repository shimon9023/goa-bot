// המוח: Claude לכתיבה והבנת תמונות, Gemini לתמלול הקלטות וליצירת תמונות.
// כל קריאה נרשמת כדי שתקרת ההוצאה החודשית תדע מה קרה.

import { config } from './config.js';
import { supabase } from './db.js';
import { WRITING_RULES, VISION_RULES, SHELF_RULES } from './writing-rules.js';

const CLAUDE_MODEL = 'claude-sonnet-5-5';
const GEMINI_TEXT_MODEL = 'gemini-2.5-flash';
const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';

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
  const system = `${WRITING_RULES}

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
  "shortDescription": "תיאור קצר",
  "description": "תיאור מלא, עם פסקאות מופרדות בשורה ריקה",
  "metaTitle": "מטא כותרת",
  "metaDescription": "מטא תיאור",
  "priceFromUser": null,
  "notes": "דברים שלא היית בטוח לגביהם"
}

אם שמעון אמר מחיר, שים אותו ב-priceFromUser כמספר. אם לא אמר, השאר null.`,
      },
    ],
  });
}

// תיקון תוכן לפי הערה חופשית
export async function reviseProductContent(current, instruction) {
  return callClaudeJson({
    system: WRITING_RULES,
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

// --- קריאת תמונות ---

async function imageBlock(imageUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error('לא הצלחתי להוריד את התמונה.');

  const buffer = Buffer.from(await response.arrayBuffer());
  const mediaType = response.headers.get('content-type') || 'image/jpeg';

  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') },
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

// --- Gemini: תמלול הקלטות ---

export async function transcribe(audioUrl) {
  if (!config.ai.geminiKey) {
    throw new Error('חסר מפתח של Gemini. הוסף GEMINI_API_KEY בהגדרות השרת.');
  }

  const audio = await fetch(audioUrl);
  if (!audio.ok) throw new Error('לא הצלחתי להוריד את ההקלטה.');

  const buffer = Buffer.from(await audio.arrayBuffer());
  const mimeType = audio.headers.get('content-type') || 'audio/ogg';

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${config.ai.geminiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: 'תמלל את ההקלטה הזו לעברית. החזר רק את התמלול, בלי הסברים.' },
              { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
            ],
          },
        ],
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Gemini: ${data?.error?.message || response.status}`);
  }

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
  if (!config.ai.geminiKey) {
    throw new Error('חסר מפתח של Gemini. הוסף GEMINI_API_KEY בהגדרות השרת.');
  }

  const basePrompt =
    kind === 'clothing'
      ? IMAGE_PROMPTS.clothing[clothingType] || IMAGE_PROMPTS.clothing.shirt
      : IMAGE_PROMPTS.product;

  // ההערה של שמעון נדבקת בסוף, כמו correctionHint ב-AI Studio
  const prompt = correctionHint ? `${basePrompt}\n\n${correctionHint}` : basePrompt;

  const source = await fetch(imageUrl);
  if (!source.ok) throw new Error('לא הצלחתי להוריד את התמונה המקורית.');

  const buffer = Buffer.from(await source.arrayBuffer());
  const mimeType = source.headers.get('content-type') || 'image/jpeg';

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${config.ai.geminiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
            ],
          },
        ],
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Gemini: ${data?.error?.message || response.status}`);
  }

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
