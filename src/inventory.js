// מודול ניהול מלאי: חיפוש מוצר, הצגת מצב, עדכון, וריאציות ומלאי משותף.

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

  if (item.manage_stock && item.stock_quantity !== null) {
    return `${mark} · ${item.stock_quantity} יחידות`;
  }

  return `${mark} · הכמות לא מנוהלת`;
}

function variationName(variation) {
  const parts = (variation.attributes || []).map((attr) => attr.option).filter(Boolean);
  return parts.length ? parts.join(' · ') : `וריאציה ${variation.id}`;
}

// --- שלב ראשון: המשתמש אמר שם מוצר ---

export async function handleProductSearch(chatId, userId, term) {
  const results = await woo.searchProducts(term, 8);

  if (!results.length) {
    await sendMessage(chatId, `לא מצאתי מוצר בשם "${term}". תנסה שם אחר או חלק מהשם.`);
    return;
  }

  if (results.length === 1) {
    await showProduct(chatId, userId, results[0].id);
    return;
  }

  const rows = results.map((product) => [
    button(product.name, `inv:product:${product.id}`),
  ]);

  await sendMessage(chatId, `מצאתי ${results.length} מוצרים. איזה מהם?`, {
    reply_markup: inlineKeyboard(rows),
  });
}

// --- הצגת מוצר ומצבו ---

export async function showProduct(chatId, userId, productId, messageId = null) {
  const product = await woo.getProduct(productId);

  await db.setState(userId, { module: 'inventory', productId });

  if (product.type === 'variable') {
    await showVariableProduct(chatId, product, messageId);
    return;
  }

  const text = [`<b>${product.name}</b>`, stockLine(product)].join('\n');

  const rows = [
    [
      button('סמן במלאי', `inv:instock:${product.id}`),
      button('סמן אזל', `inv:outofstock:${product.id}`),
    ],
    [button('שנה כמות', `inv:setqty:${product.id}`)],
    [
      product.manage_stock
        ? button('כבה ניהול כמות', `inv:manage:off:${product.id}`)
        : button('הפעל ניהול כמות', `inv:manage:on:${product.id}`),
    ],
  ];

  const payload = { reply_markup: inlineKeyboard(rows) };

  if (messageId) {
    await editMessageText(chatId, messageId, text, payload);
  } else {
    await sendMessage(chatId, text, payload);
  }
}

async function showVariableProduct(chatId, product, messageId) {
  const variations = await woo.getVariations(product.id);

  const lines = [`<b>${product.name}</b>`, ''];
  const rows = [];

  // אם המלאי מנוהל ברמת המוצר הראשי, כל הווריאציות חולקות אותו
  const sharedStock = product.manage_stock;

  if (sharedStock) {
    lines.push('מלאי משותף לכל הווריאציות');
    lines.push(stockLine(product));
    lines.push('');

    rows.push([
      button('סמן במלאי', `inv:instock:${product.id}`),
      button('סמן אזל', `inv:outofstock:${product.id}`),
    ]);
    rows.push([button('שנה כמות', `inv:setqty:${product.id}`)]);
    rows.push([button('מלאי נפרד לכל וריאציה', `inv:split:${product.id}`)]);
  } else {
    for (const variation of variations) {
      lines.push(`<b>${variationName(variation)}</b>`);
      lines.push(stockLine(variation));
      lines.push('');

      rows.push([
        button(
          `${variationName(variation)} · עדכן`,
          `inv:var:${product.id}:${variation.id}`
        ),
      ]);
    }

    rows.push([button('מלאי משותף לכל הווריאציות', `inv:share:${product.id}`)]);
  }

  const payload = { reply_markup: inlineKeyboard(rows) };
  const text = lines.join('\n').trim();

  if (messageId) {
    await editMessageText(chatId, messageId, text, payload);
  } else {
    await sendMessage(chatId, text, payload);
  }
}

// --- הצגת וריאציה בודדת ---

export async function showVariation(chatId, userId, productId, variationId, messageId) {
  const [product, variation] = await Promise.all([
    woo.getProduct(productId),
    woo.getVariations(productId).then((list) => list.find((v) => v.id === variationId)),
  ]);

  if (!variation) {
    await sendMessage(chatId, 'לא מצאתי את הווריאציה הזו. אולי היא נמחקה.');
    return;
  }

  await db.setState(userId, { module: 'inventory', productId, variationId });

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
    [button('חזרה לכל הווריאציות', `inv:product:${productId}`)],
  ];

  await editMessageText(chatId, messageId, text, { reply_markup: inlineKeyboard(rows) });
}

// --- ביצוע עדכון ---

export async function applyStockChange(chatId, userId, { productId, variationId, inStock, quantity, manage }) {
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
      stock_status: before.stock_status,
      stock_quantity: before.stock_quantity,
      manage_stock: before.manage_stock,
    },
    after: { stock_status: inStock === undefined ? undefined : inStock ? 'instock' : 'outofstock', stock_quantity: quantity, manage_stock: manage },
  });

  await sendMessage(chatId, 'עודכן.', { reply_markup: mainKeyboard });
  await showProduct(chatId, userId, productId);
}

// --- עדכון מרובה: טבלת שינויים ואישור ---

export function buildChangeTable(changes) {
  const lines = ['<b>השינויים שעומדים להתבצע</b>', ''];

  for (const change of changes) {
    const uncertain = change.uncertain ? ' ❓ לא בטוח' : '';
    lines.push(`${change.name} · ${change.quantity} יחידות${uncertain}`);
  }

  lines.push('');
  lines.push('לאשר?');

  return lines.join('\n');
}

export async function proposeBulkChanges(chatId, userId, changes) {
  await db.setState(userId, { module: 'inventory', pendingBulk: changes });

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

  const summary = failed.length
    ? `עודכנו ${done} מוצרים. ${failed.length} נכשלו:\n${failed.join('\n')}`
    : `עודכנו ${done} מוצרים.`;

  await sendMessage(chatId, summary, { reply_markup: mainKeyboard });
}
