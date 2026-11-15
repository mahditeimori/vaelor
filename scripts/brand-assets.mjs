/**
 * Brand assets from the uploaded master artwork.
 * Source: C:\Users\takpc\Downloads\logo v.png  (2172x724)
 *
 * What it does
 *  1. Fades the artwork's black backdrop to transparency (luminance ramp) so the
 *     logo sits on the site background instead of inside a black box.
 *  2. Rebuilds the wordmark as "VAELOR.LLC": the authentic chrome VAELOR letters are
 *     cropped from the source, the ".TRADING" tail is removed, and a matching chrome
 *     ".LLC" suffix is composited in its place.
 *  3. Emits a brightened "V" squircle for the web logo (favicon / touch icon / header).
 *
 * Run: node scripts/brand-assets.mjs
 */
import sharp from 'sharp';

const SOURCE = process.env.BRAND_SOURCE ?? `${process.env.USERPROFILE}\\Downloads\\logo v.png`;

/* Geometry inside the 2172x724 source artwork */
const GEO = {
  icon: { left: 121, top: 115, width: 441, height: 441 },
  wordmark: { left: 660, top: 140, width: 1050, height: 185 }, // authentic "VAELOR"
  tailErase: { left: 1730, top: 140, width: 442, height: 185 }, // old ".TRADING"
  llcAt: { left: 1752, top: 148 },
};

/* ---------- 1 · fade the black backdrop to transparency ---------- */
async function fadeBackdrop(input, { erase = [] } = {}) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const x = i % width;
    const y = (i - (i % width)) / width;
    const inErase = erase.some((r) => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height);
    if (inErase) {
      data[o + 3] = 0; // drop the old wordmark tail entirely
      continue;
    }
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const sat = max - min;
    let a;
    if (sat < 25) {
      // neutral (chrome/white) pixels: keep solid, but let the near-black die away
      a = lum <= 10 ? 0 : lum < 60 ? Math.round(((lum - 10) / 50) * 255) : 255;
    } else {
      // coloured pixels (red glow): fade proportionally so the halo softens
      a = Math.round(Math.min(1, Math.max(0, (lum - 6) / 70)) ** 1.25 * 255);
    }
    data[o + 3] = Math.round(a);
  }
  return { data, info };
}

function fromRaw({ data, info }) {
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
}

/* ---------- 2 · chrome ".LLC" suffix ---------- */
function llcSvg() {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="440" height="190">
  <defs>
    <linearGradient id="ch" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.26" stop-color="#e2e7ee"/>
      <stop offset="0.46" stop-color="#9aa5b3"/>
      <stop offset="0.58" stop-color="#39424f"/>
      <stop offset="0.74" stop-color="#e6ebf2"/>
      <stop offset="1" stop-color="#79838f"/>
    </linearGradient>
  </defs>
  <text x="6" y="152" font-family="Inter, 'Arial Black', Arial, sans-serif" font-size="132"
        font-weight="800" letter-spacing="1" fill="url(#ch)">.LLC</text>
</svg>`);
}

/* ---------- build ---------- */
const meta = await sharp(SOURCE).metadata();
console.log(`source: ${SOURCE} (${meta.width}x${meta.height})`);

/* base artwork with transparent backdrop and the old ".TRADING" tail removed */
const base = await fromRaw(await fadeBackdrop(SOURCE, { erase: [GEO.tailErase] })).png().toBuffer();

/* composite the chrome ".LLC" suffix */
const withLlc = await sharp(base)
  .composite([{ input: llcSvg(), left: GEO.llcAt.left, top: GEO.llcAt.top }])
  .png()
  .toBuffer();

/* header / hero lockup (transparent, 2x density for the 44-50px header slot) */
await sharp(withLlc).resize({ width: 760 }).png({ compressionLevel: 9 }).toFile('public/vaelor-trading-intelligence.png');

/* the "V" squircle — brighter for the top-left slot */
const iconRaw = await sharp(SOURCE).extract(GEO.icon).png().toBuffer();
const icon = await fromRaw(await fadeBackdrop(iconRaw)).modulate({ brightness: 1.14, saturation: 1.08 }).png().toBuffer();
await sharp(icon).resize(512, 512, { fit: 'cover' }).png({ compressionLevel: 9 }).toFile('public/vaelor-icon.png');
await sharp(icon).resize(256, 256, { fit: 'cover' }).png({ compressionLevel: 9 }).toFile('public/vaelor-mark.png');
await sharp(icon).resize(180, 180, { fit: 'cover' }).png({ compressionLevel: 9 }).toFile('public/apple-touch-icon.png');
await sharp(icon).resize(32, 32, { fit: 'cover' }).png({ compressionLevel: 9 }).toFile('public/favicon-32.png');
await sharp(icon).png({ compressionLevel: 9 }).toFile('public/vaelor-v.png');

console.log('rendered: vaelor-trading-intelligence.png (VAELOR.LLC, transparent), vaelor-v/icon/mark, apple-touch-icon, favicon-32');
