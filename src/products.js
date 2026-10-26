// מודול מוצר חדש ווריאציה למוצר קיים.
// זרימה: תמונה והקלטה, תמלול, כתיבת תוכן, מסך עריכה, תמונות, פרסום.

import { randomUUID } from 'node:crypto';

import * as woo from './woo.js';
import * as db from './db.js';
import { supabase } from './db.js';
import * as ai from './ai.js';
import * as competitors from './competitors.js';
import * as imagestore from './imagestore.js';
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

  // קוראים את כל התמונות יחד, כדי לזהות גם וריאציות
  let vision = null;
  let imageDescription = '';

  if (state.photos?.length) {
    try {
      const urls = await Promise.all(state.photos.map(resolvePhotoUrl));
      vision = await ai.describeProductImages(urls);

      imageDescription = [
        vision.overall,
        vision.brand ? `מותג: ${vision.brand}` : '',
        vision.model ? `דגם: ${vision.model}` : '',
        vision.looksLikeVariants
          ? `נראה שזה מוצר אחד ב-${vision.perImage?.length || 0} גרסאות, לפי ${vision.variantAttribute || 'מאפיין'}`
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

  const content = await ai.writeProductContent({
    spokenText: state.spoken,
    imageDescription,
    categories,
    tags,
    webContext,
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

  const variants = buildVariantPlan(vision, state.photos || []);

  await saveDraft(
    draftId,
    userId,
    { ...content, ...meta, research, variants, variantAttribute: vision?.variantAttribute || 'טעם' },
    state.photos || []
  );

  // שומרים את התמונות במצב. בלי זה תיקון בהקלטה בנה טיוטה בלי תמונות.
  await db.setState(userId, {
    module: 'product',
    mode: state.mode,
    draftId,
    photos: state.photos || [],
    spoken: state.spoken || '',
  });

  const editorUrl = `${config.publicBaseUrl}/product/${draftId}`;

  const notes = Array.isArray(content.notes)
    ? content.notes
    : (content.notes ? [content.notes] : []);

  const summary = [
    `<b>${content.name}</b>`,
    '',
    content.shortDescription || '',
    '',
    variants.length
      ? `${variants.length} וריאציות לפי ${vision?.variantAttribute || 'טעם'}`
      : '',
    content.priceFromUser
      ? `מחיר: ${content.priceFromUser} ₪`
      : 'לא אמרת מחיר.',
    notes.length ? '' : null,
    ...notes.slice(0, 3).map((n) => `• ${n}`),
  ].filter((line) => line !== null && line !== undefined).join('\n');

  const rows = [[webAppButton('פתח לעריכה', editorUrl)]];

  if (variants.length) rows.push([button(`אשר ${variants.length} וריאציות`, `prod:vars:${draftId}`)]);

  rows.push([button('תקן בהקלטה או בטקסט', `prod:revise:${draftId}`)]);
  rows.push([button('עבור לתמונות', `prod:images:${draftId}`)]);

  await sendMessage(chatId, summary, { reply_markup: inlineKeyboard(rows) });
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
      certain: Boolean(item.certain && item.label),
      photo: photos[(item.index || 1) - 1] || null,
    }))
    .filter((v) => v.photo);
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

  const variants = (draft.content.variants || []).filter((v) => v.value);
  const total = variants.length >= 2 ? variants.length : 1;

  await sendMessage(
    chatId,
    total > 1
      ? `מייצר ${total} תמונות, אחת לכל וריאציה. זה ייקח כמה דקות.`
      : 'מייצר תמונה.'
  );

  const isClothing = kind !== 'product';
  const sources = total > 1 ? variants.map((v) => v.photo) : [draft.images[0]];

  const produced = [];
  const failed = [];

  for (const [index, source] of sources.entries()) {
    try {
      const sourceUrl = await resolvePhotoUrl(source);

      const result = await ai.generateProductImage(sourceUrl, {
        kind: isClothing ? 'clothing' : 'product',
        clothingType: kind,
        correctionHint,
      });

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

  // התמונה הראשונה היא הראשית, והשאר נכנסות לגלריה ולווריאציות
  const updatedVariants = variants.map((v) => {
    const match = produced.find((p) => p.label === v.value);
    return match ? { ...v, imageUrl: match.url } : v;
  });

  const content = {
    ...draft.content,
    generatedImage: produced[0].url,
    extraImages: produced.slice(1).map((p) => p.url),
    variants: updatedVariants,
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

  const caption = [
    produced.length > 1 ? `${produced.length} תמונות מוכנות. זו הראשונה.` : 'איך זה נראה?',
    failed.length ? `נכשלו: ${failed.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  await sendPhoto(chatId, produced[0].url, caption, {
    reply_markup: inlineKeyboard([
      [button('אהבתי', `prod:imgok:${draftId}`)],
      [button('ייצר שוב', `prod:regen:${kind}:${draftId}`)],
      [button('תקן לפי הערה', `prod:imgfix:${kind}:${draftId}`)],
    ]),
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

  const editorUrl = `${config.publicBaseUrl}/product/${draftId}`;

  await sendMessage(chatId, 'ממשיך עם התמונות המקוריות.', {
    reply_markup: inlineKeyboard([[webAppButton('פתח לעריכה ופרסום', editorUrl)]]),
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
  const attribute = content.variantAttribute || 'טעם';

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

  // התכונה שלפיה נבנות הווריאציות
  if (isVariable) {
    payload.attributes = [
      {
        name: attribute,
        visible: true,
        variation: true,
        options: variants.map((v) => v.value),
      },
    ];
  }

  const created = await woo.createProduct(payload);

  // יצירת הווריאציות עצמן
  let variantsCreated = 0;
  const variantsFailed = [];

  if (isVariable) {
    for (const variant of variants) {
      try {
        const fields = {
          attributes: [{ name: attribute, option: variant.value }],
          manage_stock: variant.quantity !== undefined && variant.quantity !== null,
          stock_quantity: variant.quantity ?? null,
          stock_status: (variant.quantity ?? 1) > 0 ? 'instock' : 'outofstock',
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
      metaWarning,
    ].filter(Boolean).join('\n'),
    { reply_markup: mainKeyboard }
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
  const attribute = draft.content.variantAttribute || 'טעם';

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
