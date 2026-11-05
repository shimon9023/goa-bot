// נקודת הכניסה: שרת Express שמקבל את ההודעות מטלגרם ומגיש את מסך הליקוט.

import express from 'express';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config } from './config.js';
import * as db from './db.js';
import * as inventory from './inventory.js';
import * as orders from './orders.js';
import * as products from './products.js';
import * as checks from './checks.js';
import * as settings from './settings.js';
import * as freetext from './freetext.js';
import * as imagestore from './imagestore.js';
import * as woo from './woo.js';
import * as ai from './ai.js';
import * as google from './google.js';
import * as warehouse from './warehouse.js';
import * as access from './access.js';
import { startSchedulers, runAllChecks } from './alerts.js';
import {
  sendMessage,
  answerCallbackQuery,
  inlineKeyboard,
  button,
  webAppButton,
  getFile,
  fileUrl,
  setWebhook,
  getWebhookInfo,
  verifyInitData,
} from './telegram.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pickingHtml = readFileSync(join(__dirname, 'miniapp', 'picking.html'), 'utf8');
const productHtml = readFileSync(join(__dirname, 'miniapp', 'product.html'), 'utf8');
const warehouseHtml = readFileSync(join(__dirname, 'miniapp', 'warehouse.html'), 'utf8');

const app = express();
app.use(express.json({ limit: '2mb' }));

// --- זרימת ההוספה לרשימה ---
// מי שנמצא במודול הזה, כל מה שהוא שולח נדבק למוצר הפתוח,
// עד שהוא לוחץ שמור או עובר לכפתור אחר בתפריט.

async function handleIntakeMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = (message.text || '').trim();

  if (message.photo?.length) {
    await warehouse.addPhotos(chatId, userId, message.photo);
    return true;
  }

  if (message.voice || message.audio) {
    await warehouse.addVoice(chatId, userId, message.voice || message.audio);
    return true;
  }

  if (text) {
    await warehouse.addNote(chatId, userId, text);
    return true;
  }

  await sendMessage(chatId, 'אני יודע לקבל תמונות, טקסט והקלטות.');
  return true;
}

async function saveIntakeItem(chatId, userId, from) {
  const user = await db.getUser(userId);
  const name = user?.name || access.displayName(from);

  const result = await warehouse.save(chatId, userId, name);

  // אם תמונות לא עלו לדרייב, שמעון צריך לדעת
  if (result?.failed && config.telegram.ownerId && String(config.telegram.ownerId) !== String(userId)) {
    await sendMessage(
      config.telegram.ownerId,
      `⚠️ במוצר "${result.description || result.id}" מהרשימה, ${result.failed} תמונות לא עלו לדרייב.`
    ).catch(() => {});
  }
}

// --- טיפול בהודעות טקסט ---

