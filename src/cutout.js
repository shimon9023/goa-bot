// חיתוך הרקע הלבן והמרה ל-WebP.
//
// ג'מיני מחזיר את המוצר על רקע לבן אחיד. כאן הופכים את הרקע לשקוף,
// חותכים את השוליים כך שהמוצר ימלא את הפריים, ושומרים כ-WebP.
//
// למה מילוי משטח ולא "כל פיקסל לבן": למוצר עצמו יש לבן בפנים —
// תוויות, ברק, אריזה. מחיקה לפי צבע בלבד תנקב חורים באמצע המוצר.
// לכן מתחילים מהשוליים של התמונה ומתפשטים פנימה, וכל לבן
// שאינו מחובר לשוליים נשאר.
//
// הכל עטוף: אם sharp לא נטען או משהו נכשל, מחזירים את התמונה המקורית
// כמו שהיא. תמונה בלי שקיפות עדיפה על מוצר בלי תמונה.

let sharp = null;
let loadFailed = false;

async function load() {
  if (sharp || loadFailed) return sharp;

  try {
    const module = await import('sharp');
    sharp = module.default;
  } catch (error) {
    loadFailed = true;
    console.error('sharp לא נטען, התמונות יישארו כמו שהן:', error.message);
  }

  return sharp;
}

// כמה רחוק מלבן עדיין נחשב רקע. 255 הוא לבן מוחלט.
const TOLERANCE = 30;

// שוליים סביב המוצר, באחוזים מהצלע הארוכה
const MARGIN = 0.03;

function isBackgroundColor(data, offset) {
  return (
    data[offset] >= 255 - TOLERANCE &&
    data[offset + 1] >= 255 - TOLERANCE &&
    data[offset + 2] >= 255 - TOLERANCE
  );
}

// מילוי משטח מהשוליים פנימה. מחזיר מסכה: 0 רקע, 255 מוצר.
function backgroundMask(data, width, height) {
  const count = width * height;
  const mask = new Uint8Array(count).fill(255);
  const queue = new Int32Array(count);

  let head = 0;
  let tail = 0;

  const push = (index) => {
    if (mask[index] === 0) return;
    if (!isBackgroundColor(data, index * 4)) return;
    mask[index] = 0;
    queue[tail++] = index;
  };

  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }

  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = (index - x) / width;

    if (x > 0) push(index - 1);
    if (x < width - 1) push(index + 1);
    if (y > 0) push(index - width);
    if (y < height - 1) push(index + width);
  }

  return mask;
}

// התיבה שבה יושב המוצר, כדי שהוא ימלא את הפריים
function boundingBox(mask, width, height) {
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;

    for (let x = 0; x < width; x += 1) {
      if (mask[row + x] === 0) continue;

      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }

  if (bottom < 0) return null;

  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * מקבל תמונה של מוצר על רקע לבן ומחזיר WebP שקוף,
 * חתוך לגבולות המוצר ומרופד לריבוע.
 */
export async function toTransparentWebp(buffer) {
  const lib = await load();
  if (!lib) return null;

  const image = lib(buffer).rotate();
  const { data, info } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const mask = backgroundMask(data, width, height);

  let removed = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i] === 0) removed += 1;

  // כמעט לא הוסר כלום: הרקע לא באמת לבן, ועדיף לא לגעת בתמונה
  if (removed / mask.length < 0.03) return null;

  const box = boundingBox(mask, width, height);

  // לא נשאר מוצר, או שנשארו רק כמה פיקסלים בודדים
  if (!box) return null;
  if ((box.width * box.height) / (width * height) < 0.01) return null;

  // המסכה עוברת טשטוש קל, וכך הקצה יוצא חלק ולא משונן.
  // sharp עלול להחזיר את המסכה בשלושה ערוצים, אז קוראים את הצעד מהתוצאה.
  const blurred = await lib(Buffer.from(mask), {
    raw: { width, height, channels: 1 },
  })
    .blur(0.8)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const step = blurred.info.channels;

  for (let i = 0; i < width * height; i += 1) {
    data[i * 4 + 3] = blurred.data[i * step];
  }

  const side = Math.max(box.width, box.height);
  const padding = Math.round(side * MARGIN);
  const canvas = side + padding * 2;

  return lib(data, { raw: { width, height, channels: 4 } })
    .extract(box)
    .resize({
      width: canvas,
      height: canvas,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality: 90, alphaQuality: 90, effort: 4 })
    .toBuffer();
}

/**
 * עטיפה בטוחה: מחזירה תמיד תמונה שאפשר להגיש,
 * גם כשהחיתוך לא הסתדר.
 */
export async function process(buffer, mimeType) {
  try {
    const webp = await toTransparentWebp(buffer);
    if (webp) return { buffer: webp, mimeType: 'image/webp' };
  } catch (error) {
    console.error('חיתוך הרקע נכשל, משתמש בתמונה המקורית:', error.message);
  }

  return { buffer, mimeType };
}
