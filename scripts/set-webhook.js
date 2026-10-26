// רישום הכתובת שטלגרם יפנה אליה. מריצים פעם אחת אחרי שהשרת עלה.

import { config } from '../src/config.js';
import { setWebhook } from '../src/telegram.js';

if (!config.publicBaseUrl) {
  console.error('חסר PUBLIC_BASE_URL. זאת הכתובת ש-Render נתן לשירות.');
  process.exit(1);
}

const url = `${config.publicBaseUrl}/telegram/webhook`;

try {
  await setWebhook(url);
  console.log(`הכתובת נרשמה בהצלחה: ${url}`);
} catch (error) {
  console.error('הרישום נכשל:', error.message);
  process.exit(1);
}