async function handleMessage(message, areas) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = (message.text || '').trim();

  // כפתור בתפריט תמיד מנצח, גם באמצע איסוף מוצר לרשימה
  const isMenuPress = access.AREAS.some((area) => area.button === text)
    || text === 'הגדרות' || text === 'התחל מההתחלה' || text === '/start';

  if (!isMenuPress) {
    const state = await db.getState(userId);

    if (state?.module === 'warehouse') {
      await handleIntakeMessage(message);
      return;
    }
  }

  // תמונה שנשלחה בזמן בניית מוצר
  if (message.photo?.length) {
    const collected = await products.collectPhoto(userId, message.photo);
    if (collected) {
      await sendMessage(chatId, 'קיבלתי את התמונה. עוד משהו, או "מוכן"?', {
        reply_markup: inlineKeyboard([[button('מוכן', 'prod:ready')]]),
      });
      return;
    }
  }

  // קובץ CSV של טרנזילה
  if (message.document) {
    const state = await db.getState(userId);

    if (state?.module === 'checks' && state.awaiting === 'csv') {
      await sendMessage(chatId, 'קורא את הקובץ ומשווה.');

      const file = await getFile(message.document.file_id);
      const response = await fetch(fileUrl(file.file_path));
      const text = await response.text();

      const transactions = checks.parseTranzilaCsv(text);
      const result = await checks.compareWithWoo(transactions);

      await db.clearState(userId);
      await sendMessage(chatId, checks.formatComparison(result));
      return;
    }
  }

  // הקלטה קולית
  if (message.voice || message.audio) {
    const state = await db.getState(userId);

    if (state?.module === 'product') {
      await sendMessage(chatId, 'מתמלל.');

      const file = await getFile((message.voice || message.audio).file_id);
      const transcript = await ai.transcribe(fileUrl(file.file_path));

      // כשהוא באמצע תיקון, ההקלטה היא ההוראה ולא איסוף מידע חדש
      if (state.awaiting === 'revise') {
        await sendMessage(chatId, `שמעתי:\n<i>${transcript}</i>`);
        await products.reviseDraft(chatId, userId, state.draftId, transcript);
        return;
      }

      if (state.awaiting === 'variantList') {
        await sendMessage(chatId, `שמעתי:\n<i>${transcript}</i>`);
        await products.replaceVariantValues(chatId, userId, state.draftId, transcript);
        return;
      }

      if (state.awaiting === 'imageFix') {
        await db.setState(userId, { ...state, awaiting: null });
        await products.generateImage(chatId, userId, state.draftId, state.imageKind, transcript);
        return;
      }

      await products.collectText(userId, transcript);
      await sendMessage(chatId, `שמעתי:\n<i>${transcript}</i>\n\nעוד משהו, או "מוכן"?`, {
        reply_markup: inlineKeyboard([[button('מוכן', 'prod:ready')]]),
      });
      return;
    }

    // הקלטה בכל מצב אחר מתפרשת כטקסט רגיל
    const file = await getFile((message.voice || message.audio).file_id);
    const transcript = await ai.transcribe(fileUrl(file.file_path));
    await handleTextInput(chatId, userId, transcript);
    return;
  }

  if (!text) return;

  // כפתורי התפריט הקבוע, כל אחד מותנה בהרשאה
  const menu = {
    'הוספה לרשימת העלאה': ['intake', async () => {
      await warehouse.welcome(chatId, userId);
    }],

    'ניהול מלאי': ['inventory', async () => {
      await db.setState(userId, { module: 'inventory', awaiting: 'product' });
      await sendMessage(chatId, 'איזה מוצר? אפשר לכתוב את השם או לשלוח הקלטה.');
    }],

    'הזמנות': ['orders', async () => {
      await db.clearState(userId);
      await orders.showPendingOrders(chatId);
    }],

    'מוצר חדש': ['products', async () => {
      await db.clearState(userId);

      const rows = [
        [button('מוצר חדש', 'prod:new')],
        [button('וריאציה למוצר קיים', 'prod:variation')],
      ];

      // האפשרות הזו מופיעה רק כשיש באמת מה לקחת מהרשימה
      try {
        if (await google.isConnected()) {
          const pending = await google.pendingRows();
          if (pending.length) {
            rows.push([button(`מוצרים מהרשימה (${pending.length})`, 'prod:list')]);
          }
        }
      } catch (error) {
        console.error('קריאת רשימת ההעלאה נכשלה:', error.message);
      }

      await sendMessage(chatId, 'מה נוסיף?', { reply_markup: inlineKeyboard(rows) });
    }],

    'בדיקות': ['checks', async () => {
      await db.clearState(userId);
      await checks.showChecksMenu(chatId);
    }],

    'הגדרות התראות': ['alerts', async () => {
      await db.clearState(userId);
      await settings.showAlertsOnly(chatId);
    }],

    'הגדרות': ['settings', async () => {
      await db.clearState(userId);
      await settings.showMenu(chatId);
    }],
  };

  if (text === '/start' || text === 'התחל מההתחלה') {
    await db.clearState(userId);
    await sendMessage(chatId, 'מה נעשה?', { reply_markup: access.keyboard(areas) });
    return;
  }

  const entry = menu[text];

  if (entry) {
    const [area, run] = entry;

    if (!access.can(areas, area)) {
      await sendMessage(chatId, 'אין לך הרשאה לזה.');
      return;
    }

    await run();
    return;
  }

  await handleTextInput(chatId, userId, text, areas);
}

