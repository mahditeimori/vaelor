/**
 * Brand assets from the uploaded master logo photo.
 * Source: C:\Users\takpc\Downloads\logo v.png  (2172x724, exact uploaded artwork)
 *
 * Outputs
 *   public/vaelor-trading-intelligence.png  header lockup (exact photo, right-sized)
 *   public/vaelor-v.png                     the "V" squircle cut from the same artwork
 *   public/vaelor-icon.png                 512px "V" mark
 *   public/favicon-32.png                  32px "V" mark  (web logo / browser tab)
 *   public/apple-touch-icon.png             180px "V" mark
 *
 * Run: node scripts/brand-assets.mjs
 */
import sharp from 'sharp';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const SOURCE = process.env.BRAND_SOURCE ?? path.join(process.env.USERPROFILE ?? '', 'Downloads', 'logo v.png');
if (!existsSync(SOURCE)) {
  console.error(`Brand source not found: ${SOURCE}`);
  process.exit(1);
}

/* The squircle "V" icon occupies the left block of the artwork.
   Geometry below is expressed in the source's own pixel space (2172x724). */
const ICON_CROP = { left: 121, top: 115, width: 441, height: 441 };

const meta = await sharp(SOURCE).metadata();
console.log(`source: ${SOURCE} (${meta.width}x${meta.height})`);

/* 1 · header lockup — the exact photo, scaled down for the header (2x density) */
const lockupWidth = 640;
await sharp(SOURCE)
  .resize({ width: lockupWidth })
  .png({ quality: 92, compressionLevel: 9 })
  .toFile('public/vaelor-trading-intelligence.png');

/* 2 · the "V" squircle cut from the same artwork */
await sharp(SOURCE)
  .extract(ICON_CROP)
  .png()
  .toFile('public/vaelor-v.png');

/* 3 · web logo sizes from that cut-out */
await sharp('public/vaelor-v.png').resize(512, 512, { fit: 'cover' }).png().toFile('public/vaelor-icon.png');
await sharp('public/vaelor-v.png').resize(180, 180, { fit: 'cover' }).png().toFile('public/apple-touch-icon.png');
await sharp('public/vaelor-v.png').resize(32, 32, { fit: 'cover' }).png().toFile('public/favicon-32.png');

mkdirSync('public/downloads', { recursive: true });
console.log('rendered: vaelor-trading-intelligence.png, vaelor-v.png, vaelor-icon.png, apple-touch-icon.png, favicon-32.png');
