// מודול ניהול מלאי: חיפוש מוצר, הצגת מצב, עדכון, וריאציות ומלאי משותף.
// כרטיס המוצר מתעדכן במקום, בלי להציף את השיחה בכרטיסים חדשים.

import * as woo from './woo.js';
import * as db from './db.js';
import {
  sendMessage,
  editMessageText,
  inlineKeyboard,
  button,
  mainKeyboard,
} from './telegram.js';

// --- עזרי תצוגה ---

function stockLine(item) {
  const inStock = item.stock_status === 'instock';
  const mark = inStock ? '🟢 במלאי' : '🔴 אזל';

  if (!item.manage_stock) return `${mark} · הכמות לא מנוהלת`;

  // ניהול כמות פעיל אבל עוד לא הוזנה כמות
  if (item.stock_quantity === null || item.stock_quantity === undefined) {
    return `${mark} · ניהול כמות פעיל, לא נקבעה כמות`;
  }

  return `${mark} · ${item.stock_quantity} יחידות`;
}

function variationName(variation) {
  const parts = (variation.attributes || []).map((attr) => attr.option).filter(Boolean);
  return parts.length ? parts.join(' · ') : `וריאציה ${variation.id}`;
}

// כפתור ניהול הכמות. מופיע בכל מקום: מוצר פשוט, מוצר עם וריאציות, ווריאציה בודדת.
function manageButton(item, productId, variationId = null) {
  const suffix = variationId ? `${productId}:${variationId}` : `${productId}`;

  return item.manage_stock
    ? button('כבה ניהול כמות', `inv:manage:off:${suffix}`)
    : button('הפעל ניהול כמות', `inv:manage:on:${suffix}`);
}

// --- חיפוש ---

export async function handleProductSearch(chatId, userId, term) {
  const { results, usedTerm, exact } = await woo.findProducts(term, 8);

  if (!results.length) {
    await sendMessage(
      chatId,
      [
        `לא מצאתי כלום שמתאים ל"${term}".`,
        '',
        'אפשר לנסות חלק מהשם, או שם של מותג.',
      ].join('\n'),
      { reply_markup: mainKeyboard }
    );
    return;
  }

  // התאמה מדויקת ויחידה, נכנסים ישר
  if (exact && results.length === 1) {
    await showProduct(chatId, userId, results[0].id);
    return;
  }

  const rows = results.map((product) => [button(product.name, `inv:product:${product.id}`)]);

  const header = exact
    ? `מצאתי ${results.length} מוצרים. איזה מהם?`
    : [
        `לא מצאתי מוצר בשם המדויק "${term}".`,
        `חיפשתי "${usedTerm}" ואלה המוצרים הקרובים:`,
        '',
        'אם אף אחד לא מתאים, תכתוב שם אחר.',
      ].join('\n');

  await sendMessage(chatId, header, { reply_markup: inlineKeyboard(rows) });
}

// --- הצגת מוצר ---

export async function showProduct(chatId, userId, productId, messageId = null) {
  const product = await woo.getProduct(productId);

  const state = (await db.getState(userId)) || {};
  await db.setState(userId, {
    ...state,
    module: 'inventory',
    productId,
    variationId: null,
    cardMessageId: messageId || state.cardMessageId || null,
  });

  if (product.type === 'variable') {
    return showVariableProduct(chatId, userId, product, messageId);
  }

  const text = [`<b>${product.name}</b>`, stockLine(product)].join('\n');

  const rows = [
    [
      button('סמן במלאי', `inv:instock:${product.id}`),
      button('סמן אזל', `inv:outofstock:${product.id}`),
    ],
    [button('שנה כמות', `inv:setqty:${product.id}`)],
    [manageButton(product, product.id)],
  ];

  return render(chatId, userId, text, inlineKeyboard(rows), messageId);
}

async function showVariableProduct(chatId, userId, product, messageId) {
  const variations = await woo.getVariations(product.id);

  // כשהמלאי מנוהל ברמת המוצר הראשי, כל הווריאציות חולקות אותו
  const sharedStock = product.manage_stock;

  const lines = [`<b>${product.name}</b>`, ''];
  const rows = [];

  if (sharedStock) {
    lines.push('מלאי משותף לכל הווריאציות');
    lines.push(stockLine(product));

    rows.push([
      button('סמן במלאי', `inv:instock:${product.id}`),
      button('סמן אזל', `inv:outofstock:${product.id}`),
    ]);
    rows.push([button('שנה כמות', `inv:setqty:${product.id}`)]);
    rows.push([manageButton(product, product.id)]);
    rows.push([button('מלאי נפרד לכל וריאציה', `inv:split:${product.id}`)]);
  } else {
    for (const variation of variations) {
      lines.push(`<b>${variationName(variation)}</b>`);
      lines.push(stockLine(variation));
      lines.push('');

      rows.push([
        button(variationName(variation), `inv:var:${product.id}:${variation.id}`),
      ]);
    }

    rows.push([button('מלאי משותף לכל הווריאציות', `inv:share:${product.id}`)]);
  }

  return render(chatId, userId, lines.join('\n').trim(), inlineKeyboard(rows), messageId);
}

