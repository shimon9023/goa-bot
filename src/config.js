// קריאת ההגדרות מהסביבה. אם משהו חיוני חסר, השרת עוצר עם הודעה ברורה.

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `חסר משתנה סביבה: ${name}. הוסף אותו בהגדרות השירות ב-Render ואז הפעל מחדש.`
    );
  }
  return value.trim();
}

function optional(name, fallback = '') {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function idList(name) {
  return optional(name)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export const config = {
  port: Number(optional('PORT', '3000')),
  publicBaseUrl: optional('PUBLIC_BASE_URL').replace(/\/+$/, ''),

  telegram: {
    token: required('TELEGRAM_BOT_TOKEN'),
    webhookSecret: required('TELEGRAM_WEBHOOK_SECRET'),
    allowedUserIds: idList('TELEGRAM_ALLOWED_USER_IDS'),
    ownerId: optional('TELEGRAM_OWNER_ID'),
  },

  woo: {
    siteUrl: required('WOO_SITE_URL').replace(/\/+$/, ''),
    consumerKey: required('WOO_CONSUMER_KEY'),
    consumerSecret: required('WOO_CONSUMER_SECRET'),
  },

  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },

  ai: {
    anthropicKey: optional('ANTHROPIC_API_KEY'),
    geminiKey: optional('GEMINI_API_KEY'),
  },
};

// ברירות מחדל של ההתראות. ניתנות לשינוי מתוך הבוט ונשמרות בסופהבייס.
export const defaultSettings = {
  unpackedHours: 30,
  reminderEveryHours: 12,
  duplicateWindowHours: 3,
  largeOrderAmount: 2000,
  quietHoursStart: 22,
  quietHoursEnd: 7,
  quietOnShabbat: false,
  alerts: {
    unpacked: true,
    duplicate: true,
    largeOrder: true,
    failedPayments: true,
  },
};
