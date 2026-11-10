/**
 * CFTC Commitments of Traders ingestion.
 *
 * Sources (all fetched live from cftc.gov, never user-touched):
 *  - https://www.cftc.gov/dea/newcot/deafut.txt      Legacy futures-only, latest week
 *  - https://www.cftc.gov/dea/newcot/f_disagg.txt    Disaggregated futures-only, latest week
 *  - https://www.cftc.gov/dea/newcot/FinFutWk.txt    Traders in Financial Futures (TFF), latest week
 *  - https://www.cftc.gov/files/dea/history/deacot{year}.zip  Annual legacy history (annual.txt)
 *
 * All current files are comma-delimited with quoted fields. The annual file ships
 * a header row; the weekly files do not. The legacy "Old" section holds the
 * futures-only series, which is the series used for charts and KPIs.
 */
import AdmZip from 'adm-zip';
import { CFTC_CODES, type Instrument } from './instruments';
import { splitCsvRow, parseNum, cell } from './csv';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const LEGACY_URL = 'https://www.cftc.gov/dea/newcot/deafut.txt';
const DISAGG_URL = 'https://www.cftc.gov/dea/newcot/f_disagg.txt';
const TFF_URL = 'https://www.cftc.gov/dea/newcot/FinFutWk.txt';
const HISTORY_URLS = [
  'https://www.cftc.gov/files/dea/history/deacot2025.zip',
  'https://www.cftc.gov/files/dea/history/deacot2026.zip',
];

export interface LegacyRow {
  date: string;
  oi: number;
  nonCommLong: number;
  nonCommShort: number;
  nonCommSpread: number;
  commLong: number;
  commShort: number;
  totRepLong: number;
  totRepShort: number;
  nonReptLong: number;
  nonReptShort: number;
}

export interface CategorySnapshot {
  date: string;
  oi: number;
  source: 'disaggregated' | 'financial';
  /** category -> {long, short} */
  categories: Record<string, { long: number; short: number }>;
}

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
} as const;

const DISAGG_IDX = {
  code: 3,
  date: 2,
  oi: 7,
  prodLong: 8,
  prodShort: 9,
  swapLong: 10,
  swapShort: 11,
  swapSpread: 12,
  mmLong: 13,
  mmShort: 14,
  mmSpread: 15,
  otherLong: 16,
  otherShort: 17,
  otherSpread: 18,
  totRepLong: 19,
  totRepShort: 20,
} as const;

const TFF_IDX = {
  code: 3,
  date: 2,
  oi: 7,
  dealerLong: 8,
  dealerShort: 9,
  dealerSpread: 10,
  amLong: 11,
  amShort: 12,
  amSpread: 13,
  lmLong: 14,
  lmShort: 15,
  lmSpread: 16,
  otherLong: 17,
  otherShort: 18,
  otherSpread: 19,
  totRepLong: 20,
  totRepShort: 21,
} as const;

async function fetchText(url: string, timeoutMs = 60_000): Promise<string> {
  let lastErr: unknown = null;
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
  throw new Error(`CFTC fetch failed for ${url}: ${String((lastErr as Error)?.message ?? lastErr)}`);
}