export async function showVariation(chatId, userId, productId, variationId, messageId) {
  const [product, variations] = await Promise.all([
    woo.getProduct(productId),
    woo.getVariations(productId),
  ]);

  const variation = variations.find((v) => v.id === variationId);

  if (!variation) {
    await sendMessage(chatId, 'לא מצאתי את הווריאציה הזו. אולי היא נמחקה.');
    return null;
  }

  const state = (await db.getState(userId)) || {};
  await db.setState(userId, { ...state, module: 'inventory', productId, variationId });

  const text = [
    `<b>${product.name}</b>`,
    variationName(variation),
    stockLine(variation),
  ].join('\n');

  const rows = [
    [
      button('סמן במלאי', `inv:instock:${productId}:${variationId}`),
      button('סמן אזל', `inv:outofstock:${productId}:${variationId}`),
    ],
    [button('שנה כמות', `inv:setqty:${productId}:${variationId}`)],
    [manageButton(variation, productId, variationId)],
    [button('חזרה לכל הווריאציות', `inv:product:${productId}`)],
  ];

  return render(chatId, userId, text, inlineKeyboard(rows), messageId);
}

// מעדכן את הכרטיס הקיים, ורק אם אין כזה שולח חדש
async function render(chatId, userId, text, markup, messageId) {
  if (messageId) {
    await editMessageText(chatId, messageId, text, { reply_markup: markup });
    return messageId;
  }

  const sent = await sendMessage(chatId, text, { reply_markup: markup });
  const state = (await db.getState(userId)) || {};
  await db.setState(userId, { ...state, cardMessageId: sent.message_id });

  return sent.message_id;
}

// --- ביצוע עדכון ---

export async function applyStockChange(
  chatId,
  userId,
  { productId, variationId, inStock, quantity, manage },
  messageId = null
) {
  const isVariation = Boolean(variationId);

  const before = isVariation
    ? (await woo.getVariations(productId)).find((v) => v.id === variationId)
    : await woo.getProduct(productId);

  await woo.setStock(
    { id: isVariation ? variationId : productId, variationOf: isVariation ? productId : null },
    { inStock, quantity, manage }
  );

  await db.logAction({
    userId,
    action: 'stock_update',
    target: isVariation ? `${productId}:${variationId}` : String(productId),
    before: {
      stock_status: before?.stock_status,
      stock_quantity: before?.stock_quantity,
      manage_stock: before?.manage_stock,
    },
    after: {
      stock_status: inStock === undefined ? undefined : inStock ? 'instock' : 'outofstock',
      stock_quantity: quantity,
      manage_stock: manage,
    },
  });

  // מציירים מחדש את אותו כרטיס, בלי הודעה נוספת
  const state = (await db.getState(userId)) || {};
  const card = messageId || state.cardMessageId || null;

  if (isVariation) {
    await showVariation(chatId, userId, productId, variationId, card);
  } else {
    await showProduct(chatId, userId, productId, card);
  }
}

// --- עדכון מרובה ---

export function buildChangeTable(changes) {
  const lines = ['<b>השינויים שעומדים להתבצע</b>', ''];

  for (const change of changes) {
    const uncertain = change.uncertain ? ' ❓ לא בטוח' : '';
    lines.push(`${change.name} · ${change.quantity} יחידות${uncertain}`);
  }

  lines.push('', 'לאשר?');
  return lines.join('\n');
}

export async function proposeBulkChanges(chatId, userId, changes) {
  const state = (await db.getState(userId)) || {};
  await db.setState(userId, { ...state, module: 'inventory', pendingBulk: changes });

  await sendMessage(chatId, buildChangeTable(changes), {
    reply_markup: inlineKeyboard([
      [button('אשר הכול', 'inv:bulk:confirm')],
      [button('בטל', 'inv:bulk:cancel')],
    ]),
  });
}

export async function applyBulkChanges(chatId, userId) {
  const state = await db.getState(userId);
  const changes = state?.pendingBulk || [];

  if (!changes.length) {
    await sendMessage(chatId, 'אין שינויים ממתינים.');
    return;
  }

  let done = 0;
  const failed = [];

  for (const change of changes) {
    try {
      await woo.setStock(
        { id: change.id, variationOf: change.parentId || null },
        { quantity: change.quantity }
      );
      done += 1;
    } catch (error) {
      failed.push(`${change.name}: ${error.message}`);
    }
  }

  await db.logAction({
    userId,
    action: 'bulk_stock_update',
    target: `${changes.length} מוצרים`,
    after: changes,
  });

  await db.clearState(userId);

  await sendMessage(
    chatId,
    failed.length
      ? `עודכנו ${done} מוצרים. ${failed.length} נכשלו:\n${failed.join('\n')}`
      : `עודכנו ${done} מוצרים.`,
    { reply_markup: mainKeyboard }
  );
}
