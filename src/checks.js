// בדיקות: השוואת טרנזילה מול ווקומרס, ומוצרים שנמכרו ואזלו.

import * as woo from './woo.js';
import { sendMessage, mainKeyboard, inlineKeyboard, button } from './telegram.js';

// --- נמכרו ואזלו ---
// מוצרים שנמכרו בשלושת החודשים האחרונים ואין מהם במלאי.

export async function soldOutReport(chatId) {
  await sendMessage(chatId, 'בודק, זה לוקח כמה שניות.');

  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const sold = await woo.getSoldProducts(threeMonthsAgo.toISOString());

  const outOfStock = [];

  for (const item of sold) {
    try {
      const product = await woo.getProduct(item.id);
      if (product.stock_status === 'outofstock') {
        outOfStock.push({ name: product.name, quantity: item.quantity });
      }
    } catch {
      // וריאציה שנמחקה או מוצר שכבר לא קיים
    }
  }

  if (!outOfStock.length) {
    await sendMessage(chatId, 'אין מוצרים שנמכרו ואזלו. הכול זמין.', {
      reply_markup: mainKeyboard,
    });
    return;
  }

  outOfStock.sort((a, b) => b.quantity - a.quantity);

  const lines = [
    `<b>נמכרו ואזלו: ${outOfStock.length} מוצרים</b>`,
    '<i>שלושת החודשים האחרונים</i>',
    '',
    ...outOfStock.map((item) => `${item.name} · נמכרו ${item.quantity}`),
  ];

  await sendMessage(chatId, lines.join('\n'), { reply_markup: mainKeyboard });
}

// --- טרנזילה ---

// מפרק CSV, כולל שדות בתוך מרכאות
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') inQuotes = false;
      else field += char;
      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') {
      row.push(field);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }

  if (field || row.length) {
    row.push(field);
    if (row.some((cell) => cell.trim())) rows.push(row);
  }

  return rows;
}

// מזהה את העמודות לפי שמות נפוצים, בעברית ובאנגלית
function findColumn(header, candidates) {
  const normalized = header.map((h) => h.trim().toLowerCase());

  for (const candidate of candidates) {
    const index = normalized.findIndex((h) => h.includes(candidate.toLowerCase()));
    if (index !== -1) return index;
  }

  return -1;
}

export function parseTranzilaCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('הקובץ ריק או לא בפורמט מוכר.');

  const header = rows[0];

  const amountCol = findColumn(header, ['סכום', 'amount', 'sum']);
  const dateCol = findColumn(header, ['תאריך', 'date']);
  const refCol = findColumn(header, ['אסמכתא', 'מספר עסקה', 'index', 'transaction']);
  const orderCol = findColumn(header, ['הזמנה', 'order', 'myid']);

  if (amountCol === -1) throw new Error('לא מצאתי עמודת סכום בקובץ.');

  return rows.slice(1).map((row) => ({
    amount: Number(String(row[amountCol] || '').replace(/[^\d.-]/g, '')),
    date: dateCol !== -1 ? row[dateCol] : '',
    reference: refCol !== -1 ? row[refCol] : '',
    orderNumber: orderCol !== -1 ? String(row[orderCol] || '').trim() : '',
  })).filter((t) => t.amount > 0);
}

export async function compareWithWoo(transactions) {
  // טווח התאריכים של הקובץ, לשליפת ההזמנות המקבילות
  const orders = await woo.getOrders({ per_page: 100, status: 'any' });

  const byNumber = new Map(orders.map((o) => [String(o.number), o]));

  const doubleCharges = [];
  const paymentsWithoutOrder = [];
  const ordersWithoutPayment = [];

  // חיובים כפולים: אותו סכום, אותה הזמנה, יותר מפעם אחת
  const seen = new Map();

  for (const transaction of transactions) {
    const key = `${transaction.orderNumber}:${transaction.amount}`;

    if (transaction.orderNumber && seen.has(key)) {
      doubleCharges.push({ ...transaction, previous: seen.get(key) });
    } else if (transaction.orderNumber) {
      seen.set(key, transaction);
    }

    // תשלום בלי הזמנה מקבילה
    if (transaction.orderNumber && !byNumber.has(transaction.orderNumber)) {
      paymentsWithoutOrder.push(transaction);
    }
  }

  // הזמנות ששולמו באתר בלי עסקה בטרנזילה
  const paidNumbers = new Set(transactions.map((t) => t.orderNumber).filter(Boolean));

  for (const order of orders) {
    const isPaid = ['processing', 'completed'].includes(order.status);
    if (isPaid && !paidNumbers.has(String(order.number))) {
      ordersWithoutPayment.push({
        number: order.number,
        total: order.total,
        date: order.date_created,
      });
    }
  }

  return { doubleCharges, paymentsWithoutOrder, ordersWithoutPayment };
}

export function formatComparison(result) {
  const { doubleCharges, paymentsWithoutOrder, ordersWithoutPayment } = result;

  if (!doubleCharges.length && !paymentsWithoutOrder.length && !ordersWithoutPayment.length) {
    return 'הכול תואם. לא מצאתי פערים בין טרנזילה לאתר.';
  }

  const lines = ['<b>תוצאות ההשוואה</b>', ''];

  if (doubleCharges.length) {
    lines.push(`<b>חיובים כפולים: ${doubleCharges.length}</b>`);
    for (const charge of doubleCharges.slice(0, 15)) {
      lines.push(`הזמנה ${charge.orderNumber} · ${charge.amount} ₪ · ${charge.date}`);
    }
    lines.push('');
  }

  if (paymentsWithoutOrder.length) {
    lines.push(`<b>תשלומים בלי הזמנה: ${paymentsWithoutOrder.length}</b>`);
    for (const payment of paymentsWithoutOrder.slice(0, 15)) {
      lines.push(`${payment.amount} ₪ · ${payment.date} · אסמכתא ${payment.reference}`);
    }
    lines.push('');
  }

  if (ordersWithoutPayment.length) {
    lines.push(`<b>הזמנות ששולמו בלי עסקה בטרנזילה: ${ordersWithoutPayment.length}</b>`);
    for (const order of ordersWithoutPayment.slice(0, 15)) {
      lines.push(`#${order.number} · ${order.total} ₪`);
    }
  }

  return lines.join('\n');
}

export async function showChecksMenu(chatId) {
  await sendMessage(chatId, 'איזו בדיקה?', {
    reply_markup: inlineKeyboard([
      [button('נמכרו ואזלו', 'check:soldout')],
      [button('השוואה מול טרנזילה', 'check:tranzila')],
    ]),
  });
}
