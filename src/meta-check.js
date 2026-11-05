// בדיקת מטא, במקביל ל-check_meta.py שבסקיל.
//
// קלוד מקבל את הכללים בפרומפט, אבל פרומפט הוא בקשה ולא ערובה.
// כאן בודקים את התוצאה בפועל, ומה שלא עובר חוזר לתיקון.

const BANNED = [
  'איכות גבוהה',
  'מחיר משתלם',
  'מושלם ל',
  'מבחר ענק',
  'הכי זול',
  'מדהים',
  'אולטימטיבי',
  'ארומטי',
  'באותה הזמנה',
  'המלאי מתעדכן',
  'אקספרס',
  'ירושלים',
  'כססה',
  'וואטסאפ',
  'ווטסאפ',
];

// משפטי המשלוח המותרים, לפי המחיר
export function shippingSentence(price, isBulk) {
  const value = Number(price) || 0;

  if (isBulk) return 'משלוח חינם מ-390 ₪';
  if (value > 320) return 'משלוח חינם בקנייה מעל 390 ₪';
  if (value >= 100) return 'משלוח חינם מ-390 ₪';

  return 'זמן המשלוח הממוצע שלנו: 3 ימים';
}

function bannedIn(text) {
  const haystack = String(text || '');
  return BANNED.filter((word) => haystack.includes(word));
}

export function check({ title, description, h1, price, isBulk = false }) {
  const problems = [];

  const titleText = String(title || '').trim();
  const descText = String(description || '').trim();
  const h1Text = String(h1 || '').trim();

  // --- כותרת ---
  if (!titleText) {
    problems.push('אין כותרת מטא');
  } else {
    if (titleText.length < 45) problems.push(`הכותרת קצרה מדי: ${titleText.length} תווים, צריך 45 עד 60`);
    if (titleText.length > 60) problems.push(`הכותרת ארוכה מדי: ${titleText.length} תווים, צריך 45 עד 60`);
    if (!/\|\s*גואה\s*$/.test(titleText)) problems.push('הכותרת לא מסתיימת ב-"| גואה"');
    if (price && !titleText.includes(String(price))) problems.push('המחיר לא מופיע בכותרת');

    // "50,000" במקום "50K"
    if (/\d{1,3},\d{3}/.test(titleText)) problems.push('מספר גדול נכתב עם פסיק, צריך קיצור כמו 50K');

    // תקרת שאיפות
    if (/עד\s*\d+\s*K/i.test(titleText)) problems.push('אסור לכתוב תקרת שאיפות, רק "החל מ"');
  }

  // --- תיאור ---
  if (!descText) {
    problems.push('אין תיאור מטא');
  } else {
    if (descText.length < 130) problems.push(`התיאור קצר מדי: ${descText.length} תווים, צריך 130 עד 160`);
    if (descText.length > 160) problems.push(`התיאור ארוך מדי: ${descText.length} תווים, צריך 130 עד 160`);

    const expected = shippingSentence(price, isBulk);
    if (!descText.includes(expected)) {
      problems.push(`חסר משפט המשלוח הנכון למחיר הזה: "${expected}"`);
    }
  }

  // --- H1 ---
  if (h1Text) {
    if (h1Text.includes('גואה')) problems.push('ה-H1 מכיל את שם המותג');
    if (h1Text === titleText) problems.push('ה-H1 זהה לכותרת');
  }

  // --- רשימה שחורה ---
  for (const [label, text] of [['בכותרת', titleText], ['בתיאור', descText], ['ב-H1', h1Text]]) {
    const hits = bannedIn(text);
    if (hits.length) problems.push(`מילים אסורות ${label}: ${hits.join(', ')}`);
  }

  // "קנאביס" לבד
  for (const [label, text] of [['בכותרת', titleText], ['בתיאור', descText]]) {
    if (/קנאביס/.test(text) && !/(מוצרי|אביזרים ל)קנאביס/.test(text)) {
      problems.push(`המילה קנאביס לבדה ${label}, צריך "מוצרי קנאביס"`);
    }
  }

  return { ok: problems.length === 0, problems };
}
