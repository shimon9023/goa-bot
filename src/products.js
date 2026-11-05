// מודול מוצר חדש ווריאציה למוצר קיים.
// זרימה: תמונה והקלטה, תמלול, כתיבת תוכן, מסך עריכה, תמונות, פרסום.

import { randomUUID } from 'node:crypto';

import * as woo from './woo.js';
import * as db from './db.js';
import { supabase } from './db.js';
import * as ai from './ai.js';
import * as competitors from './competitors.js';
import * as imagestore from './imagestore.js';
import * as google from './google.js';
import * as warehouse from './warehouse.js';
import * as attributes from './attributes.js';
import * as style from './style.js';
import * as card from './card.js';
import * as metaCheck from './meta-check.js';
import { config } from './config.js';
import {
  sendMessage,
  sendPhoto,
  sendMediaGroup,
  inlineKeyboard,
  button,
  webAppButton,
  getFile,
  fileUrl,
} from './telegram.js';

// --- טיוטות ---

export async function saveDraft(draftId, userId, content, images = []) {
  const { error } = await supabase.from('bot_product_drafts').upsert(
    {
      id: draftId,
      user_id: String(userId),
      content,
      images,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );

  if (error) {
    console.error('שמירת טיוטה נכשלה:', error.message);
    throw new Error(`שמירת הטיוטה נכשלה: ${error.message}`);
  }

  return draftId;
}

export async function getDraft(draftId) {
  const { data, error } = await supabase
    .from('bot_product_drafts')
    .select('*')
    .eq('id', draftId)
    .maybeSingle();

  if (error) {
    console.error('קריאת טיוטה נכשלה:', error.message);
    throw new Error(`קריאת הטיוטה נכשלה: ${error.message}`);
  }

  return data || null;
}

export async function deleteDraft(draftId) {
  const { error } = await supabase.from('bot_product_drafts').delete().eq('id', draftId);
  if (error) console.error('מחיקת טיוטה נכשלה:', error.message);
}

// טיוטה אחרונה שנשארה פתוחה, כדי להציע להמשיך ממנה
export async function openDraftFor(userId) {
  const { data, error } = await supabase
    .from('bot_product_drafts')
    .select('id, content')
    .eq('user_id', String(userId))
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  return { id: data.id, name: data.content?.name || 'מוצר בלי שם' };
}

// --- התחלת מוצר חדש ---

export async function startNewProduct(chatId, userId) {
  await db.setState(userId, {
    module: 'product',
    mode: 'new',
    awaiting: 'input',
    photos: [],
    spoken: '',
  });

  await sendMessage(
    chatId,
    [
      '<b>מוצר חדש</b>',
      '',
      'שלח תמונה של המוצר והקלטה קולית עם מה שאתה יודע עליו.',
      'אפשר כמה תמונות, ואפשר גם לכתוב בטקסט במקום להקליט.',
      '',
      'כשסיימת, לחץ "מוכן".',
    ].join('\n'),
    { reply_markup: inlineKeyboard([[button('מוכן', 'prod:ready')]]) }
  );
}

export async function startVariation(chatId, userId) {
  await db.setState(userId, { module: 'product', mode: 'variation', awaiting: 'parent' });

  await sendMessage(chatId, 'לאיזה מוצר להוסיף וריאציה? כתוב את השם או שלח הקלטה.');
}

// --- קליטת תמונות והקלטות ---

export async function collectPhoto(userId, photoSizes) {
  const state = await db.getState(userId);
  if (state?.module !== 'product') return false;

  // טלגרם שולח כמה גדלים, לוקחים את הגדול ביותר.
  // שומרים את מזהה הקובץ ולא את הקישור: הקישור מכיל את הטוקן של הבוט
  // והוא פג תוקף אחרי כשעה.
  const largest = photoSizes[photoSizes.length - 1];

  state.photos = [...(state.photos || []), largest.file_id];
  await db.setState(userId, state);

  return true;
}

// ממיר מזהה קובץ לקישור טרי. נקרא רק ברגע השימוש.
export async function resolvePhotoUrl(fileId) {
  // תאימות לאחור לטיוטות ישנות ששמרו קישור מלא
  if (String(fileId).startsWith('http')) return fileId;

  const file = await getFile(fileId);
  return fileUrl(file.file_path);
}

export async function collectVoice(userId, voice) {
  const state = await db.getState(userId);
  if (state?.module !== 'product') return null;

  const file = await getFile(voice.file_id);
  const text = await ai.transcribe(fileUrl(file.file_path));

  state.spoken = [state.spoken, text].filter(Boolean).join('\n');
  await db.setState(userId, state);

  return text;
}

export async function collectText(userId, text) {
  const state = await db.getState(userId);
  if (state?.module !== 'product') return false;

  state.spoken = [state.spoken, text].filter(Boolean).join('\n');
  await db.setState(userId, state);

  return true;
}

// --- עיבוד: מה שנאסף הופך לתוכן מוצר ---

export async function buildDraft(chatId, userId) {
  const state = await db.getState(userId);

  if (!state?.photos?.length && !state?.spoken) {
    await sendMessage(chatId, 'לא קיבלתי תמונה ולא הקלטה. שלח משהו ואז לחץ "מוכן".');
    return;
  }

  const settings = await db.getSettings();
  await ai.assertWithinBudget(settings);

  await card.show(chatId, userId, 'עובד על זה, זה לוקח כמה שניות.');

  // קוראים את כל התמונות יחד, כדי לזהות גם וריאציות.
  // נותנים לקלוד את התכונות שכבר קיימות באתר, כדי שיבחר מתוכן.
  let vision = null;
  let imageDescription = '';

  if (state.photos?.length) {
    try {
      const [urls, siteAttributes] = await Promise.all([
        Promise.all(state.photos.map(resolvePhotoUrl)),
        attributes.forPrompt().catch(() => []),
      ]);

      vision = await ai.describeProductImages(urls, { attributes: siteAttributes });

      imageDescription = [
        vision.overall,
        vision.brand ? `מותג: ${vision.brand}` : '',
        vision.model ? `דגם: ${vision.model}` : '',
        vision.looksLikeVariants
          ? `נראה שזה מוצר אחד ב-${vision.perImage?.length || 0} גרסאות, לפי ${vision.attributeName || 'מאפיין'}`
          : '',
      ].filter(Boolean).join('\n');
    } catch (error) {
      console.error('קריאת התמונות נכשלה:', error.message);
    }
  }

  // מחקר באינטרנט, כדי למלא מה שלא רואים בתמונה
  let webContext = '';
  const researchName = [vision?.brand, vision?.model].filter(Boolean).join(' ');

  if (researchName) {
    webContext = await ai.researchProduct(researchName, state.spoken || '');
  }

  const [categories, tags] = await Promise.all([woo.getCategories(), woo.getTags()]);

  // דוגמאות כתיבה מהמוצרים הקיימים. קודם מנחשים קטגוריה גסה
  // מתוך מה שנאמר ומה שנראה, רק כדי למשוך דוגמאות רלוונטיות.
  let guessed = null;
  let styleExamples = '';

  try {
    guessed = guessCategory(categories, `${state.spoken || ''} ${imageDescription}`);
    styleExamples = style.asPromptBlock(await style.examplesFor(guessed, 4));
  } catch (error) {
    console.error('לימוד הסגנון נכשל:', error.message);
  }

  let content = await ai.writeProductContent({
    spokenText: state.spoken,
    imageDescription,
    categories,
    tags,
    webContext,
    styleExamples,
  });

  // מעבר שני: עכשיו הקטגוריה האמיתית ידועה. אם היא שונה ממה שניחשנו,
  // או שלא היו לנו דוגמאות בכלל, כותבים מחדש בסגנון הנכון.
  const chosen = content.categories?.[0] || null;

  if (chosen && (!styleExamples || chosen !== guessed)) {
    try {
      const examples = await style.examplesFor(chosen, 4);

      if (examples.length) {
        const restyled = await ai.restyleProductContent(content, style.asPromptBlock(examples));
        content = { ...content, ...restyled };
      }
    } catch (error) {
      console.error('התאמת הסגנון נכשלה:', error.message);
    }
  }

  // המטא לא נכתב כאן. הוא נכתב אחרי שהמחיר נקבע.
  const meta = {};

  // מחקר מתחרים לפי הקטגוריה הראשונה שנבחרה
  let research = null;
  try {
    research = await competitors.researchPrice(content.name, content.categories?.[0] || null);
  } catch (error) {
    console.error('מחקר המתחרים נכשל:', error.message);
  }

  const draftId = state.draftId || randomUUID();

  const variants = buildVariantPlan(vision, state.photos || []);

  // מצמידים את הוריאציות לתכונה הגלובלית שקלוד בחר
  let attribute = null;
  if (variants.length) {
    try {
      attribute = await attributes.find(vision?.attributeName);
    } catch (error) {
      console.error('איתור התכונה נכשל:', error.message);
    }
  }

  await saveDraft(
    draftId,
    userId,
    {
      ...content,
      ...meta,
      research,
      variants,
      attribute: attribute
        ? { id: attribute.id, name: attribute.name, slug: attribute.slug }
        : null,
      attributeReason: vision?.attributeReason || '',
      // כשהמוצר הגיע מרשימת המחסן, זוכרים לאיזו שורה לחזור אחרי הפרסום
      warehouse: state.warehouse || null,
      stockFromUser: state.stockFromUser ?? null,
    },
    state.photos || []
  );

  // שומרים את התמונות במצב. בלי זה תיקון בהקלטה בנה טיוטה בלי תמונות.
  await db.setState(userId, {
    module: 'product',
    mode: state.mode,
    draftId,
    photos: state.photos || [],
    spoken: state.spoken || '',
    warehouse: state.warehouse || null,
  });

  await showSummary(chatId, draftId);
}

// --- התמצית ---
// מוצגת אחרי הבנייה וגם אחרי כל תיקון, כדי שתמיד רואים את המצב העדכני.

export async function showSummary(chatId, draftId) {
  const draft = await getDraft(draftId);

  if (!draft) {
    await sendMessage(chatId, 'הטיוטה לא נמצאה.');
    return;
  }

  const content = draft.content;
  const variants = content.variants || [];
  const uncertain = variants.filter((variant) => !variant.certain);

  const asList = (value) => (Array.isArray(value) ? value : value ? [value] : []);
  const questions = asList(content.questions);

  // שורות ספורות בלבד. כל הפרטים מחכים במסך העריכה.
  const lines = [`<b>${content.name || 'בלי שם'}</b>`];

  const facts = [
    content.categories?.[0] || null,
    variants.length ? `${variants.length} וריאציות · ${content.attribute?.name || 'בלי תכונה'}` : null,
    content.priceFromUser ? `${content.priceFromUser} ₪` : null,
  ].filter(Boolean);

  if (facts.length) lines.push(facts.join(' · '));

  // רק מה שחוסם מוצג כאן
  if (uncertain.length) lines.push(`❓ ${uncertain.length} וריאציות לא ברורות`);
  if (!content.attribute && variants.length) lines.push('⚠️ לא מצאתי תכונה מתאימה באתר');

  if (questions.length) {
    lines.push('');
    lines.push(...questions.slice(0, 3).map((question) => `❓ ${question}`));
  }

  const rows = [];

  // וריאציה שלא קראתי בוודאות חוסמת. חייבים לסגור אותה קודם.
  if (uncertain.length) {
    rows.push([button(`${uncertain.length} וריאציות לא ברורות, בוא נסגור`, `prod:ask:${draftId}`)]);
  }

  rows.push([button('ייצר תמונות ופתח מוצר', `prod:go:new:${draftId}`)]);
  rows.push([button('פתח מוצר', `prod:go:keep:${draftId}`)]);

  await card.show(chatId, draft.user_id, lines.filter((line) => line !== null).join('\n'), {
    reply_markup: inlineKeyboard(rows),
  });

  // כל טקסט או הקלטה מכאן ואילך הם תיקון, בלי צורך בכפתור
  const state = (await db.getState(draft.user_id)) || {};
  await db.setState(draft.user_id, { ...state, module: 'product', draftId, awaiting: 'revise' });
}

// --- תכנון וריאציות ---
// מצמיד כל תמונה לערך שנקרא ממנה. תמונה שלא זוהתה נשארת בלי ערך,
// ושמעון משלים אותה.

function buildVariantPlan(vision, photos) {
  if (!vision?.looksLikeVariants || !Array.isArray(vision.perImage)) return [];
  if (vision.perImage.length < 2) return [];

  return vision.perImage
    .map((item) => ({
      value: item.label || null,
      raw: item.raw || null,
      certain: Boolean(item.certain && item.label),
      photo: photos[(item.index || 1) - 1] || null,
    }))
    .filter((v) => v.photo);
}

// ניחוש גס של הקטגוריה, רק כדי למשוך דוגמאות כתיבה מהאזור הנכון.
// הקטגוריה האמיתית נבחרת על ידי קלוד בהמשך.
//
// התאמה מילה במילה לא עובדת בעברית: "מאפרת קריסטל" לא מכיל
// את המילה "מאפרות". לכן משווים לפי תחילת המילה.
function stem(word) {
  return String(word)
    .replace(/[^֐-׿a-zA-Z0-9]/g, '')
    .slice(0, 4)
    .toLowerCase();
}

function guessCategory(categories, text) {
  const words = String(text || '')
    .split(/\s+/)
    .map(stem)
    .filter((word) => word.length >= 3);

  if (!words.length) return null;

  const scored = categories
    .map((category) => {
      const parts = String(category.name || '').split(/\s+/).map(stem).filter((p) => p.length >= 3);
      if (!parts.length) return null;

      // "מצת" מול "מצתים": אחד תחילית של השני
      const hits = parts.filter((part) =>
        words.some((word) => word.startsWith(part) || part.startsWith(word))
      ).length;

      return hits ? { name: category.name, hits, parts: parts.length } : null;
    })
    .filter(Boolean)
    // כמה מילים התאימו קודם, ואז הקטגוריה הספציפית יותר
    .sort((a, b) => b.hits - a.hits || b.parts - a.parts);

  return scored[0]?.name || null;
}

// --- סגירת וריאציות שלא נקראו בוודאות ---
// שולח את התמונה הספציפית ומבקש את הערך. אין ניחושים.

export async function askNextUncertain(chatId, userId, draftId) {
  const draft = await getDraft(draftId);
  if (!draft) return sendMessage(chatId, 'הטיוטה לא נמצאה.');

  const variants = draft.content.variants || [];
  const index = variants.findIndex((variant) => !variant.certain);

  if (index === -1) {
    await sendMessage(chatId, 'כל הוריאציות ברורות.');
    await showSummary(chatId, draftId);
    return;
  }

  const variant = variants[index];
  const attributeName = draft.content.attribute?.name || 'הערך';

  await db.setState(userId, {
    ...(await db.getState(userId)),
    module: 'product',
    draftId,
    awaiting: 'variantValue',
    variantIndex: index,
  });

  try {
    // מזהה הקובץ, לא כתובת. ראה ההערה ב-startFromWarehouseRow.
    if (variant.photo) await sendPhoto(chatId, variant.photo);
  } catch (error) {
    console.error('שליחת תמונת וריאציה נכשלה:', error.message);
  }

  await sendMessage(
    chatId,
    [
      `<b>וריאציה ${index + 1} מתוך ${variants.length}</b>`,
      '',
      variant.value ? `ניחשתי "${variant.value}" אבל אני לא בטוח.` : 'לא הצלחתי לקרוא מה כתוב.',
      variant.raw ? `מה שראיתי בתמונה: ${variant.raw}` : '',
      '',
      `מה ${attributeName} של התמונה הזו? כתוב או הקלט.`,
    ].filter(Boolean).join('\n'),
    { reply_markup: inlineKeyboard([[button('לוותר על הוריאציה הזו', `prod:drop1:${draftId}`)]]) }
  );
}

export async function setVariantValue(chatId, userId, draftId, index, value) {
  const draft = await getDraft(draftId);
  if (!draft) return sendMessage(chatId, 'הטיוטה לא נמצאה.');

  const variants = [...(draft.content.variants || [])];
  if (!variants[index]) return askNextUncertain(chatId, userId, draftId);

  variants[index] = { ...variants[index], value: String(value).trim(), certain: true };

  await saveDraft(draftId, draft.user_id, { ...draft.content, variants }, draft.images);
  await askNextUncertain(chatId, userId, draftId);
}

export async function dropVariantAt(chatId, userId, draftId, index) {
  const draft = await getDraft(draftId);
  if (!draft) return sendMessage(chatId, 'הטיוטה לא נמצאה.');

  const variants = (draft.content.variants || []).filter((_, i) => i !== index);

  await saveDraft(draftId, draft.user_id, { ...draft.content, variants }, draft.images);
  await askNextUncertain(chatId, userId, draftId);
}

// --- שאלת המלאי בוריאציות ---

export async function askVariantStock(chatId, userId, draftId) {
  const draft = await getDraft(draftId);
  if (!draft) return false;

  const content = draft.content;
  const variants = content.variants || [];
  const quantity = content.stockQuantity ?? content.stockFromUser;

  // שואלים רק כשיש וריאציות וגם נאמר מלאי
  if (variants.length < 2 || quantity === null || quantity === undefined) return false;
  if (content.stockDecided) return false;

  await sendMessage(
    chatId,
    [
      `אמרת ${quantity} יחידות, ויש ${variants.length} וריאציות.`,
      '',
      'איך לנהל את המלאי?',
    ].join('\n'),
    {
      reply_markup: inlineKeyboard([
        [button(`${quantity} לכל וריאציה`, `prod:stk:each:${draftId}`)],
        [button(`לחלק את ${quantity} שווה בשווה`, `prod:stk:split:${draftId}`)],
        [button('בלי ניהול כמות', `prod:stk:none:${draftId}`)],
      ]),
    }
  );

  return true;
}

export async function applyVariantStock(chatId, userId, draftId, mode) {
  const draft = await getDraft(draftId);
  if (!draft) return sendMessage(chatId, 'הטיוטה לא נמצאה.');

  const content = draft.content;
  const variants = [...(content.variants || [])];
  const quantity = Number(content.stockQuantity ?? content.stockFromUser ?? 0);

  let updated = variants;
  let note = '';

  if (mode === 'each') {
    updated = variants.map((variant) => ({ ...variant, quantity }));
    note = `${quantity} יחידות לכל וריאציה.`;
  } else if (mode === 'split') {
    const base = Math.floor(quantity / variants.length);
    let left = quantity - base * variants.length;

    updated = variants.map((variant) => {
      const extra = left > 0 ? 1 : 0;
      left -= extra;
      return { ...variant, quantity: base + extra };
    });

    note = `חולק: ${updated.map((v) => `${v.value} ${v.quantity}`).join(', ')}`;
  } else {
    updated = variants.map((variant) => ({ ...variant, quantity: null }));
    note = 'בלי ניהול כמות. כולן קיימות במלאי.';
  }

  await saveDraft(
    draftId,
    draft.user_id,
    { ...content, variants: updated, stockDecided: true, stockQuantity: mode === 'none' ? null : content.stockQuantity },
    draft.images
  );

  await sendMessage(chatId, note);
  await showSummary(chatId, draftId);
}

// --- מטא, אחרי שהמחיר נקבע ---
// נכתב עם כללי הסקיל, ואז נבדק בקוד. מה שלא עובר חוזר לתיקון פעם אחת.

export async function buildMeta(draftId) {
  const draft = await getDraft(draftId);
  if (!draft) return null;

  const content = draft.content;
  const price = content.priceFromUser;

  let meta = await ai.writeMeta({
    name: content.name,
    description: content.description,
    price,
    productKind: content.productKind,
    isBulk: content.isBulk,
  });

  let verdict = metaCheck.check({
    title: meta.metaTitle,
    description: meta.metaDescription,
    h1: content.name,
    price,
    isBulk: content.isBulk,
  });

  if (!verdict.ok) {
    console.error('המטא לא עבר בדיקה, מתקן:', verdict.problems.join(' | '));

    try {
      meta = await ai.writeMeta({
        name: content.name,
        description: content.description,
        price,
        productKind: content.productKind,
        isBulk: content.isBulk,
        problems: verdict.problems,
      });

      verdict = metaCheck.check({
        title: meta.metaTitle,
        description: meta.metaDescription,
        h1: content.name,
        price,
        isBulk: content.isBulk,
      });
    } catch (error) {
      console.error('תיקון המטא נכשל:', error.message);
    }
  }

  const updated = {
    ...content,
    metaTitle: meta.metaTitle || '',
    metaDescription: meta.metaDescription || '',
    metaProblems: verdict.ok ? [] : verdict.problems,
  };

  await saveDraft(draftId, draft.user_id, updated, draft.images);

  return { meta, verdict };
}

// --- המעבר לעריכה ---
// התמונות נוצרות ברקע בזמן שהוא עורך, כדי לא לבזבז את זמנו.

// שורת הכפתורים של המיני אפ. כשיש כבר מטא, נוסף כפתור שפותח
// ישר את מסך הצפייה, כדי לא לעבור שוב דרך העריכה.
function editorRow(draftId, content, label = 'פתח לעריכה') {
  const base = `${config.publicBaseUrl}/product/${draftId}`;
  const row = [webAppButton(label, base)];

  if (content?.metaTitle) row.push(webAppButton('צפייה', `${base}?view=preview`));

  return row;
}

export async function goToEditor(chatId, userId, draftId, mode) {
  const draft = await getDraft(draftId);
  if (!draft) return sendMessage(chatId, 'הטיוטה לא נמצאה.');

  // מלאי בוריאציות נסגר לפני שממשיכים
  if (await askVariantStock(chatId, userId, draftId)) return;


  if (mode === 'new') {
    await sendMessage(
      chatId,
      [
        'מתחיל לייצר את התמונות ברקע.',
        'אפשר להיכנס לעריכה עכשיו, והן יחכו לך בסוף.',
      ].join('\n'),
      { reply_markup: inlineKeyboard([editorRow(draftId, draft.content)]) }
    );

    // בכוונה בלי await: העריכה לא מחכה לתמונות
    generateAllImages(chatId, userId, draftId).catch((error) => {
      console.error('יצירת התמונות ברקע נכשלה:', error.message);
      sendMessage(chatId, `יצירת התמונות נכשלה: ${error.message}`).catch(() => {});
    });

    return;
  }

  await useOriginalImages(draftId);

  await sendMessage(chatId, 'משתמש בתמונות כמו שהן.', {
    reply_markup: inlineKeyboard([editorRow(draftId, draft.content)]),
  });
}

// --- תיקון בשפה חופשית ---

// כל טקסט חופשי עובר כאן קודם. בלי זה "ייצר את התמונות שנכשלו"
// נשלח לכתיבה מחדש של המוצר, וזה בדיוק מה שקרה.
export async function handleFreeText(chatId, userId, draftId, text) {
  const draft = await getDraft(draftId);

  if (!draft) {
    await sendMessage(chatId, 'הטיוטה לא נמצאה. אולי היא כבר פורסמה.');
    return;
  }

  const content = draft.content;
  const failed = content.failedImages || [];

  let intent = { action: 'revise', onlyFailed: false };

  try {
    intent = await ai.readProductIntent(text, {
      hasImages: Boolean(content.generatedImage),
      failedImages: failed,
    });
  } catch (error) {
    console.error('סיווג הבקשה נכשל, ממשיך כתיקון תוכן:', error.message);
  }

  if (intent.action === 'images') {
    await card.show(chatId, userId, intent.onlyFailed ? 'מייצר את מה שנכשל.' : 'מייצר תמונות.');
    await generateImage(chatId, userId, draftId, 'product', '', { onlyFailed: intent.onlyFailed });
    return;
  }

  if (intent.action === 'publish') {
    await sendMessage(chatId, 'הפרסום נעשה ממסך העריכה, אחרי שקבעת מחיר.', {
      reply_markup: inlineKeyboard([editorRow(draftId, content)]),
    });
    return;
  }

  await reviseDraft(chatId, userId, draftId, text);
}

export async function reviseDraft(chatId, userId, draftId, instruction) {
  const draft = await getDraft(draftId);

  if (!draft) {
    await sendMessage(chatId, 'הטיוטה לא נמצאה. אולי היא כבר פורסמה.');
    return;
  }

  await card.show(chatId, userId, 'מתקן.');

  const revised = await ai.reviseProductContent(draft.content, instruction);

  // תשובה לשאלות סוגרת אותן. מה שנשאר פתוח יוחזר על ידי קלוד.
  await saveDraft(
    draftId,
    userId,
    { ...draft.content, ...revised, questions: revised.questions || [] },
    draft.images
  );

  await showSummary(chatId, draftId);
}

// --- שלב התמונות ---

// אין יותר בחירה בין חולצה למכנסיים. הכל מוצרי עישון.
export async function startImageStep(chatId, userId, draftId) {
  const draft = await getDraft(draftId);

  if (!draft?.images?.length) {
    await sendMessage(chatId, 'אין תמונות לעבוד איתן. אפשר לפרסם בלי תמונה או לשלוח אחת עכשיו.', {
      reply_markup: inlineKeyboard([[button('פרסם בלי תמונה', `prod:publish:${draftId}`)]]),
    });
    return;
  }

  await generateImage(chatId, userId, draftId, 'product');
}

// יצירת כל התמונות, לריצה ברקע בזמן שהוא עורך
export async function generateAllImages(chatId, userId, draftId) {
  const draft = await getDraft(draftId);
  if (!draft?.images?.length) return;

  await generateImage(chatId, userId, draftId, 'product');
}

// שימוש בתמונות כמו שצולמו, בלי הודעה
export async function useOriginalImages(draftId) {
  const draft = await getDraft(draftId);
  if (!draft) return;

  const urls = await Promise.all((draft.images || []).map(resolvePhotoUrl));

  const variants = (draft.content.variants || []).map((variant, index) => ({
    ...variant,
    imageUrl: variant.imageUrl || urls[index] || null,
  }));

  await saveDraft(
    draftId,
    draft.user_id,
    {
      ...draft.content,
      generatedImage: urls[0] || null,
      extraImages: urls.slice(1),
      variants,
    },
    draft.images
  );
}

export async function generateImage(chatId, userId, draftId, kind, correctionHint = '', { onlyFailed = false } = {}) {
  const draft = await getDraft(draftId);
  if (!draft) {
    await sendMessage(chatId, 'הטיוטה לא נמצאה.');
    return;
  }

  const settings = await db.getSettings();
  await ai.assertWithinBudget(settings);

  const allVariants = (draft.content.variants || []).filter((v) => v.value);
  const isVariable = allVariants.length >= 2;

  // "ייצר את מה שנכשל" נוגע רק במה שאין לו תמונה, ולא דורס את מה שהצליח
  const variants = onlyFailed && isVariable
    ? allVariants.filter((variant) => !variant.imageUrl)
    : allVariants;

  if (onlyFailed && isVariable && !variants.length) {
    await sendMessage(chatId, 'לכל הוריאציות כבר יש תמונה.');
    return;
  }

  const total = isVariable ? variants.length : 1;

  await card.show(
    chatId,
    userId,
    total > 1
      ? `מייצר ${total} תמונות, אחת לכל וריאציה. זה ייקח כמה דקות.`
      : 'מייצר תמונה.'
  );

  const sources = isVariable ? variants.map((v) => v.photo) : [draft.images[0]];

  const produced = [];
  const failed = [];

  for (const [index, source] of sources.entries()) {
    try {
      const sourceUrl = await resolvePhotoUrl(source);

      const result = await ai.generateProductImage(sourceUrl, { correctionHint });

      // מגישים את התמונה מהשרת שלנו, וווקומרס ימשוך אותה.
      // העלאה ישירה לספריית המדיה חסומה למפתחות ווקומרס.
      const id = imagestore.put(result.buffer, result.mimeType);
      const url = imagestore.publicUrl(config.publicBaseUrl, id, result.mimeType);

      produced.push({ url, label: variants[index]?.value || null });
    } catch (error) {
      console.error(`יצירת תמונה ${index + 1} נכשלה:`, error.message);
      failed.push(variants[index]?.value || `תמונה ${index + 1}`);
    }
  }

  if (!produced.length) {
    await sendMessage(chatId, 'לא הצלחתי לייצר אף תמונה. אפשר לפרסם עם התמונות המקוריות.', {
      reply_markup: inlineKeyboard([[button('המשך בלי עריכה', `prod:imgskip:${draftId}`)]]),
    });
    return;
  }

  // התמונה הראשונה היא הראשית, והשאר נכנסות לגלריה ולווריאציות.
  // עוברים על כל הוריאציות ולא רק על אלה שייצרנו עכשיו,
  // כדי שהרצה חלקית לא תמחק תמונות שכבר קיימות.
  const updatedVariants = allVariants.map((v) => {
    const match = produced.find((p) => p.label === v.value);
    return match ? { ...v, imageUrl: match.url } : v;
  });

  const withImages = updatedVariants.filter((v) => v.imageUrl);

  const content = {
    ...draft.content,
    generatedImage: isVariable
      ? withImages[0]?.imageUrl || produced[0].url
      : produced[0].url,
    extraImages: isVariable
      ? withImages.slice(1).map((v) => v.imageUrl)
      : produced.slice(1).map((p) => p.url),
    variants: updatedVariants,
    // נשמר כדי ש"ייצר את מה שנכשל" יידע על מה לדבר
    failedImages: failed,
    imageKind: kind,
  };

  await saveDraft(draftId, userId, content, draft.images);

  if (correctionHint) {
    await ai.saveImageFeedback({
      productName: draft.content.name,
      beforeUrl: draft.content.generatedImage || '',
      note: correctionHint,
      afterUrl: produced[0].url,
    });
  }

  const caption = failed.length
    ? `${produced.length} מוכנות, ${failed.length} נכשלו: ${failed.join(', ')}`
    : `${produced.length} ${produced.length === 1 ? 'תמונה מוכנה' : 'תמונות מוכנות'}`;

  const rows = [];
  if (failed.length) rows.push([button(`נסה שוב את ${failed.length} שנכשלו`, `prod:redo:${draftId}`)]);
  rows.push([button('ייצר שוב הכל', `prod:regen:${kind}:${draftId}`), button('תקן לפי הערה', `prod:imgfix:${kind}:${draftId}`)]);

  const images = produced.map((item) => item.url);

  // גלריה אחת עם הכפתורים בהודעה אחת מתחתיה.
  // טלגרם לא מאפשר כפתורים על אלבום, אז זו הדרך היחידה לצמצם.
  try {
    if (images.length > 1) await sendMediaGroup(chatId, images, caption);
    else await sendPhoto(chatId, images[0], caption);
  } catch (error) {
    console.error('שליחת התמונות נכשלה:', error.message);
    await sendPhoto(chatId, images[0], caption).catch(() => {});
  }

  await card.release(userId);

  await sendMessage(chatId, 'התמונות מחכות לך במסך העריכה.', {
    reply_markup: inlineKeyboard([editorRow(draftId, draft.content), ...rows]),
  });
}

// ממשיכים בלי לערוך, עם התמונות שצולמו
export async function skipImageEditing(chatId, userId, draftId) {
  const draft = await getDraft(draftId);
  if (!draft) return;

  const urls = await Promise.all((draft.images || []).map(resolvePhotoUrl));

  await saveDraft(
    draftId,
    userId,
    { ...draft.content, generatedImage: urls[0] || null, extraImages: urls.slice(1) },
    draft.images
  );


  await sendMessage(chatId, 'ממשיך עם התמונות המקוריות.', {
    reply_markup: inlineKeyboard([editorRow(draftId, draft.content, 'פתח לעריכה ופרסום')]),
  });
}

// --- פרסום ---

export async function publish(chatId, userId, draftId, status) {
  const draft = await getDraft(draftId);

  if (!draft) {
    await sendMessage(chatId, 'הטיוטה לא נמצאה.');
    return;
  }

  const content = draft.content;

  const [allCategories, allTags] = await Promise.all([woo.getCategories(), woo.getTags()]);

  // רק קטגוריות ותגיות שקיימות באתר
  const categoryIds = (content.categories || [])
    .map((name) => allCategories.find((c) => c.name === name))
    .filter(Boolean)
    .map((c) => ({ id: c.id }));

  const tagIds = (content.tags || [])
    .map((name) => allTags.find((t) => t.name === name))
    .filter(Boolean)
    .map((t) => ({ id: t.id }));

  const variants = (content.variants || []).filter((v) => v.value);
  const isVariable = variants.length >= 2;

  // התכונה הגלובלית של האתר. בלעדיה הערכים לא מתחברים לכלום,
  // אז מוודאים שכל הערכים קיימים בה לפני שיוצרים את המוצר.
  let attribute = null;
  const newTerms = [];

  if (isVariable) {
    attribute = content.attribute?.id ? await attributes.find(content.attribute.name) : null;

    if (attribute) {
      const ensured = await attributes.ensureTerms(attribute, variants.map((v) => v.value));

      for (const term of ensured) {
        if (term.created) newTerms.push(term.name);
        // מיישרים את הערך לשם המדויק שקיים באתר
        const variant = variants.find((v) => v.value === term.value);
        if (variant) variant.value = term.name;
      }
    }
  }

  const attributeName = attribute?.name || content.attribute?.name || 'טעם';

  const payload = {
    name: content.name,
    type: isVariable ? 'variable' : 'simple',
    status: status === 'publish' ? 'publish' : 'draft',
    description: content.description || '',
    short_description: content.shortDescription || '',
    categories: categoryIds,
    tags: tagIds,
  };

  // במוצר עם וריאציות המלאי מנוהל בתוך הווריאציות
  if (!isVariable) {
    payload.manage_stock = content.stockQuantity !== undefined && content.stockQuantity !== null;
    payload.stock_quantity = content.stockQuantity ?? null;
    payload.stock_status = content.stockQuantity > 0 ? 'instock' : 'outofstock';

    if (content.priceFromUser) payload.regular_price = String(content.priceFromUser);
  }

  // התמונות: הראשית ואחריהן כל השאר
  const gallery = [];
  if (content.generatedImage) gallery.push({ src: content.generatedImage });
  for (const extra of content.extraImages || []) gallery.push({ src: extra });
  if (gallery.length) payload.images = gallery;

  // התכונה שלפיה נבנות הווריאציות.
  // כשיש תכונה גלובלית מעבירים את המזהה שלה, וכך המוצר מתחבר
  // לאותה תכונה שכל שאר המוצרים באתר משתמשים בה.
  if (isVariable) {
    payload.attributes = [
      attribute
        ? { id: attribute.id, visible: true, variation: true, options: variants.map((v) => v.value) }
        : { name: attributeName, visible: true, variation: true, options: variants.map((v) => v.value) },
    ];
  }

  const created = await woo.createProduct(payload);

  // יצירת הווריאציות עצמן
  let variantsCreated = 0;
  const variantsFailed = [];

  if (isVariable) {
    for (const variant of variants) {
      try {
        const hasQuantity = variant.quantity !== undefined && variant.quantity !== null;

        const fields = {
          attributes: [
            attribute
              ? { id: attribute.id, option: variant.value }
              : { name: attributeName, option: variant.value },
          ],
          manage_stock: hasQuantity,
          stock_quantity: hasQuantity ? variant.quantity : null,
          // בלי כמות הווריאציה פשוט קיימת במלאי
          stock_status: hasQuantity && variant.quantity <= 0 ? 'outofstock' : 'instock',
        };

        if (content.priceFromUser) fields.regular_price = String(content.priceFromUser);
        if (variant.imageUrl) fields.image = { src: variant.imageUrl };

        await woo.createVariation(created.id, fields);
        variantsCreated += 1;
      } catch (error) {
        console.error(`וריאציה "${variant.value}" נכשלה:`, error.message);
        variantsFailed.push(variant.value);
      }
    }
  }

  // מטא SEO של Yoast. דורש את הסניפט שפותח את ההרשאה באתר.
  let metaWarning = '';

  if (content.metaTitle || content.metaDescription) {
    try {
      await woo.setYoastMeta(created.id, content.metaTitle, content.metaDescription);
    } catch (error) {
      console.error('כתיבת המטא נכשלה:', error.message);
      metaWarning = [
        '',
        '⚠️ <b>המטא לא נשמר.</b> צריך להתקין את סניפט ההרשאה באתר.',
        'בינתיים, להעתקה ידנית ל-Yoast:',
        '',
        `<b>כותרת:</b> <code>${content.metaTitle || ''}</code>`,
        `<b>תיאור:</b> <code>${content.metaDescription || ''}</code>`,
      ].join('\n');
    }
  }

  await db.logAction({
    userId,
    action: status === 'publish' ? 'product_published' : 'product_drafted',
    target: String(created.id),
    after: { name: created.name, status: created.status },
  });

  // אם המוצר הגיע מרשימת המחסן, מסמנים אותו שם כנוצר
  let warehouseNote = '';

  if (content.warehouse?.rowNumber) {
    try {
      await google.markCreated(content.warehouse.rowNumber, created.permalink);
      warehouseNote = 'סומן כנוצר ברשימת המחסן.';
    } catch (error) {
      console.error('עדכון רשימת המחסן נכשל:', error.message);
      warehouseNote = '⚠️ המוצר נוצר, אבל לא הצלחתי לעדכן את הסטטוס בשיטס.';
    }
  }

  await deleteDraft(draftId);
  await db.clearState(userId);

  await sendMessage(
    chatId,
    [
      status === 'publish' ? '<b>המוצר באוויר</b>' : '<b>נשמר כטיוטה</b>',
      '',
      created.name,
      isVariable ? `${variantsCreated} וריאציות נוצרו` : '',
      variantsFailed.length ? `נכשלו: ${variantsFailed.join(', ')}` : '',
      created.permalink,
      warehouseNote,
      metaWarning,
    ].filter(Boolean).join('\n')
  );
}

// --- מוצר שמתחיל מרשימת המחסן ---
// התמונות והטקסט כבר קיימים, אז אין מה לאסוף. נכנסים ישר לעיבוד.

export async function startFromWarehouseRow(chatId, userId, row) {
  const photos = warehouse.rowFileIds(row);
  const brief = warehouse.rowBrief(row);

  if (!photos.length && !brief) {
    await sendMessage(chatId, 'השורה הזו ריקה. בחר אחרת מהרשימה.');
    return;
  }

  await db.setState(userId, {
    module: 'product',
    mode: 'new',
    awaiting: 'input',
    photos,
    spoken: brief,
    warehouse: { rowNumber: row.rowNumber, id: row.cells[google.COL.id] || '' },
  });

  // מראים קודם מה יש, ורק אז מתחילים לעבוד.
  // התמונות עצמן, כדי שיראה מה צולם לפני שהבוט משקיע זמן וכסף.
  // שולחים את מזהה הקובץ ולא כתובת. טלגרם מסרב למשוך תמונה
  // מכתובת שהיא שלו עצמו, ומחזיר "failed to get HTTP URL content".
  if (photos.length) {
    try {
      if (photos.length > 1) {
        await sendMediaGroup(chatId, photos.slice(0, 10), 'מהרשימה של המחסן');
      } else {
        await sendPhoto(chatId, photos[0], 'מהרשימה של המחסן');
      }
    } catch (error) {
      console.error('הצגת תמונות מהרשימה נכשלה:', error.message);
    }
  }

  await sendMessage(
    chatId,
    [
      '<b>מהרשימה</b>',
      '',
      warehouse.describeRow(row),
      '',
      photos.length ? `${photos.length} תמונות` : 'בלי תמונות',
      '',
      'יש לך מה להוסיף על המוצר? כתוב או הקלט עכשיו.',
      'אם לא, לחץ התחל.',
    ].join('\n'),
    { reply_markup: inlineKeyboard([[button('התחל', 'prod:ready')]]) }
  );
}

// --- מסך אישור הווריאציות ---

export async function showVariants(chatId, userId, draftId) {
  const draft = await getDraft(draftId);
  if (!draft) {
    await sendMessage(chatId, 'הטיוטה לא נמצאה.');
    return;
  }

  const variants = draft.content.variants || [];
  const attribute = draft.content.attribute?.name || 'טעם';

  if (!variants.length) {
    await sendMessage(chatId, 'לא זיהיתי וריאציות במוצר הזה.');
    return;
  }

  const unknown = variants.filter((v) => !v.certain).length;

  const lines = [
    `<b>${variants.length} וריאציות לפי ${attribute}</b>`,
    '',
    ...variants.map((v, i) =>
      v.certain ? `${i + 1}. ${v.value}` : `${i + 1}. ❓ ${v.value || 'לא הצלחתי לקרוא'}`
    ),
  ];

  if (unknown) {
    lines.push('', `<i>${unknown} לא ודאיות. אפשר להכתיב את הרשימה המלאה ואני אחליף.</i>`);
  }

  lines.push('', 'מאשר?');

  await db.setState(userId, {
    ...(await db.getState(userId)),
    module: 'product',
    draftId,
    awaiting: 'variants',
  });

  await sendMessage(chatId, lines.join('\n'), {
    reply_markup: inlineKeyboard([
      [button('כן, זה נכון', `prod:varsok:${draftId}`)],
      [button('אכתיב את הרשימה', `prod:varsedit:${draftId}`)],
      [button('בלי וריאציות', `prod:varsoff:${draftId}`)],
    ]),
  });
}

// שמעון הכתיב רשימת ערכים, מחליפים לפי הסדר
export async function replaceVariantValues(chatId, userId, draftId, text) {
  const draft = await getDraft(draftId);
  if (!draft) {
    await sendMessage(chatId, 'הטיוטה לא נמצאה.');
    return;
  }

  const values = text
    .split(/[,\n]/)
    .map((v) => v.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);

  const variants = draft.content.variants || [];

  if (values.length !== variants.length) {
    await sendMessage(
      chatId,
      `קיבלתי ${values.length} ערכים אבל יש ${variants.length} תמונות. תשלח רשימה באותו אורך, לפי סדר התמונות.`
    );
    return;
  }

  const updated = variants.map((v, i) => ({ ...v, value: values[i], certain: true }));

  await saveDraft(draftId, userId, { ...draft.content, variants: updated }, draft.images);
  await showVariants(chatId, userId, draftId);
}

export async function dropVariants(chatId, userId, draftId) {
  const draft = await getDraft(draftId);
  if (!draft) return;

  await saveDraft(draftId, userId, { ...draft.content, variants: [] }, draft.images);
  await db.clearState(userId);

  await sendMessage(chatId, 'בסדר, מוצר רגיל בלי וריאציות.', {
    reply_markup: inlineKeyboard([[button('עבור לתמונות', `prod:images:${draftId}`)]]),
  });
}
