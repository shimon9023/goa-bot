// קילוף HTML לטקסט נקי.
//
// נחוץ בשני מקומות: בלימוד הסגנון מהמוצרים הקיימים,
// ובקריאת עמוד תוצאות אצל מתחרה.
// יושב בקובץ נפרד כדי שהמודולים לא ייבאו זה את זה במעגל.

// מוציא טקסט נקי מתוך HTML, בלי ספריות חיצוניות
export function stripHtml(html) {
  if (!html) return '';

  let text = String(html);

  // מה שבתוך התגיות האלה הוא קוד ולא תוכן
  text = text.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ');

  // שומרים על גבולות פסקאות לפני שמוחקים תגיות
  text = text.replace(/<\/(p|div|section|h[1-6]|li|tr)\s*>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  text = text.replace(/<[^>]+>/g, ' ');

  // ישויות HTML נפוצות
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');

  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

// שורות שהן טקסט קבוע של האתר ולא כתיבה על המוצר
const BOILERPLATE = [
  /תמונת המוצר מעובדת על ידי/,
  /משלוח חינם/,
  /זמן המשלוח/,
];

export function cleanDescription(html) {
  const text = stripHtml(html);

  return text
    .split('\n')
    .filter((line) => line.length > 2 && !BOILERPLATE.some((rx) => rx.test(line)))
    .join('\n');
}