// טקסט חופשי, מתפרש לפי המצב שבו המשתמש נמצא
async function handleTextInput(chatId, userId, text, areas = []) {
  const state = await db.getState(userId);

  // באמצע בניית מוצר
  if (state?.module === 'product' && state.awaiting === 'input') {
    await products.collectText(userId, text);
    await sendMessage(chatId, 'רשמתי. עוד משהו, או "מוכן"?', {
      reply_markup: inlineKeyboard([[button('מוכן', 'prod:ready')]]),
    });
    return;
  }

  // תיקון תוכן של טיוטה
  if (state?.module === 'product' && state.awaiting === 'revise') {
    await products.reviseDraft(chatId, userId, state.draftId, text);
    return;
  }

  // הערת תיקון לתמונה
  if (state?.module === 'product' && state.awaiting === 'imageFix') {
    await db.setState(userId, { ...state, awaiting: null });
    await products.generateImage(chatId, userId, state.draftId, state.imageKind, text);
    return;
  }

  if (state?.module === 'product' && state.awaiting === 'variantList') {
    await products.replaceVariantValues(chatId, userId, state.draftId, text);
    return;
  }

  // קלט להגדרות
  if (state?.module === 'settings') {
    if (state.awaiting === 'value') {
      await settings.saveValue(chatId, userId, state.key, text);
      return;
    }
    if (state.awaiting === 'competitor') {
      await settings.saveCompetitor(chatId, userId, text);
      return;
    }
  }

  if (state?.module === 'inventory' && state.awaiting === 'quantity') {
    const quantity = parseInt(text.replace(/[^\d-]/g, ''), 10);

    if (Number.isNaN(quantity)) {
      await sendMessage(chatId, 'לא הבנתי את המספר. תכתוב רק את הכמות, למשל 12.');
      return;
    }

    await inventory.applyStockChange(
      chatId,
      userId,
      { productId: state.productId, variationId: state.variationId, quantity },
      state.cardMessageId || null
    );
    return;
  }

  if (state?.module === 'inventory') {
    await inventory.handleProductSearch(chatId, userId, text);
    return;
  }

  // כתיבה חופשית נוגעת במלאי ובהזמנות, אז היא פתוחה רק למי שמורשה שם.
  // בלי זה מי שיש לו רק הוספה לרשימה היה יכול לשנות מלאי בהודעה חופשית.
  if (!access.can(areas, 'inventory') && !access.can(areas, 'orders')) {
    await sendMessage(chatId, 'לא הבנתי. תשתמש בכפתורים שבתפריט.', {
      reply_markup: access.keyboard(areas),
    });
    return;
  }

  // ברירת מחדל: קלוד מבין מה רוצים ומציג לאישור לפני שנוגעים באתר
  try {
    await freetext.handle(chatId, userId, text);
  } catch (error) {
    console.error('הבנת הבקשה נכשלה:', error.message);
    // אם קלוד לא זמין או שעברנו את התקרה, נופלים לחיפוש מוצר רגיל
    await sendMessage(chatId, `לא הצלחתי להבין את הבקשה (${error.message}). מחפש כמוצר.`);
    await inventory.handleProductSearch(chatId, userId, text);
  }
}

// --- טיפול בלחיצות על כפתורים ---

// לכל קבוצת כפתורים האזור שהיא דורשת. מי שאין לו, הלחיצה לא עושה כלום.
const CALLBACK_AREA = {
  wh: 'intake',
  inv: 'inventory',
  prod: 'products',
  check: 'checks',
  set: 'settings',
  acc: 'settings',
  goog: 'settings',
  ft: 'inventory',
};

