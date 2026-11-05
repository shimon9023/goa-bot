// נעילה לפי משתמש.
//
// למה זה קיים: כששולחים כמה תמונות יחד בטלגרם, כל תמונה מגיעה
// כהודעה נפרדת, וכולן נוחתות כמעט באותו רגע. בלי נעילה כל אחת
// קוראת את המצב הישן, מוסיפה את עצמה, וכותבת חזרה —
// והאחרונה דורסת את כל מי שהספיק לפניה.
// זה מה שגרם לשתי תמונות להפוך לשני מוצרים, ולתמונות להיעלם.
//
// כאן כל המשתמשים רצים במקביל, אבל הפעולות של אותו משתמש
// נכנסות לתור אחד ומחכות בתורן.

const chains = new Map();

export function withUserLock(userId, task) {
  const key = String(userId);
  const previous = chains.get(key) || Promise.resolve();

  // רצים אחרי הקודם בין אם הצליח ובין אם נכשל,
  // אחרת כישלון אחד היה חוסם את כל מי שמחכה אחריו
  const run = previous.then(task, task);

  const settled = run.then(
    () => {},
    () => {}
  );

  chains.set(key, settled);

  // מנקים אחרי עצמנו, כדי שהמפה לא תתנפח עם הזמן
  settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });

  return run;
}

export function pending() {
  return chains.size;
}
