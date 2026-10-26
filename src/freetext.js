// כתיבה חופשית: כל הודעה שאינה כפתור ואינה חלק מזרימה פתוחה
// עוברת לקלוד, שמזהה כוונה. הבוט מציג מה הוא הבין ומחכה לאישור.

import * as woo from './woo.js';
import * as db from './db.js';
import * as ai from './ai.js';
import * as inventory from './inventory.js';
import * as orders from './orders.js';
import * as checks from './checks.js';
import * as products from './products.js';
import { sendMessage, inlineKeyboard, button, mainKeyboard } from './telegram.js';

// פעולות שמשנות את האתר, ולכן דורשות אישור
const NEEDS_CONFIRMATION = new Set(['stock_in', 'stock_out', 'stock_qty']);

export async function handle(chatId, userId, text) {
  const settings = await db.getSettings();
  await ai.assertWithinBudget(settings);

  // מוציאים קודם את שם המוצר מהמשפט, ורק אז מחפשים בחנות.
  // חיפוש של המשפט המלא בווקומרס תמיד נכשל.
  let candidates = [];
  let phrase = null;

  try {
    phrase = await ai.extractProductPhrase(text);
  } catch (error) {
    console.error('זיהוי שם המוצר נכשל:', error.message);
  }

  try {
    const { results } = await woo.findProducts(phrase || text, 8);
    candidates = results.map((p) => ({ id: p.id, name: p.name }));
  } catch (error) {
    console.error('חיפוש מוצרים נכשל:', error.message);
  }

  const intent = await ai.readIntent(text, { products: candidates });

  // לא הבין
  if (intent.action === 'unknown' || intent.confidence < 0.5) {
    await sendMessage(
      chatId,
      intent.question || 'לא הבנתי מה לעשות. אפשר לנסח אחרת, או להשתמש בתפריט.',
      { reply_markup: mainKeyboard }
    );
    return;
  }

  // פעולות קריאה בלבד, מבוצעות מיד
  switch (intent.action) {
    case 'orders_pending':
      await orders.showPendingOrders(chatId);
      return;

    case 'sold_out_report':
      await checks.soldOutReport(chatId);
      return;

    case 'new_product':
      await products.startNewProduct(chatId, userId);
      return;

    case 'product_info':
      if (intent.productId) {
        await inventory.showProduct(chatId, userId, intent.productId);
      } else {
        await inventory.handleProductSearch(chatId, userId, text);
      }
      return;

    case 'order_question': {
      const recent = await woo.getOrders({ per_page: 30 });
      const slim = recent.map((o) => ({
        number: o.number,
        status: o.status,
        total: o.total,
        name: `${o.billing?.first_name || ''} ${o.billing?.last_name || ''}`.trim(),
        date: o.date_created,
        items: (o.line_items || []).map((i) => `${i.name} x${i.quantity}`),
      }));

      const answer = await ai.answerOrderQuestion(text, slim);
      await sendMessage(chatId, answer, { reply_markup: mainKeyboard });
      return;
    }
  }

  // פעולות שמשנות את האתר
  if (!NEEDS_CONFIRMATION.has(intent.action)) return;

  if (!intent.productId) {
    // יש מועמדים אבל קלוד לא בחר אחד, אז נותנים לשמעון לבחור
    if (candidates.length) {
      const state = await db.getState(userId);
      await db.setState(userId, { ...state, module: 'freetext', pendingIntent: intent });

      await sendMessage(
        chatId,
        `לא הייתי בטוח לאיזה מוצר התכוונת. אחד מאלה?`,
        {
          reply_markup: inlineKeyboard([
            ...candidates.slice(0, 6).map((p) => [button(p.name, `ft:pick:${p.id}`)]),
            [button('אף אחד', 'ft:no')],
          ]),
        }
      );
      return;
    }

    await sendMessage(
      chatId,
      [
        phrase
          ? `לא מצאתי בחנות מוצר שמתאים ל"${phrase}".`
          : 'לא זיהיתי על איזה מוצר מדובר.',
        '',
        'אפשר לכתוב את השם כמו שהוא מופיע באתר, או חלק ממנו.',
      ].join('\n'),
      { reply_markup: mainKeyboard }
    );
    return;
  }

  // שומרים את מה שהובן, ומחכים לאישור
  await db.setState(userId, { module: 'freetext', pendingIntent: intent });

  const lines = [
    '<b>זה מה שהבנתי</b>',
    '',
    intent.summary,
  ];

  if (intent.confidence < 0.8) {
    lines.push('', '<i>לא הייתי בטוח לגמרי, אז כדאי לבדוק.</i>');
  }

  lines.push('', 'לבצע?');

  await sendMessage(chatId, lines.join('\n'), {
    reply_markup: inlineKeyboard([
      [button('כן, בצע', 'ft:yes'), button('לא', 'ft:no')],
    ]),
  });
}

// --- ביצוע אחרי אישור ---

export async function confirm(chatId, userId) {
  const state = await db.getState(userId);
  const intent = state?.pendingIntent;

  if (!intent) {
    await sendMessage(chatId, 'אין פעולה שממתינה לאישור.', { reply_markup: mainKeyboard });
    return;
  }

  await db.clearState(userId);

  const change = { productId: intent.productId };

  if (intent.action === 'stock_in') change.inStock = true;
  else if (intent.action === 'stock_out') change.inStock = false;
  else if (intent.action === 'stock_qty') change.quantity = intent.quantity;

  await inventory.applyStockChange(chatId, userId, change);
}

// שמעון בחר מוצר מתוך הרשימה שהצענו
export async function pickProduct(chatId, userId, productId) {
  const state = await db.getState(userId);
  const intent = state?.pendingIntent;

  if (!intent) {
    await inventory.showProduct(chatId, userId, Number(productId));
    return;
  }

  const updated = { ...intent, productId: Number(productId) };

  // פעולת קריאה בלבד, אין מה לאשר
  if (!NEEDS_CONFIRMATION.has(intent.action)) {
    await db.clearState(userId);
    await inventory.showProduct(chatId, userId, Number(productId));
    return;
  }

  await db.setState(userId, { ...state, pendingIntent: updated });

  const product = await woo.getProduct(productId).catch(() => null);
  const label = product?.name || 'המוצר';

  const verb = {
    stock_in: 'לסמן כזמין במלאי',
    stock_out: 'לסמן כאזל',
    stock_qty: `לקבוע כמות ${intent.quantity}`,
  }[intent.action];

  await sendMessage(chatId, `<b>${label}</b>\n\n${verb}. לבצע?`, {
    reply_markup: inlineKeyboard([
      [button('כן, בצע', 'ft:yes'), button('לא', 'ft:no')],
    ]),
  });
}

export async function cancel(chatId, userId) {
  await db.clearState(userId);
  await sendMessage(chatId, 'בוטל, שום דבר לא השתנה.', { reply_markup: mainKeyboard });
}
