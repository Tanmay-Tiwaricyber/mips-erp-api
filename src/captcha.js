/**
 * Captcha solving for erp.mpgi.net (Asteroid365).
 *
 * The captcha is a 150x40 JPEG: 6 characters, lowercase a-z + 0-9, italic
 * serif font, red text on white, with a thin red strikethrough line through
 * the middle of the glyphs.
 *
 * Measured accuracy (40 real captchas, verified against the live server):
 *   raw tesseract              0-3%
 *   + red-channel threshold    20-32%
 *   + 6-variant majority vote  ~33%
 * Character segmentation and fixed-grid cropping BOTH fail: glyphs touch and
 * are sheared, so there is no clean vertical seam.
 *
 * Consequence, and why this is still workable:
 *   LoginStatus 9 ("Invalid Captcha") returns InvalidLoginAttempt: 0 — captcha
 *   failures are NOT counted as failed logins. So retrying with a fresh
 *   captcha is safe. At 33% per attempt, 10 attempts ≈ 98% success.
 *
 * `solveCaptcha` therefore implements: OCR -> caller tries -> on status 9 retry
 * with a brand-new captcha, and always exposes the image so a human can solve
 * it when OCR runs out of attempts.
 */

let _sharp = null;
let _tesseract = null;
let _worker = null;

export async function ocrAvailable() {
  // Free hosts offer 512 MB; tesseract.js is the single biggest consumer.
  // Set ENABLE_OCR=false to run lean in manual-captcha-only mode.
  if (String(process.env.ENABLE_OCR || 'true').toLowerCase() === 'false') return false;
  try {
    _sharp = _sharp || (await import('sharp')).default;
    _tesseract = _tesseract || (await import('tesseract.js'));
    return true;
  } catch {
    return false;
  }
}

async function getWorker() {
  if (_worker) return _worker;
  if (!(await ocrAvailable())) throw new Error('OCR dependencies not installed (sharp + tesseract.js)');
  _worker = await _tesseract.createWorker('eng', 1, { logger: () => {} });
  await _worker.setParameters({
    tessedit_char_whitelist: 'abcdefghijklmnopqrstuvwxyz0123456789',
    tessedit_pageseg_mode: '7', // single uniform line of text
  });
  return _worker;
}

/**
 * Binarize: keep only reddish pixels (the glyphs), drop the white background,
 * then erase rows that are too "full" — those are the strikethrough line.
 * Finally tight-crop to the ink and upscale for tesseract.
 */
async function preprocess(buf, { thr = 95, scale = 8, removeLine = true, pad = 25 } = {}) {
  const sharp = _sharp;
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const bin = Buffer.alloc(width * height, 255);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r > thr && r - g > 40 && r - b > 40) bin[y * width + x] = 0;
    }
  }

  if (removeLine) {
    const rowDark = new Float32Array(height);
    for (let y = 0; y < height; y++) {
      let c = 0;
      for (let x = 0; x < width; x++) if (bin[y * width + x] === 0) c++;
      rowDark[y] = c / width;
    }
    const mx = Math.max(...rowDark);
    if (mx > 0.45) {
      for (let y = 0; y < height; y++) {
        if (rowDark[y] > mx * 0.6) {
          for (let x = 0; x < width; x++) bin[y * width + x] = 255;
        }
      }
    }
  }

  // tight crop
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bin[y * width + x] === 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const crop = Buffer.alloc(w * h, 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) crop[y * w + x] = bin[(y + minY) * width + (x + minX)];
  }

  return sharp(crop, { raw: { width: w, height: h, channels: 1 } })
    .resize({ width: Math.round(w * scale), kernel: 'cubic' })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();
}

const VARIANTS = [
  { thr: 95, scale: 8, removeLine: true },
  { thr: 90, scale: 6, removeLine: true },
  { thr: 100, scale: 4, removeLine: true },
];

/**
 * OCR a captcha. Runs a few preprocessing variants and majority-votes the
 * 6-character answers. Returns null if every variant produced junk.
 * @param {Buffer} image
 * @returns {Promise<{text: string|null, candidates: string[]}>}
 */
export async function solveCaptcha(image) {
  if (!(await ocrAvailable())) return { text: null, candidates: [], reason: 'OCR_UNAVAILABLE' };
  const worker = await getWorker();
  const candidates = [];

  for (const v of VARIANTS) {
    try {
      const png = await preprocess(image, v);
      if (!png) continue;
      const { data } = await worker.recognize(png);
      const clean = (data.text || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (clean.length === 6) candidates.push(clean);
      else if (clean.length === 5 || clean.length === 7) candidates.push(clean);
    } catch {
      /* try next variant */
    }
  }

  const votes = new Map();
  for (const c of candidates) {
    if (c.length !== 6) continue;
    votes.set(c, (votes.get(c) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [c, n] of votes) {
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  if (!best && candidates.length) best = candidates[0];

  return { text: best, candidates };
}

export async function shutdownOcr() {
  if (_worker) {
    try {
      await _worker.terminate();
    } catch {
      /* ignore */
    }
    _worker = null;
  }
}
