// נקודת הכניסה: שרת Express שמקבל את ההודעות מטלגרם ומגיש את מסך הליקוט.

import express from 'express';
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
import * as woo from './woo.js';
import * as ai from './ai.js';
import { startSchedulers, runAllChecks } from './alerts.js';
import {
  sendMessage,
  answerCallbackQuery,
  mainKeyboard,
  inlineKeyboard,
  button,
  webAppButton,
  getFile,
  fileUrl,
  setWebhook,
  getWebhookInfo,
} from './telegram.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pickingHtml = readFileSync(join(__dirname, 'miniapp', 'picking.html'), 'utf8');
const productHtml = readFileSync(join(__dirname, 'miniapp', 'product.html'), 'utf8');

const app = express();
app.use(express.json({ limit: '2mb' }));

// --- אבטחה ---

function isAllowed(userId) {
  const list = config.telegram.allowedUserIds;
  if (!list.length) return String(userId) === String(config.telegram.ownerId);
  return list.includes(String(userId));
}

async function warnOwnerAboutStranger(user) {
  if (!config.telegram.ownerId) return;

  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');

  try {
    await sendMessage(
      config.telegram.ownerId,
      [
        '🔒 <b>מישהו לא מוכר ניסה להשתמש בבוט</b>',
        '',
        `שם: ${name || 'לא ידוע'}`,
        user.username ? `שם משתמש: @${user.username}` : '',
        `מזהה: <code>${user.id}</code>`,
      ].filter(Boolean).join('\n')
    );
  } catch (error) {
    console.error('לא הצלחתי להתריע על ניסיון גישה:', error.message);
  }
}

// --- טיפול בהודעות טקסט ---

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = (message.text || '').trim();

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
      await sendMessage(chatId, checks.formatComparison(result), {
        reply_markup: mainKeyboard,
      });
      return;
    }
  }

  // הקלטה קולית
  if (message.voice || message.audio) {
    const state = await db.getState(userId);

    if (state?.module === 'product') {
      await sendMessage(chatId, 'מתמלל.');
      const transcript = await products.collectVoice(userId, message.voice || message.audio);
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

  // כפתורי התפריט הקבוע
  switch (text) {
    case '/start':
    case 'התחל מההתחלה':
      await db.clearState(userId);
      await sendMessage(
        chatId,
        'מה נעשה?',
        { reply_markup: mainKeyboard }
      );
      return;

    case 'ניהול מלאי':
      await db.setState(userId, { module: 'inventory', awaiting: 'product' });
      await sendMessage(chatId, 'איזה מוצר? אפשר לכתוב את השם או לשלוח הקלטה.');
      return;

    case 'הזמנות':
      await db.clearState(userId);
      await orders.showPendingOrders(chatId);
      return;

    case 'מוצר חדש':
      await sendMessage(chatId, 'מה נוסיף?', {
        reply_markup: inlineKeyboard([
          [button('מוצר חדש', 'prod:new')],
          [button('וריאציה למוצר קיים', 'prod:variation')],
        ]),
      });
      return;

    case 'בדיקות':
      await db.clearState(userId);
      await checks.showChecksMenu(chatId);
      return;

    case 'הגדרות':
      await db.clearState(userId);
      await settings.showMenu(chatId);
      return;
  }

  await handleTextInput(chatId, userId, text);
}

// טקסט חופשי, מתפרש לפי המצב שבו המשתמש נמצא
async function handleTextInput(chatId, userId, text) {
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
    if (state.awaiting === 'user') {
      await settings.saveUser(chatId, userId, text);
      return;
    }
  }

  if (state?.module === 'inventory' && state.awaiting === 'quantity') {
    const quantity = parseInt(text.replace(/[^\d-]/g, ''), 10);

    if (Number.isNaN(quantity)) {
      await sendMessage(chatId, 'לא הבנתי את המספר. תכתוב רק את הכמות, למשל 12.');
      return;
    }

    await inventory.applyStockChange(chatId, userId, {
      productId: state.productId,
      variationId: state.variationId,
      quantity,
    });
    return;
  }

  if (state?.module === 'inventory') {
    await inventory.handleProductSearch(chatId, userId, text);
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

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const parts = (query.data || '').split(':');

  const [scope, action, ...rest] = parts;

  // עונים לטלגרם מיד. יש חלון של 15 שניות בלבד,
  // ופעולות כמו יצירת תמונה לוקחות יותר מזה.
  await answerCallbackQuery(query.id).catch(() => {});

  if (scope === 'alert' && action === 'mute') {
    await db.muteOrder(rest[0]);
    await sendMessage(chatId, 'ההתראות להזמנה הזו הושתקו.');
    return;
  }

  if (scope === 'prod') {
    await handleProductCallback(chatId, userId, action, rest);
    return;
  }

  if (scope === 'ft') {
    if (action === 'yes') await freetext.confirm(chatId, userId);
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
      await inventory.applyStockChange(chatId, userId, {
        productId: Number(rest[0]),
        variationId: rest[1] ? Number(rest[1]) : undefined,
        inStock: action === 'instock',
      });
      break;

    case 'setqty':
      await db.setState(userId, {
        module: 'inventory',
        awaiting: 'quantity',
        productId: Number(rest[0]),
        variationId: rest[1] ? Number(rest[1]) : undefined,
      });
      await sendMessage(chatId, 'כמה יחידות?');
      break;

    case 'manage':
      await inventory.applyStockChange(chatId, userId, {
        productId: Number(rest[1]),
        manage: rest[0] === 'on',
      });
      break;

    case 'share':
      await inventory.applyStockChange(chatId, userId, {
        productId: Number(rest[0]),
        manage: true,
      });
      break;

    case 'split':
      await inventory.applyStockChange(chatId, userId, {
        productId: Number(rest[0]),
        manage: false,
      });
      break;

    case 'bulk':
      if (rest[0] === 'confirm') {
        await inventory.applyBulkChanges(chatId, userId);
      } else {
        await db.clearState(userId);
        await sendMessage(chatId, 'בוטל, שום דבר לא השתנה.', { reply_markup: mainKeyboard });
      }
      break;
  }
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
    case 'users': await settings.showUsers(chatId); break;
    case 'adduser': await settings.promptForUser(chatId, userId); break;
    case 'rmuser': await settings.removeUser(chatId, rest[0]); break;
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

  if (!isAllowed(from.id)) {
    await warnOwnerAboutStranger(from);
    return;
  }

  try {
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
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
  if (process.env.USE_INTERNAL_SCHEDULER !== 'false') {
    startSchedulers();
  } else {
    console.log('המתזמן הפנימי כבוי. ההרצה מגיעה ממייק.');
  }
});
