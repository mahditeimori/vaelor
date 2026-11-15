/**
 * Rewrites src/pages/news.astro's <style> block into a global stylesheet
 * scoped under #newsPage.
 *
 * Why: Astro scopes page styles with a data-astro-cid attribute, but the
 * calendar rows, day separators and engine cards are injected client-side
 * (innerHTML) and therefore carry no scope attribute — their scoped rules
 * never matched, which is why the table rendered as a mess.
 *
 * Run: node scripts/news-style-scope.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/pages/news.astro';
const SCOPE = '#newsPage ';

const source = readFileSync(FILE, 'utf8');
const styleMatch = source.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) {
  console.error('no <style> block found');
  process.exit(1);
}
const css = styleMatch[1];

/** Prefix every selector in a rule body, recursing into @media blocks. */
function prefixRules(body) {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const braceStart = body.indexOf('{', i);
    if (braceStart === -1) {
      out += body.slice(i);
      break;
    }
    const selector = body.slice(i, braceStart).trim();
    // find matching closing brace
    let depth = 1;
    let j = braceStart + 1;
    while (j < body.length && depth > 0) {
      if (body[j] === '{') depth++;
      else if (body[j] === '}') depth--;
      j++;
    }
    const inner = body.slice(braceStart + 1, j - 1);
    const trimmed = selector.trim();

    if (trimmed.startsWith('@')) {
      const nested = trimmed.startsWith('@media') ? prefixRules(inner) : inner;
      out += `${trimmed} { ${nested} }`;
    } else {
      const prefixed = trimmed
        .split(',')
        .map((s) => {
          const sel = s.trim();
          if (!sel) return sel;
          if (sel.startsWith(SCOPE.trim())) return sel;
          return `${SCOPE}${sel}`;
        })
        .join(', ');
      out += `${prefixed} { ${inner} }`;
    }
    i = j;
  }
  return out;
}

const globalCss = prefixRules(css);
const next = source.replace(/<style>[\s\S]*?<\/style>/, `<style is:global>\n${globalCss}\n</style>`);
writeFileSync(FILE, next);
console.log('news.astro stylesheet is now global and scoped to #newsPage');
