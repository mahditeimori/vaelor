/**
 * CFTC Commitments of Traders ingestion (Cloudflare Worker runtime).
 *
 * Sources (all fetched live from cftc.gov, never user-touched):
 *  - https://www.cftc.gov/dea/newcot/deafut.txt      Legacy futures-only, latest week
 *  - https://www.cftc.gov/dea/newcot/f_disagg.txt    Disaggregated futures-only, latest week
 *  - https://www.cftc.gov/dea/newcot/FinFutWk.txt    Traders in Financial Futures (TFF)
 *  - https://www.cftc.gov/files/dea/history/deacot{year}.zip   Annual legacy history
 *
 * The weekly files are header-less CSV; the annual archive ships annual.txt with
 * a header row. ZIP entries are inflated with DecompressionStream('deflate-raw')
 * so no Node-only dependency is required.
 */
import { splitCsvRow, parseNum, cell } from './csv.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const LEGACY_URL = 'https://www.cftc.gov/dea/newcot/deafut.txt';
const DISAGG_URL = 'https://www.cftc.gov/dea/newcot/f_disagg.txt';
const TFF_URL = 'https://www.cftc.gov/dea/newcot/FinFutWk.txt';
const HISTORY_URLS = [
  'https://www.cftc.gov/files/dea/history/deacot2025.zip',
  'https://www.cftc.gov/files/dea/history/deacot2026.zip',
];

/** Column indices for header-less weekly files (0-based). */
const LEGACY_IDX = {
  code: 3,
  date: 2,
  oi: 7,
  nonCommLong: 8,
  nonCommShort: 9,
  nonCommSpread: 10,
  commLong: 11,
  commShort: 12,
  totRepLong: 13,
  totRepShort: 14,
  nonReptLong: 15,
  nonReptShort: 16,
};

const DISAGG_IDX = {
  code: 3,
  date: 2,
  oi: 7,
  prodLong: 8,
  prodShort: 9,
  swapLong: 10,
  swapShort: 11,
  mmLong: 13,
  mmShort: 14,
  otherLong: 16,
  otherShort: 17,
};

const TFF_IDX = {
  code: 3,
  date: 2,
  oi: 7,
  dealerLong: 8,
  dealerShort: 9,
  amLong: 11,
  amShort: 12,
  lmLong: 14,
  lmShort: 15,
  otherLong: 17,
  otherShort: 18,
};

async function fetchText(url, timeoutMs = 60_000) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/plain,*/*' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw new Error(`CFTC fetch failed for ${url}: ${String(lastErr?.message ?? lastErr)}`);
}

async function fetchBuffer(url, timeoutMs = 90_000) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.arrayBuffer();
}

/* ------------------------------------------------------------------ */
/* Minimal ZIP reader (central directory + raw deflate)                */
/* ------------------------------------------------------------------ */

function readCentralDirectory(buffer) {
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  let eocd = -1;
  const min = Math.max(0, u8.length - 66_000);
  for (let i = u8.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record not found');

  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const fnLen = dv.getUint16(p + 28, true);
    const exLen = dv.getUint16(p + 30, true);
    const cmLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + fnLen));
    entries.push({ name, method, compSize, localOff });
    p += 46 + fnLen + exLen + cmLen;
  }
  return { dv, u8, entries };
}

function entryStream(buffer, entry) {
  const { dv, u8 } = readCentralDirectory(buffer);
  const off = entry.localOff;
  if (dv.getUint32(off, true) !== 0x04034b50) throw new Error('ZIP local header corrupt');
  const fnLen = dv.getUint16(off + 26, true);
  const exLen = dv.getUint16(off + 28, true);
  const start = off + 30 + fnLen + exLen;
  const size = entry.compSize > 0 ? entry.compSize : u8.length - start;
  const compressed = u8.subarray(start, start + size);
  const raw = new Blob([compressed]).stream();
  return entry.method === 0 ? raw : raw.pipeThrough(new DecompressionStream('deflate-raw'));
}

/** Async iterator over the lines of a zip entry (streamed, low memory). */
async function* zipLines(buffer) {
  const { entries } = readCentralDirectory(buffer);
  const entry = entries.find((e) => /\.(txt|csv)$/i.test(e.name) && /annual/i.test(e.name))
    ?? entries.find((e) => /\.(txt|csv)$/i.test(e.name));
  if (!entry) throw new Error('no text entry inside archive');

  const reader = entryStream(buffer, entry).pipeThrough(new TextDecoderStream()).getReader();
  let carry = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += value;
    let idx;
    while ((idx = carry.indexOf('\n')) >= 0) {
      const line = carry.slice(0, idx).replace(/\r$/, '');
      carry = carry.slice(idx + 1);
      yield line;
    }
  }
  if (carry) yield carry;
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function toLegacyRow(cells, idx) {
  return {
    date: cell(cells, idx.date) ?? '',
    oi: parseNum(cells[idx.oi]) ?? 0,
    nonCommLong: parseNum(cells[idx.nonCommLong]) ?? 0,
    nonCommShort: parseNum(cells[idx.nonCommShort]) ?? 0,
    nonCommSpread: parseNum(cells[idx.nonCommSpread]) ?? 0,
    commLong: parseNum(cells[idx.commLong]) ?? 0,
    commShort: parseNum(cells[idx.commShort]) ?? 0,
    totRepLong: parseNum(cells[idx.totRepLong]) ?? 0,
    totRepShort: parseNum(cells[idx.totRepShort]) ?? 0,
    nonReptLong: parseNum(cells[idx.nonReptLong]) ?? 0,
    nonReptShort: parseNum(cells[idx.nonReptShort]) ?? 0,
  };
}

