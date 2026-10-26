// מודול מוצר חדש ווריאציה למוצר קיים.
// זרימה: תמונה והקלטה, תמלול, כתיבת תוכן, מסך עריכה, תמונות, פרסום.

import { randomUUID } from 'node:crypto';

import * as woo from './woo.js';
import * as db from './db.js';
import { supabase } from './db.js';
import * as ai from './ai.js';
import * as competitors from './competitors.js';
import { config } from './config.js';
import {
  sendMessage,
  sendPhoto,
  inlineKeyboard,
  button,
  webAppButton,
  mainKeyboard,
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

  await sendMessage(chatId, 'עובד על זה, זה לוקח כמה שניות.');

  // קוראים את התמונה הראשונה
  let imageDescription = '';
  if (state.photos?.length) {
    try {
      imageDescription = await ai.describeProductImage(await resolvePhotoUrl(state.photos[0]));
    } catch (error) {
      console.error('קריאת התמונה נכשלה:', error.message);
    }
  }

  const [categories, tags] = await Promise.all([woo.getCategories(), woo.getTags()]);

  const content = await ai.writeProductContent({
    spokenText: state.spoken,
    imageDescription,
    categories,
    tags,
  });

  // המטא נכתב בקריאה נפרדת, עם כללי ה-SEO של GOA
  let meta = {};
  try {
    meta = await ai.writeMeta({
      name: content.name,
      description: content.description,
      price: content.priceFromUser,
      productKind: content.productKind,
      isBulk: content.isBulk,
    });
  } catch (error) {
    console.error('כתיבת המטא נכשלה:', error.message);
  }

  // מחקר מתחרים לפי הקטגוריה הראשונה שנבחרה
  let research = null;
  try {
    research = await competitors.researchPrice(content.name, content.categories?.[0] || null);
  } catch (error) {
    console.error('מחקר המתחרים נכשל:', error.message);
  }

  const draftId = randomUUID();

  await saveDraft(
    draftId,
    userId,
    { ...content, ...meta, research },
    state.photos || []
  );

  await db.setState(userId, { module: 'product', mode: state.mode, draftId });

  const editorUrl = `${config.publicBaseUrl}/product/${draftId}`;

  const summary = [
    `<b>${content.name}</b>`,
    '',
    content.shortDescription || '',
    '',
    content.priceFromUser
      ? `המחיר שאמרת: ${content.priceFromUser} ₪`
      : 'לא אמרת מחיר. בתוך המסך יש את המחירים אצל המתחרים.',
    content.notes ? `\n<i>${content.notes}</i>` : '',
  ].filter(Boolean).join('\n');

  await sendMessage(chatId, summary, {
    reply_markup: inlineKeyboard([
      [webAppButton('פתח לעריכה', editorUrl)],
      [button('תקן בהקלטה או בטקסט', `prod:revise:${draftId}`)],
      [button('עבור לתמונות', `prod:images:${draftId}`)],
    ]),
  });
}

// --- תיקון בשפה חופשית ---

export async function reviseDraft(chatId, userId, draftId, instruction) {
  const draft = await getDraft(draftId);

  if (!draft) {
    await sendMessage(chatId, 'הטיוטה לא נמצאה. אולי היא כבר פורסמה.');
    return;
  }

  await sendMessage(chatId, 'מתקן.');

  const revised = await ai.reviseProductContent(draft.content, instruction);

  await saveDraft(draftId, userId, { ...draft.content, ...revised }, draft.images);

  const editorUrl = `${config.publicBaseUrl}/product/${draftId}`;

  await sendMessage(chatId, `<b>${revised.name}</b>\n\n${revised.shortDescription || ''}`, {
    reply_markup: inlineKeyboard([
      [webAppButton('פתח לעריכה', editorUrl)],
      [button('תקן עוד', `prod:revise:${draftId}`)],
      [button('עבור לתמונות', `prod:images:${draftId}`)],
    ]),
  });
}

// --- שלב התמונות ---

export async function startImageStep(chatId, userId, draftId) {
  const draft = await getDraft(draftId);

  if (!draft?.images?.length) {
    await sendMessage(chatId, 'אין תמונות לעבוד איתן. אפשר לפרסם בלי תמונה או לשלוח אחת עכשיו.', {
      reply_markup: inlineKeyboard([[button('פרסם בלי תמונה', `prod:publish:${draftId}`)]]),
    });
    return;
  }

  await db.setState(userId, { module: 'product', draftId, awaiting: 'imageKind' });

  await sendMessage(chatId, 'איזה סוג מוצר זה?', {
    reply_markup: inlineKeyboard([
      [button('מוצר רגיל', `prod:kind:product:${draftId}`)],
      [button('חולצה', `prod:kind:shirt:${draftId}`)],
      [button('מכנסיים', `prod:kind:pants:${draftId}`)],
      [button('פיג׳מה', `prod:kind:pajama:${draftId}`)],
    ]),
  });
}

export async function generateImage(chatId, userId, draftId, kind, correctionHint = '') {
  const draft = await getDraft(draftId);
  if (!draft) {
    await sendMessage(chatId, 'הטיוטה לא נמצאה.');
    return;
  }

  const settings = await db.getSettings();
  await ai.assertWithinBudget(settings);

  await sendMessage(chatId, 'מייצר תמונה.');

  const sourceUrl = await resolvePhotoUrl(draft.images[0]);
  const isClothing = kind !== 'product';

  const result = await ai.generateProductImage(sourceUrl, {
    kind: isClothing ? 'clothing' : 'product',
    clothingType: kind,
    correctionHint,
  });

  // מעלים לספריית המדיה של האתר כדי שתהיה כתובת קבועה
  const uploaded = await woo.uploadMedia(result.buffer, result.mimeType, draft.content.name);

  const content = {
    ...draft.content,
    generatedImage: uploaded.source_url,
    imageKind: kind,
  };

  await saveDraft(draftId, userId, content, draft.images);

  if (correctionHint) {
    await ai.saveImageFeedback({
      productName: draft.content.name,
      beforeUrl: draft.content.generatedImage || sourceUrl,
      note: correctionHint,
      afterUrl: uploaded.source_url,
    });
  }

  await sendPhoto(chatId, uploaded.source_url, 'איך זה נראה?', {
    reply_markup: inlineKeyboard([
      [button('אהבתי', `prod:imgok:${draftId}`)],
      [button('ייצר שוב', `prod:regen:${kind}:${draftId}`)],
      [button('תקן לפי הערה', `prod:imgfix:${kind}:${draftId}`)],
    ]),
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

  const payload = {
    name: content.name,
    type: 'simple',
    status: status === 'publish' ? 'publish' : 'draft',
    description: content.description || '',
    short_description: content.shortDescription || '',
    categories: categoryIds,
    tags: tagIds,
    manage_stock: content.stockQuantity !== undefined && content.stockQuantity !== null,
    stock_quantity: content.stockQuantity ?? null,
    stock_status: content.stockQuantity > 0 ? 'instock' : 'outofstock',
  };

  if (content.priceFromUser) {
    payload.regular_price = String(content.priceFromUser);
  }

  if (content.generatedImage) {
    payload.images = [{ src: content.generatedImage }];
  }

  const created = await woo.createProduct(payload);

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

  await deleteDraft(draftId);
  await db.clearState(userId);

  await sendMessage(
    chatId,
    [
      status === 'publish' ? '<b>המוצר באוויר</b>' : '<b>נשמר כטיוטה</b>',
      '',
      created.name,
      created.permalink,
      metaWarning,
    ].filter(Boolean).join('\n'),
    { reply_markup: mainKeyboard }
  );
}