async function handleCallback(query, areas) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const parts = (query.data || '').split(':');

  const [scope, action, ...rest] = parts;

  // עונים לטלגרם מיד. יש חלון של 15 שניות בלבד,
  // ופעולות כמו יצירת תמונה לוקחות יותר מזה.
  await answerCallbackQuery(query.id).catch(() => {});

  const required = CALLBACK_AREA[scope];

  if (required && !access.can(areas, required)) {
    // חוץ ממסך ההתראות המצומצם, שפתוח גם למי שיש לו רק אותו
    const alertsOnly = scope === 'set' && ['thresholds', 'edit', 'alerts', 'toggle'].includes(action);

    if (!(alertsOnly && access.can(areas, 'alerts'))) {
      await sendMessage(chatId, 'אין לך הרשאה לזה.');
      return;
    }
  }

  if (scope === 'wh' && action === 'save') {
    await saveIntakeItem(chatId, userId, query.from);
    return;
  }

  if (scope === 'alert' && action === 'mute') {
    await db.muteOrder(rest[0]);
    await sendMessage(chatId, 'ההתראות להזמנה הזו הושתקו.');
    return;
  }

  if (scope === 'prod') {
    await handleProductCallback(chatId, userId, action, rest);
    return;
  }

  if (scope === 'acc') {
    if (action === 'ok') await access.approve(chatId, rest[0]);
    else if (action === 'no') await access.reject(chatId, rest[0]);
    else if (action === 'rm') await access.remove(chatId, rest[0]);
    else if (action === 'edit') await access.showPermissions(chatId, rest[0]);
    else if (action === 'area') await access.toggleArea(chatId, rest[0], rest[1], messageId);
    else if (action === 'done') await access.finishPermissions(chatId, rest[0], messageId);
    return;
  }

  if (scope === 'goog') {
    await handleGoogleCallback(chatId, action);
    return;
  }

  if (scope === 'ft') {
    if (action === 'yes') await freetext.confirm(chatId, userId);
    else if (action === 'pick') await freetext.pickProduct(chatId, userId, rest[0]);
    else await freetext.cancel(chatId, userId);
    return;
  }

  if (scope === 'check') {
    if (action === 'soldout') await checks.soldOutReport(chatId);
    else if (action === 'tranzila') {
      await db.setState(userId, { module: 'checks', awaiting: 'csv' });
      await sendMessage(chatId, 'שלח את קובץ ה-CSV שהורדת מטרנזילה.');
    }
    return;
  }

  if (scope === 'set') {
    await handleSettingsCallback(chatId, userId, action, rest);
    return;
  }

  if (scope !== 'inv') {
    return;
  }

  switch (action) {
    case 'product':
      await inventory.showProduct(chatId, userId, Number(rest[0]), messageId);
      break;

    case 'var':
      await inventory.showVariation(chatId, userId, Number(rest[0]), Number(rest[1]), messageId);
      break;

    case 'instock':
    case 'outofstock':
      await inventory.applyStockChange(
        chatId,
        userId,
        {
          productId: Number(rest[0]),
          variationId: rest[1] ? Number(rest[1]) : undefined,
          inStock: action === 'instock',
        },
        messageId
      );
      break;

    case 'setqty': {
      const state = await db.getState(userId);
      await db.setState(userId, {
        ...state,
        module: 'inventory',
        awaiting: 'quantity',
        productId: Number(rest[0]),
        variationId: rest[1] ? Number(rest[1]) : undefined,
        cardMessageId: messageId,
      });
      await sendMessage(chatId, 'כמה יחידות?');
      break;
    }

    // inv:manage:on:PID  או  inv:manage:on:PID:VID
    case 'manage':
      await inventory.applyStockChange(
        chatId,
        userId,
        {
          productId: Number(rest[1]),
          variationId: rest[2] ? Number(rest[2]) : undefined,
          manage: rest[0] === 'on',
        },
        messageId
      );
      break;

    case 'share':
      await inventory.applyStockChange(
        chatId, userId, { productId: Number(rest[0]), manage: true }, messageId
      );
      break;

    case 'split':
      await inventory.applyStockChange(
        chatId, userId, { productId: Number(rest[0]), manage: false }, messageId
      );
      break;

    case 'bulk':
      if (rest[0] === 'confirm') {
        await inventory.applyBulkChanges(chatId, userId);
      } else {
        await db.clearState(userId);
        await sendMessage(chatId, 'בוטל, שום דבר לא השתנה.');
      }
      break;
  }
}

// --- חיבור לגוגל ---

