/**
 * One-off: rasterize the VAELOR Economic Intelligence icon lockup
 * (the same geometry used inline on /news) into the site-wide logo assets.
 * Run once:  node scripts/render-logo.mjs
 */
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const iconSvg = (size) => `
<svg viewBox="0 0 190 190" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="iconGlow" cx="30%" cy="14%" r="90%">
      <stop offset="0%" stop-color="#e2456c" stop-opacity="0.5"/>
      <stop offset="38%" stop-color="#3a0d17" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="iconCore" cx="50%" cy="35%" r="75%">
      <stop offset="0%" stop-color="#171a20"/>
      <stop offset="100%" stop-color="#050608"/>
    </radialGradient>
    <linearGradient id="border" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#f2f4f8" stop-opacity="0.95"/>
      <stop offset="0.28" stop-color="#8d97a5" stop-opacity="0.6"/>
      <stop offset="0.5" stop-color="#39414c"/>
      <stop offset="0.72" stop-color="#12151a"/>
      <stop offset="1" stop-color="#07080a"/>
    </linearGradient>
    <linearGradient id="chromeLeft" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f4f6fa"/>
      <stop offset="0.38" stop-color="#b9c2ce"/>
      <stop offset="0.55" stop-color="#5f6a77"/>
      <stop offset="0.72" stop-color="#dfe4ec"/>
      <stop offset="1" stop-color="#59636f"/>
    </linearGradient>
    <linearGradient id="redRight" x1="0" y1="1" x2="0.75" y2="0">
      <stop offset="0" stop-color="#5c1220"/>
      <stop offset="0.35" stop-color="#e2456c"/>
      <stop offset="0.62" stop-color="#ff7288"/>
      <stop offset="0.85" stop-color="#8d1b31"/>
      <stop offset="1" stop-color="#380a13"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="182" height="182" rx="41" fill="url(#iconCore)" stroke="url(#border)" stroke-width="4"/>
  <rect x="4" y="4" width="182" height="182" rx="41" fill="url(#iconGlow)"/>
  <polygon points="34,46 80,146 108,146 62,46" fill="url(#chromeLeft)"/>
  <polygon points="41,50 48,60 86,142 77,142" fill="#ffffff" opacity="0.35"/>
  <polygon points="120,146 164,46 134,46 108,146" fill="url(#redRight)"/>
  <polygon points="129,146 157,50 149,50 117,146" fill="#ffd6dc" opacity="0.4"/>
  <circle cx="154" cy="132" r="9" fill="url(#chromeLeft)" stroke="#05070a" stroke-width="1.5"/>
</svg>`;

const fullSvg = (width) => `
<svg viewBox="0 0 760 214" width="${width}" height="${Math.round((214 / 760) * width)}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="iconGlow" cx="17%" cy="10%" r="70%">
      <stop offset="0%" stop-color="#e2456c" stop-opacity="0.55"/>
      <stop offset="45%" stop-color="#1a0a0e" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="chromeLeft" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f4f6fa"/><stop offset="0.38" stop-color="#b9c2ce"/><stop offset="0.55" stop-color="#5f6a77"/><stop offset="0.72" stop-color="#dfe4ec"/><stop offset="1" stop-color="#59636f"/>
    </linearGradient>
    <linearGradient id="redRight" x1="0" y1="1" x2="0.75" y2="0">
      <stop offset="0" stop-color="#5c1220"/><stop offset="0.35" stop-color="#e2456c"/><stop offset="0.62" stop-color="#ff7288"/><stop offset="0.85" stop-color="#8d1b31"/><stop offset="1" stop-color="#380a13"/>
    </linearGradient>
    <radialGradient id="iconCore" cx="50%" cy="35%" r="75%">
      <stop offset="0%" stop-color="#171a20"/><stop offset="100%" stop-color="#050608"/>
    </radialGradient>
    <linearGradient id="border" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#f2f4f8" stop-opacity="0.95"/><stop offset="0.28" stop-color="#8d97a5" stop-opacity="0.6"/><stop offset="0.5" stop-color="#39414c"/><stop offset="0.72" stop-color="#12151a"/><stop offset="1" stop-color="#07080a"/>
    </linearGradient>
    <linearGradient id="wordChrome" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f7f9fd"/><stop offset="0.34" stop-color="#cfd6df"/><stop offset="0.52" stop-color="#737f8d"/><stop offset="0.62" stop-color="#2f3640"/><stop offset="0.78" stop-color="#c7ced8"/><stop offset="1" stop-color="#5a6572"/>
    </linearGradient>
    <linearGradient id="flareLine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/><stop offset="0.3" stop-color="#ffffff" stop-opacity="0.25"/><stop offset="0.68" stop-color="#ff96a6"/><stop offset="0.72" stop-color="#ffffff"/><stop offset="0.76" stop-color="#ff96a6"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="flare" cx="68%" cy="50%" r="50%">
      <stop offset="0" stop-color="#ff8fa0" stop-opacity="0.95"/><stop offset="0.18" stop-color="#e2456c" stop-opacity="0.85"/><stop offset="0.45" stop-color="#8d1b31" stop-opacity="0.35"/><stop offset="1" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="9"/></filter>
  </defs>
  <rect x="0" y="0" width="760" height="214" fill="#080809"/>
  <rect x="0" y="0" width="760" height="214" fill="url(#iconGlow)"/>
  <rect x="22" y="16" width="180" height="180" rx="40" fill="url(#iconCore)" stroke="url(#border)" stroke-width="3"/>
  <polygon points="52,54 96,150 124,150 80,54" fill="url(#chromeLeft)"/>
  <polygon points="59,58 66,68 100,146 92,146" fill="#ffffff" opacity="0.35"/>
  <polygon points="136,150 178,54 148,54 122,150" fill="url(#redRight)"/>
  <polygon points="145,150 171,58 163,58 131,150" fill="#ffd6dc" opacity="0.4"/>
  <circle cx="168" cy="136" r="8.5" fill="url(#chromeLeft)" stroke="#05070a" stroke-width="1.5"/>
  <text x="224" y="112" font-family="Inter, 'Arial Black', Arial, sans-serif" font-size="78" font-weight="800" letter-spacing="2" fill="url(#wordChrome)">VAELOR</text>
  <line x1="226" y1="134" x2="726" y2="134" stroke="url(#flareLine)" stroke-width="1.4"/>
  <ellipse cx="566" cy="134" rx="140" ry="6" fill="url(#flare)" filter="url(#soft)" opacity="0.85"/>
  <circle cx="566" cy="134" r="1.8" fill="#ffffff"/>
  <text x="226" y="166" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="500" letter-spacing="11.4" fill="#98a4b3">ECONOMIC INTELLIGENCE</text>
</svg>`;

const icon512 = iconSvg(512);
await sharp(Buffer.from(icon512)).png().toFile('public/vaelor-icon.png');
await sharp(Buffer.from(iconSvg(256))).resize(256).png().toFile('public/vaelor-logo.png');
await sharp(Buffer.from(iconSvg(512))).resize(180).png().toFile('public/apple-touch-icon.png');
await sharp(Buffer.from(iconSvg(512))).resize(32).png().toFile('public/favicon-32.png');
writeFileSync('public/vaelor-economic-intelligence.svg', fullSvg(1500));
console.log('rendered: vaelor-icon.png (512), vaelor-logo.png (256), apple-touch-icon.png (180), favicon-32.png (32), vaelor-economic-intelligence.svg');