async function fetchBuffer(url: string, timeoutMs = 90_000): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function toLegacyRow(cells: string[], idx: typeof LEGACY_IDX): LegacyRow {
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
function lineMatchesCodes(line: string, codes: ReadonlySet<string>): boolean {
  for (const code of codes) {
    if (line.includes(`,${code},`)) return true;
  }
  return false;
}

/**
 * Fetch the latest legacy week (deafut.txt) for the given contract codes.
 * Returns a map of contract code -> row.
 */
export async function fetchLegacyLatest(codes: ReadonlySet<string>): Promise<Map<string, LegacyRow>> {
  const text = await fetchText(LEGACY_URL);
  const out = new Map<string, LegacyRow>();
  for (const line of text.split(/\r?\n/)) {
    if (!line || !lineMatchesCodes(line, codes)) continue;
    const cells = splitCsvRow(line);
    const code = cell(cells, LEGACY_IDX.code);
    if (!code || !codes.has(code)) continue;
    out.set(code, toLegacyRow(cells, LEGACY_IDX));
  }
  return out;
}

/**
 * Fetch the latest disaggregated week (f_disagg.txt) for codes whose
 * report source is 'disaggregated'.
 */
export async function fetchDisaggLatest(
  instruments: readonly Instrument[],
): Promise<Map<string, CategorySnapshot>> {
  const codes = new Set(
    instruments.filter((i) => i.cftcReportSource === 'disaggregated').map((i) => i.cftcContractCode),
  );
  if (codes.size === 0) return new Map();
  const text = await fetchText(DISAGG_URL);
  const out = new Map<string, CategorySnapshot>();
  for (const line of text.split(/\r?\n/)) {
    if (!line || !lineMatchesCodes(line, codes)) continue;
    const c = splitCsvRow(line);
    const code = cell(c, DISAGG_IDX.code);
    if (!code || !codes.has(code)) continue;
    const n = (i: number) => parseNum(c[i]) ?? 0;
    out.set(code, {
      date: cell(c, DISAGG_IDX.date) ?? '',
      oi: n(DISAGG_IDX.oi),
      source: 'disaggregated',
      categories: {
        'Producers / Merchants': {
          long: n(DISAGG_IDX.prodLong),
          short: n(DISAGG_IDX.prodShort),
        },
        'Swap Dealers': { long: n(DISAGG_IDX.swapLong), short: n(DISAGG_IDX.swapShort) },
        'Managed Money': { long: n(DISAGG_IDX.mmLong), short: n(DISAGG_IDX.mmShort) },
        'Other Reportables': { long: n(DISAGG_IDX.otherLong), short: n(DISAGG_IDX.otherShort) },
      },
    });
  }
  return out;
}

/**
 * Fetch the latest TFF week (FinFutWk.txt) for codes whose report source
 * is 'financial'.
 */
export async function fetchTffLatest(
  instruments: readonly Instrument[],
): Promise<Map<string, CategorySnapshot>> {
  const codes = new Set(
    instruments.filter((i) => i.cftcReportSource === 'financial').map((i) => i.cftcContractCode),
  );
  if (codes.size === 0) return new Map();
  const text = await fetchText(TFF_URL);
  const out = new Map<string, CategorySnapshot>();
  for (const line of text.split(/\r?\n/)) {
    if (!line || !lineMatchesCodes(line, codes)) continue;
    const c = splitCsvRow(line);
    const code = cell(c, TFF_IDX.code);
    if (!code || !codes.has(code)) continue;
    const n = (i: number) => parseNum(c[i]) ?? 0;
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
 * Download and parse the annual legacy history zips (deacot{year}.zip).
 * The bundled annual.txt has a header row; the "Old" section is futures-only,
 * matching the weekly deafut.txt series.
 */
export async function fetchAnnualHistory(
  codes: ReadonlySet<string>,
): Promise<Map<string, LegacyRow[]>> {
  const results = await Promise.allSettled(HISTORY_URLS.map((u) => fetchBuffer(u)));
  const rows = new Map<string, LegacyRow[]>();

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    let text: string;
    try {
      const zip = new AdmZip(r.value);
      const entry = zip.getEntry('annual.txt');
      if (!entry) continue;
      text = entry.getData().toString('utf8');
    } catch {
      continue;
    }

    const lines = text.split(/\r?\n/);
    // The annual header quotes every cell — strip quotes before matching names.
    const header = splitCsvRow(lines[0] ?? '').map((h) => h.trim().replace(/^"|"$/g, ''));
    const idxOf = (name: string): number => header.indexOf(name);

    // Resolve the futures-only ("Old") section indices from the header row.
    const idx = {
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
    if (Object.values(idx).some((i) => i < 0)) continue;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !lineMatchesCodes(line, codes)) continue;
      const c = splitCsvRow(line);
      const code = cell(c, idx.code);
      if (!code || !codes.has(code)) continue;
      const row = toLegacyRow(c, idx);
      if (!row.date) continue;
      const arr = rows.get(code) ?? [];
      arr.push(row);
      rows.set(code, arr);
    }
  }

  // Sort ascending by report date and dedupe (later occurrence wins).
  for (const [code, arr] of rows) {
    const byDate = new Map<string, LegacyRow>();
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

/** URL manifest used by sync status reporting. */
export const CFTC_SOURCE_URLS = {
  legacy: LEGACY_URL,
  disaggregated: DISAGG_URL,
  tff: TFF_URL,
  history: HISTORY_URLS,
};