async function handleGoogleCallback(chatId, action) {
  if (action === 'off') {
    await google.disconnect();
    await sendMessage(chatId, 'החיבור לגוגל נותק. הגיליון והתיקייה נשארו בדרייב שלך.');
    return;
  }

  if (action === 'connect') {
    try {
      const url = await google.startAuth();

      await sendMessage(
        chatId,
        [
          'לחץ על הכפתור, בחר את חשבון הגוגל של העסק ואשר.',
          '',
          'אני מבקש הרשאה צרה: גישה רק לקבצים שאני עצמי יוצר.',
          'שום דבר אחר בדרייב שלך לא נגיש לי.',
          '',
          'הקישור תקף לעשר דקות.',
        ].join('\n'),
        { reply_markup: inlineKeyboard([[{ text: 'התחבר לגוגל', url }]]) }
      );
    } catch (error) {
      await sendMessage(chatId, `לא הצלחתי להכין את החיבור: ${error.message}`);
    }
    return;
  }

  const state = await google.status();

  if (!state.connected) {
    await sendMessage(
      chatId,
      [
        '<b>גוגל לא מחובר</b>',
        '',
        'בלי החיבור אין רשימת מחסן: אין לאן לכתוב את המוצרים ואין לאן להעלות תמונות.',
      ].join('\n'),
      { reply_markup: inlineKeyboard([[button('חבר עכשיו', 'goog:connect')]]) }
    );
    return;
  }

  await sendMessage(
    chatId,
    [
      '<b>גוגל מחובר</b>',
      '',
      state.account ? `חשבון: ${state.account}` : '',
      '',
      state.sheetUrl ? `<a href="${state.sheetUrl}">הגיליון</a>` : '',
      state.folderUrl ? `<a href="${state.folderUrl}">תיקיית התמונות</a>` : '',
    ].filter(Boolean).join('\n'),
    {
      reply_markup: inlineKeyboard([
        [button('חבר מחדש', 'goog:connect')],
        [button('נתק', 'goog:off')],
      ]),
    }
  );
}

// --- כפתורים של מודול המוצר ---

async function handleProductCallback(chatId, userId, action, rest) {
  switch (action) {
    case 'new':
      await products.startNewProduct(chatId, userId);
      break;

    case 'variation':
      await products.startVariation(chatId, userId);
      break;

    // רשימת המוצרים שצולמו במחסן
    case 'list': {
      const pending = await google.pendingRows();

      if (!pending.length) {
        await sendMessage(chatId, 'הרשימה ריקה. אין מוצרים שממתינים מהמחסן.');
        break;
      }

      const next = pending[0];

      await sendMessage(
        chatId,
        [
          `<b>${pending.length} מוצרים ממתינים</b>`,
          '',
          `הבא בתור: ${warehouse.describeRow(next)}`,
        ].join('\n'),
        {
          reply_markup: inlineKeyboard([
            [button('המוצר הבא ברשימה', 'prod:next')],
            [webAppButton('בחר מהרשימה', `${config.publicBaseUrl}/warehouse`)],
          ]),
        }
      );
      break;
    }

    case 'next': {
      const pending = await google.pendingRows();

      if (!pending.length) {
        await sendMessage(chatId, 'הרשימה ריקה. אין מוצרים שממתינים מהמחסן.');
        break;
      }

      await products.startFromWarehouseRow(chatId, userId, pending[0]);
      break;
    }

    case 'ready':
      await products.buildDraft(chatId, userId);
      break;

    case 'revise': {
      const state = await db.getState(userId);
      await db.setState(userId, { ...state, module: 'product', draftId: rest[0], awaiting: 'revise' });
      await sendMessage(chatId, 'מה לתקן? אפשר לכתוב או להקליט.');
      break;
    }

    case 'images':
      await products.startImageStep(chatId, userId, rest[0]);
      break;

    case 'kind':
      await products.generateImage(chatId, userId, rest[1], rest[0]);
      break;

    case 'regen':
      await products.generateImage(chatId, userId, rest[1], rest[0]);
      break;

    case 'imgfix': {
      const state = await db.getState(userId);
      await db.setState(userId, {
        ...state,
        module: 'product',
        draftId: rest[1],
        imageKind: rest[0],
        awaiting: 'imageFix',
      });
      await sendMessage(chatId, 'מה לא טוב בתמונה, ואיך זה צריך להיות?');
      break;
    }

    case 'imgok': {
      const editorUrl = `${config.publicBaseUrl}/product/${rest[0]}`;
      await sendMessage(chatId, 'יופי. עכשיו אפשר לעבור על הפרטים ולפרסם.', {
        reply_markup: inlineKeyboard([[webAppButton('פתח לעריכה ופרסום', editorUrl)]]),
      });
      break;
    }

    case 'publish':
      await products.publish(chatId, userId, rest[0], 'publish');
      break;

    case 'vars':
      await products.showVariants(chatId, userId, rest[0]);
      break;

    case 'varsok':
      await db.clearState(userId);
      await sendMessage(chatId, 'מאושר. עכשיו התמונות.', {
        reply_markup: inlineKeyboard([[button('עבור לתמונות', `prod:images:${rest[0]}`)]]),
      });
      break;

    case 'varsedit': {
      const state = await db.getState(userId);
      await db.setState(userId, {
        ...state, module: 'product', draftId: rest[0], awaiting: 'variantList',
      });
      await sendMessage(
        chatId,
        'תכתיב או תכתוב את הרשימה המלאה, לפי סדר התמונות, מופרדת בפסיקים או בשורות.'
      );
      break;
    }

    case 'varsoff':
      await products.dropVariants(chatId, userId, rest[0]);
      break;

    case 'imgskip':
      await products.skipImageEditing(chatId, userId, rest[0]);
      break;
  }
}