/** Cheap pre-filter: does the raw line carry one of our contract codes? */
function lineMatchesCodes(line, codes) {
  for (const code of codes) {
    if (line.includes(`,${code},`)) return true;
  }
  return false;
}

export async function fetchLegacyLatest(codes) {
  const text = await fetchText(LEGACY_URL);
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || !lineMatchesCodes(line, codes)) continue;
    const cells = splitCsvRow(line);
    const code = cell(cells, LEGACY_IDX.code);
    if (!code || !codes.has(code)) continue;
    out.set(code, toLegacyRow(cells, LEGACY_IDX));
  }
  return out;
}

export async function fetchDisaggLatest(instruments) {
  const codes = new Set(
    instruments.filter((i) => i.cftcReportSource === 'disaggregated').map((i) => i.cftcContractCode),
  );
  if (codes.size === 0) return new Map();
  const text = await fetchText(DISAGG_URL);
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || !lineMatchesCodes(line, codes)) continue;
    const c = splitCsvRow(line);
    const code = cell(c, DISAGG_IDX.code);
    if (!code || !codes.has(code)) continue;
    const n = (i) => parseNum(c[i]) ?? 0;
    out.set(code, {
      date: cell(c, DISAGG_IDX.date) ?? '',
      oi: n(DISAGG_IDX.oi),
      source: 'disaggregated',
      categories: {
        'Producers / Merchants': { long: n(DISAGG_IDX.prodLong), short: n(DISAGG_IDX.prodShort) },
        'Swap Dealers': { long: n(DISAGG_IDX.swapLong), short: n(DISAGG_IDX.swapShort) },
        'Managed Money': { long: n(DISAGG_IDX.mmLong), short: n(DISAGG_IDX.mmShort) },
        'Other Reportables': { long: n(DISAGG_IDX.otherLong), short: n(DISAGG_IDX.otherShort) },
      },
    });
  }
  return out;
}

export async function fetchTffLatest(instruments) {
  const codes = new Set(
    instruments.filter((i) => i.cftcReportSource === 'financial').map((i) => i.cftcContractCode),
  );
  if (codes.size === 0) return new Map();
  const text = await fetchText(TFF_URL);
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || !lineMatchesCodes(line, codes)) continue;
    const c = splitCsvRow(line);
    const code = cell(c, TFF_IDX.code);
    if (!code || !codes.has(code)) continue;
    const n = (i) => parseNum(c[i]) ?? 0;
    out.set(code, {
      date: cell(c, TFF_IDX.date) ?? '',
      oi: n(TFF_IDX.oi),
      source: 'financial',
      categories: {
        'Dealers (Banks)': { long: n(TFF_IDX.dealerLong), short: n(TFF_IDX.dealerShort) },
        'Asset Managers': { long: n(TFF_IDX.amLong), short: n(TFF_IDX.amShort) },
        'Leveraged Funds': { long: n(TFF_IDX.lmLong), short: n(TFF_IDX.lmShort) },
        'Other Reportables': { long: n(TFF_IDX.otherLong), short: n(TFF_IDX.otherShort) },
      },
    });
  }
  return out;
}

/**
 * Download and parse the annual legacy history zips, streaming the bundled
 * annual.txt. The futures-only ("Old") columns match the weekly series.
 */
export async function fetchAnnualHistory(codes) {
  const results = await Promise.allSettled(HISTORY_URLS.map((u) => fetchBuffer(u)));
  const rows = new Map();

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    try {
      let idx = null;
      for await (const line of zipLines(r.value)) {
        if (!line) continue;
        if (!idx) {
          const header = splitCsvRow(line).map((h) => h.trim().replace(/^"|"$/g, ''));
          const idxOf = (name) => header.indexOf(name);
          idx = {
            code: idxOf('CFTC Contract Market Code'),
            date: idxOf('As of Date in Form YYYY-MM-DD'),
            oi: idxOf('Open Interest (Old)'),
            nonCommLong: idxOf('Noncommercial Positions-Long (Old)'),
            nonCommShort: idxOf('Noncommercial Positions-Short (Old)'),
            nonCommSpread: idxOf('Noncommercial Positions-Spreading (Old)'),
            commLong: idxOf('Commercial Positions-Long (Old)'),
            commShort: idxOf('Commercial Positions-Short (Old)'),
            totRepLong: idxOf('Total Reportable Positions-Long (Old)'),
            totRepShort: idxOf('Total Reportable Positions-Short (Old)'),
            nonReptLong: idxOf('Nonreportable Positions-Long (Old)'),
            nonReptShort: idxOf('Nonreportable Positions-Short (Old)'),
          };
          if (!idx || Object.values(idx).some((i) => i < 0)) break;
          continue;
        }
        if (!lineMatchesCodes(line, codes)) continue;
        const c = splitCsvRow(line);
        const code = cell(c, idx.code);
        if (!code || !codes.has(code)) continue;
        const row = toLegacyRow(c, idx);
        if (!row.date) continue;
        const arr = rows.get(code) ?? [];
        arr.push(row);
        rows.set(code, arr);
      }
    } catch {
      // Corrupt or partially available archive: keep whatever parsed.
      continue;
    }
  }

  for (const [code, arr] of rows) {
    const byDate = new Map();
    for (const row of arr) byDate.set(row.date, row);
    rows.set(
      code,
      [...byDate.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([, row]) => row),
    );
  }

  return rows;
}

export const CFTC_SOURCE_URLS = {
  legacy: LEGACY_URL,
  disaggregated: DISAGG_URL,
  tff: TFF_URL,
  history: HISTORY_URLS,
};