// --- כפתורים של ההגדרות ---

async function handleSettingsCallback(chatId, userId, action, rest) {
  switch (action) {
    case 'thresholds': await settings.showThresholds(chatId); break;
    case 'edit': await settings.promptForValue(chatId, userId, rest[0]); break;
    case 'alerts': await settings.showAlertToggles(chatId); break;
    case 'toggle': await settings.toggleAlert(chatId, rest[0]); break;
    case 'competitors': await settings.showCompetitors(chatId); break;
    case 'addcomp': await settings.promptForCompetitor(chatId, userId); break;
    case 'rmcomp': {
      const competitors = await import('./competitors.js');
      await competitors.removeCompetitor(Number(rest[0]));
      await settings.showCompetitors(chatId);
      break;
    }
    case 'users': await access.showUsers(chatId); break;
    case 'log': await settings.showLog(chatId); break;
    case 'undo': await settings.undoLast(chatId, userId); break;
  }
}

// --- הנתיב שטלגרם פונה אליו ---

app.post('/telegram/webhook', async (req, res) => {
  // טלגרם שולח את הסוד הזה בכל פנייה. מי שלא מכיר אותו, לא נכנס.
  if (req.get('X-Telegram-Bot-Api-Secret-Token') !== config.telegram.webhookSecret) {
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  const update = req.body;
  const from = update.message?.from || update.callback_query?.from;

  if (!from) return;

  try {
    const areas = await access.areasOf(from.id);

    if (!areas) {
      const chatId = update.message?.chat.id || update.callback_query?.message.chat.id;
      if (chatId) await access.handleStranger(chatId, from);
      return;
    }

    if (update.message) await handleMessage(update.message, areas);
    else if (update.callback_query) await handleCallback(update.callback_query, areas);
  } catch (error) {
    console.error('שגיאה בטיפול בעדכון:', error);

    const chatId = update.message?.chat.id || update.callback_query?.message.chat.id;
    if (chatId) {
      await sendMessage(chatId, `משהו השתבש: ${error.message}`).catch(() => {});
    }
  }
});

// --- מסך הליקוט ---

app.get('/picking/:orderId', (req, res) => {
  res.type('html').send(pickingHtml);
});

app.get('/api/picking/:orderId', async (req, res) => {
  try {
    const payload = await orders.buildPickingPayload(req.params.orderId);
    res.json(payload);
  } catch (error) {
    console.error('טעינת הזמנה לליקוט נכשלה:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/picking/:orderId/complete', async (req, res) => {
  try {
    const number = await orders.completeOrder(req.params.orderId, config.telegram.ownerId);
    res.json({ ok: true, number });
  } catch (error) {
    console.error('סגירת הזמנה נכשלה:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- מסך עריכת המוצר ---

app.get('/product/:draftId', (req, res) => {
  res.type('html').send(productHtml);
});

app.get('/api/product/:draftId', async (req, res) => {
  try {
    const draft = await products.getDraft(req.params.draftId);

    if (!draft) return res.status(404).json({ error: 'הטיוטה לא נמצאה' });

    const [categories, tags] = await Promise.all([woo.getCategories(), woo.getTags()]);

    res.json({
      content: draft.content,
      categories: categories.map((c) => ({ id: c.id, name: c.name })),
      tags: tags.map((t) => ({ id: t.id, name: t.name })),
    });
  } catch (error) {
    console.error('טעינת טיוטה נכשלה:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/product/:draftId', async (req, res) => {
  try {
    const { content, status } = req.body;
    const draftId = req.params.draftId;

    const existing = await products.getDraft(draftId);
    if (!existing) return res.status(404).json({ error: 'הטיוטה לא נמצאה' });

    // שומרים את מה שנערך, ואז מפרסמים
    await products.saveDraft(
      draftId,
      existing.user_id,
      { ...existing.content, ...content },
      existing.images
    );

    await products.publish(existing.user_id, existing.user_id, draftId, status);

    res.json({ ok: true });
  } catch (error) {
    console.error('שמירת מוצר נכשלה:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- רשימת המחסן ---

app.get('/warehouse', (req, res) => {
  res.type('html').send(warehouseHtml);
});

// רק בעלים. הזהות מגיעה מהחתימה של טלגרם, לא מפרמטר בכתובת.
function ownerFromInitData(initData) {
  const user = verifyInitData(initData);
  if (!user || !access.isOwner(user.id)) return null;
  return user;
}

app.get('/api/warehouse/list', async (req, res) => {
  if (!ownerFromInitData(req.query.initData)) return res.sendStatus(401);

  try {
    const rows = await google.pendingRows();

    res.json({
      rows: rows.map((row) => ({
        id: row.cells[google.COL.id] || '',
        date: row.cells[google.COL.date] || '',
        who: row.cells[google.COL.who] || '',
        description: row.cells[google.COL.description] || '',
        quantity: row.cells[google.COL.quantity] || '',
        minPrice: row.cells[google.COL.minPrice] || '',
        photoCount: Number(row.cells[google.COL.photoCount] || 0),
      })),
    });
  } catch (error) {
    console.error('טעינת רשימת המחסן נכשלה:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/warehouse/pick', async (req, res) => {
  const user = ownerFromInitData(req.body?.initData);
  if (!user) return res.sendStatus(401);

  try {
    const row = await google.findRow(req.body.id);
    if (!row) return res.status(404).json({ error: 'השורה לא נמצאה' });

    res.json({ ok: true });

    await products.startFromWarehouseRow(user.id, user.id, row);
  } catch (error) {
    console.error('פתיחת מוצר מהרשימה נכשלה:', error.message);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// תמונות ממוזערות לרשימה. הקובץ נמשך מטלגרם בצד השרת,
// כדי שהטוקן של הבוט לא ייצא החוצה בכתובת.
app.get('/warehouse/photo/:id/:index', async (req, res) => {
  try {
    const row = await google.findRow(req.params.id);
    if (!row) return res.sendStatus(404);

    const fileIds = warehouse.rowFileIds(row);
    const fileId = fileIds[Number(req.params.index) || 0];
    if (!fileId) return res.sendStatus(404);

    const file = await getFile(fileId);
    const upstream = await fetch(fileUrl(file.file_path));
    if (!upstream.ok) return res.sendStatus(502);

    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=600');
    res.send(buffer);
  } catch (error) {
    console.error('הגשת תמונה מהמחסן נכשלה:', error.message);
    res.sendStatus(500);
  }
});

// --- חיבור לגוגל ---

function page(title, body) {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;900&display=swap" rel="stylesheet">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f6;color:#0c090d;
font-family:Heebo,sans-serif;padding:24px;text-align:center}
.card{background:#fff;border-radius:16px;padding:32px 28px;max-width:420px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:22px;font-weight:900;margin:0 0 10px}p{color:#5c5c63;margin:0 0 6px;line-height:1.6}
a{color:#0142ff}
@media(prefers-color-scheme:dark){body{background:#0e0e11;color:#f3f3f5}.card{background:#1a1a1f;box-shadow:none}
p{color:#a8a8b2}a{color:#5b8bff}}</style></head><body><div class="card">${body}</div></body></html>`;
}

app.get('/google/connect', async (req, res) => {
  try {
    const url = await google.startAuth();
    res.redirect(url);
  } catch (error) {
    res.status(500).type('html').send(page('שגיאה', `<h1>לא הצלחתי</h1><p>${error.message}</p>`));
  }
});

app.get('/google/callback', async (req, res) => {
  const { code, state, error: denied } = req.query;

  if (denied) {
    return res.type('html').send(page('בוטל', '<h1>החיבור בוטל</h1><p>אפשר לנסות שוב מתוך הבוט.</p>'));
  }

  if (!code) {
    return res.status(400).type('html').send(page('שגיאה', '<h1>חסר קוד</h1><p>נסה שוב מתוך הבוט.</p>'));
  }

  try {
    const result = await google.finishAuth(String(code), String(state || ''));

    if (config.telegram.ownerId) {
      await sendMessage(
        config.telegram.ownerId,
        [
          '✅ <b>גוגל מחובר</b>',
          '',
          result.account ? `חשבון: ${result.account}` : '',
          '',
          result.sheetUrl ? `<a href="${result.sheetUrl}">הגיליון</a>` : '',
          result.folderUrl ? `<a href="${result.folderUrl}">תיקיית התמונות</a>` : '',
        ].filter(Boolean).join('\n')
      ).catch(() => {});
    }

    res.type('html').send(
      page(
        'מחובר',
        '<h1>גוגל מחובר</h1><p>יצרתי לך תיקייה וגיליון בדרייב.<p>אפשר לחזור לטלגרם.</p>'
      )
    );
  } catch (error) {
    console.error('חיבור גוגל נכשל:', error.message);
    res.status(400).type('html').send(page('שגיאה', `<h1>החיבור נכשל</h1><p>${error.message}</p>`));
  }
});

// --- הנתיב שמייק קורא לו פעם ביום ---
// מעיר את השרת ומריץ את בדיקות ההתראות.

app.post('/cron/run-checks', async (req, res) => {
  if (!config.cronSecret) {
    return res.status(503).json({ error: 'CRON_SECRET לא הוגדר' });
  }

  const provided = req.get('X-Cron-Secret') || req.query.secret;

  if (provided !== config.cronSecret) {
    return res.sendStatus(401);
  }

  res.json({ ok: true, startedAt: new Date().toISOString() });

  try {
    await runAllChecks();
    console.log('בדיקות ההתראות הסתיימו');
  } catch (error) {
    console.error('הרצת הבדיקות נכשלה:', error.message);
  }
});

// --- הגשת תמונות שנוצרו ---
// ווקומרס מוריד מכאן את התמונה ומכניס אותה לספריית המדיה.

app.get('/img/:file', (req, res) => {
  const id = String(req.params.file).replace(/\.(png|jpg|jpeg)$/i, '');
  const item = imagestore.get(id);

  if (!item) return res.sendStatus(404);

  res.set('Content-Type', item.mimeType);
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(item.buffer);
});

// --- בדיקת חיים, בשביל Render ---

app.get('/health', (req, res) => res.json({ ok: true }));

// --- בדיקת חיבור הבוט לטלגרם ---
// מאפשר לראות את מצב החיבור ולחדש אותו בלי טרמינל.

app.get('/admin/webhook-status', async (req, res) => {
  if (!config.cronSecret || (req.get('X-Cron-Secret') || req.query.secret) !== config.cronSecret) {
    return res.sendStatus(401);
  }

  try {
    res.json(await getWebhookInfo());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/admin/set-webhook', async (req, res) => {
  if (!config.cronSecret || (req.get('X-Cron-Secret') || req.query.secret) !== config.cronSecret) {
    return res.sendStatus(401);
  }

  try {
    res.json(await connectWebhook());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// מחבר את הבוט לשרת. בטוח לקרוא לזה שוב ושוב.
async function connectWebhook() {
  if (!config.publicBaseUrl) {
    throw new Error('חסר PUBLIC_BASE_URL, אי אפשר לחבר את הבוט.');
  }

  const url = `${config.publicBaseUrl}/telegram/webhook`;
  await setWebhook(url);

  return { ok: true, url };
}

app.listen(config.port, async () => {
  console.log(`הבוט מאזין על פורט ${config.port}`);

  // מחברים את הבוט בכל עלייה. טלגרם מתעלם אם זה כבר מחובר לאותה כתובת,
  // וככה אין צורך להריץ פקודה ידנית אחרי כל פריסה.
  try {
    const result = await connectWebhook();
    console.log(`הבוט מחובר לטלגרם: ${result.url}`);
  } catch (error) {
    console.error('חיבור הבוט לטלגרם נכשל:', error.message);
  }

  // בתוכנית החינמית השרת נרדם, אז המתזמן הפנימי לא אמין
  // ומייק הוא זה שמעיר ומריץ. בתוכנית בתשלום המתזמן עובד כרגיל.
  imagestore.startCleanup();

  if (process.env.USE_INTERNAL_SCHEDULER !== 'false') {
    startSchedulers();
  } else {
    console.log('המתזמן הפנימי כבוי. ההרצה מגיעה ממייק.');
  }
});
