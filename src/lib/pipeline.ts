/**
 * Data pipeline orchestration for the macro/COT hub.
 *
 *  - syncCOT():       CFTC legacy history (annual zips) + latest week + category snapshot
 *  - syncVolumeOi():  Yahoo daily volume series + best-effort quote (OI falls back to CFTC)
 *  - runBootstrap():  on-boot initial scrape when the cache is empty or stale
 *  - buildTerminalState(): assemble the JSON payload served to the frontend (no network)
 */
import { INSTRUMENTS } from './instruments';
import * as cftc from './cftc';
import * as yahoo from './yahoo';
import {
  ensureDirs,
  readJson,
  writeJsonAtomic,
  STATUS_FILE,
  cotFile,
  volumeFile,
  isoNow,
  daysSince,
  hoursSince,
} from './store';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface CotCandle {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CotSeriesRow {
  date: string;
  oi: number;
  commLong: number;
  commShort: number;
  nonCommLong: number;
  nonCommShort: number;
  nonCommSpread: number;
  totRepLong: number;
  commNet: number;
  commNetChange: number | null;
  nonCommNet: number;
  nonCommNetChange: number | null;
  oiChange: number | null;
  /** Weekly COT OHLC candle computed from commercial net + OI change. */
  candle: CotCandle | null;
}

export interface CotCache {
  instrumentId: string;
  updatedAt: string;
  source: string;
  reportDate: string | null;
  series: CotSeriesRow[];
  snapshot: cftc.CategorySnapshot | null;
}

export interface MarketCache {
  instrumentId: string;
  updatedAt: string;
  provider: string;
  lastPrice: number | null;
  dailyVolume: number | null;
  dailyVolumeDelta: number | null;
  openInterest: number | null;
  openInterestSource: 'yahoo-quote' | 'cftc-fallback' | null;
  series: { date: string; close: number | null; volume: number | null }[];
}

export interface SyncStatus {
  cftc: {
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastVerifiedAt: string | null;
    ok: boolean;
    latestReportDate: string | null;
    sourceFiles: string[];
    error: string | null;
  };
  volumeOi: {
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    ok: boolean;
    provider: string;
    error: string | null;
  };
  finviz: { proxy: 'active'; note: string };
  cron: {
    startedAt: string | null;
    timezone: 'UTC';
    jobs: { id: string; schedule: string; timezone: 'UTC'; description: string }[];
  };
  bootstrap: {
    ranAt: string | null;
    cotSynced: boolean;
    volumeSynced: boolean;
    cotOk: boolean;
    volumeOk: boolean;
  };
}

export const CRON_JOBS = [
  {
    id: 'cftc_release_watcher',
    schedule: '*/5 19-22 * * 5',
    timezone: 'UTC' as const,
    description:
      'Polls CFTC.gov every 5 minutes during the Friday release window until the new weekly report date is ingested.',
  },
  {
    id: 'cftc_daily_integrity_sync',
    schedule: '5 0 * * *',
    timezone: 'UTC' as const,
    description: 'Daily verification of CFTC Legacy, Disaggregated and TFF reports.',
  },
  {
    id: 'futures_volume_oi_sync',
    schedule: '0 * * * 1-5',
    timezone: 'UTC' as const,
    description:
      'Hourly sync of futures daily volume and open interest for GC=F, SI=F, DX=F, NQ=F, ES=F, YM=F.',
  },
] as const;

const DEFAULT_STATUS: SyncStatus = {
  cftc: {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastVerifiedAt: null,
    ok: false,
    latestReportDate: null,
    sourceFiles: [],
    error: null,
  },
  volumeOi: {
    lastAttemptAt: null,
    lastSuccessAt: null,
    ok: false,
    provider: 'Yahoo Finance v8 chart (+ v7 quote best-effort, CFTC OI fallback)',
    error: null,
  },
  finviz: {
    proxy: 'active',
    note: 'Server-side proxy with browser headers; degrades gracefully when the upstream blocks the request.',
  },
  cron: { startedAt: null, timezone: 'UTC', jobs: [...CRON_JOBS] },
  bootstrap: { ranAt: null, cotSynced: false, volumeSynced: false, cotOk: false, volumeOk: false },
};

export async function readStatus(): Promise<SyncStatus> {
  const s = await readJson<SyncStatus>(STATUS_FILE);
  return s ?? { ...DEFAULT_STATUS, cron: { ...DEFAULT_STATUS.cron, jobs: [...CRON_JOBS] } };
}

async function writeStatus(status: SyncStatus): Promise<void> {
  await writeJsonAtomic(STATUS_FILE, status);
}

export { writeStatus };

/**
 * Serialized read-modify-write around the status file so concurrent syncs
 * (bootstrap + cron jobs) can never clobber each other's status updates.
 */
let statusLock: Promise<void> = Promise.resolve();

async function withStatus<T>(fn: (status: SyncStatus) => Promise<T> | T): Promise<T> {
  let release!: () => void;
  const prev = statusLock;
  statusLock = new Promise<void>((r) => { release = r; });
  await prev;
  try {
    const status = await readStatus();
    const result = await fn(status);
    await writeStatus(status);
    return result;
  } finally {
    release();
  }
}

export { withStatus };

/* ------------------------------------------------------------------ */
/* COT sync                                                            */
/* ------------------------------------------------------------------ */

/** Stale when missing or older than the weekly cadence plus margin. */
export function cotIsStale(cache: CotCache | null, status: SyncStatus): boolean {
  if (!cache?.reportDate) return true;
  const age = daysSince(cache.updatedAt);
  return age === null || age > 9;
}

let cotSyncInFlight = false;

/**
 * Full CFTC sync: history from annual zips, latest week from deafut.txt,
 * category snapshot from f_disagg.txt / FinFutWk.txt. Writes per-instrument
 * caches plus the sync status. Never throws.
 */
export async function syncCOT(): Promise<void> {
  if (cotSyncInFlight) return;
  cotSyncInFlight = true;
  await withStatus((status) => { status.cftc.lastAttemptAt = isoNow(); });
  const files: string[] = [];
  try {
    const history = await cftc.fetchAnnualHistory(new Set(INSTRUMENTS.map((i) => i.cftcContractCode)));
    files.push(...cftc.CFTC_SOURCE_URLS.history);
    const latest = await cftc.fetchLegacyLatest(new Set(INSTRUMENTS.map((i) => i.cftcContractCode)));
    files.push('deafut.txt');
    const disagg = await cftc.fetchDisaggLatest(INSTRUMENTS);
    files.push('f_disagg.txt');
    const tff = await cftc.fetchTffLatest(INSTRUMENTS);
    files.push('FinFutWk.txt');

    let newestReportDate: string | null = null;

    for (const inst of INSTRUMENTS) {
      const hist = history.get(inst.cftcContractCode) ?? [];
      const live = latest.get(inst.cftcContractCode);
      const series: cftc.LegacyRow[] = [...hist];
      if (live) {
        const last = series[series.length - 1];
        if (!last || live.date > last.date) series.push(live);
        else if (live.date === last.date) series[series.length - 1] = live;
      }

      const derived = deriveSeries(series);
      const reportDate = derived.length ? derived[derived.length - 1].date : null;
      if (reportDate && (!newestReportDate || reportDate > newestReportDate)) {
        newestReportDate = reportDate;
      }

      const cache: CotCache = {
        instrumentId: inst.id,
        updatedAt: isoNow(),
        source: 'CFTC Legacy futures-only (annual history + weekly deafut.txt)',
        reportDate,
        series: derived.slice(-104),
        snapshot: disagg.get(inst.cftcContractCode) ?? tff.get(inst.cftcContractCode) ?? null,
      };
      await writeJsonAtomic(cotFile(inst.id), cache);
    }

    await withStatus((status) => {
      status.cftc.ok = true;
      status.cftc.lastSuccessAt = isoNow();
      status.cftc.latestReportDate = newestReportDate;
      status.cftc.sourceFiles = files;
      status.cftc.error = null;
    });
    console.log(`[pipeline] CFTC sync OK — latest report ${newestReportDate ?? 'n/a'}`);
  } catch (e) {
    await withStatus((status) => {
      status.cftc.ok = false;
      status.cftc.error = String((e as Error)?.message ?? e);
    });
    console.error('[pipeline] CFTC sync failed:', String((e as Error)?.message ?? e));
  } finally {
    cotSyncInFlight = false;
  }
}

/** Derive net positions, weekly changes and COT OHLC candles from legacy rows. */
function deriveSeries(rows: cftc.LegacyRow[]): CotSeriesRow[] {
  const out: CotSeriesRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = i > 0 ? rows[i - 1] : null;
    const commNet = r.commLong - r.commShort;
    const nonCommNet = r.nonCommLong - r.nonCommShort;
    const oiChange = prev ? r.oi - prev.oi : null;
    const commNetChange = prev ? commNet - (prev.commLong - prev.commShort) : null;
    const nonCommNetChange = prev ? nonCommNet - (prev.nonCommLong - prev.nonCommShort) : null;
    let candle: CotCandle | null = null;
    if (prev) {
      const open = prev.commLong - prev.commShort;
      const close = commNet;
      const pad = Math.abs(oiChange ?? 0) * 0.1;
      candle = {
        open,
        close,
        high: Math.max(open, close) + pad,
        low: Math.min(open, close) - pad,
      };
    }
    out.push({
      date: r.date,
      oi: r.oi,
      commLong: r.commLong,
      commShort: r.commShort,
      nonCommLong: r.nonCommLong,
      nonCommShort: r.nonCommShort,
      nonCommSpread: r.nonCommSpread,
      totRepLong: r.totRepLong,
      commNet,
      commNetChange,
      nonCommNet,
      nonCommNetChange,
      oiChange,
      candle,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Futures volume / OI sync                                            */
/* ------------------------------------------------------------------ */

export function marketIsStale(cache: MarketCache | null): boolean {
  if (!cache) return true;
  const age = hoursSince(cache.updatedAt);
  return age === null || age > 26;
}

let volumeSyncInFlight = false;

/**
 * Hourly futures volume/OI sync for every configured Yahoo ticker.
 * Open interest prefers the Yahoo quote; falls back to CFTC OI. Never throws.
 */
export async function syncVolumeOi(): Promise<void> {
  if (volumeSyncInFlight) return;
  volumeSyncInFlight = true;
  await withStatus((status) => { status.volumeOi.lastAttemptAt = isoNow(); });
  let anyOk = false;
  try {
    for (const inst of INSTRUMENTS) {
      try {
        const bars = await yahoo.fetchYahooChart(inst.yahooFuturesTicker, '3mo', '1d');
        const quote = await yahoo.fetchYahooQuote(inst.yahooFuturesTicker);

        const cotCache = await readJson<CotCache>(cotFile(inst.id));
        const cotOi = cotCache?.series?.length
          ? cotCache.series[cotCache.series.length - 1].oi
          : null;

        const last = bars?.length ? bars[bars.length - 1] : null;
        const prev = bars && bars.length > 1 ? bars[bars.length - 2] : null;

        const openInterest = quote?.openInterest ?? cotOi ?? null;
        const cache: MarketCache = {
          instrumentId: inst.id,
          updatedAt: isoNow(),
          provider: 'Yahoo Finance v8 chart API (+ v7 quote best-effort, CFTC OI fallback)',
          lastPrice: quote?.price ?? last?.close ?? null,
          dailyVolume: last?.volume ?? null,
          dailyVolumeDelta:
            last && prev && typeof prev.volume === 'number' && typeof last.volume === 'number'
              ? last.volume - prev.volume
              : null,
          openInterest,
          openInterestSource: quote?.openInterest != null ? 'yahoo-quote' : cotOi != null ? 'cftc-fallback' : null,
          series: (bars ?? []).slice(-60),
        };
        await writeJsonAtomic(volumeFile(inst.id), cache);
        anyOk = true;
      } catch (e) {
        console.warn(`[pipeline] Volume/OI sync failed for ${inst.id}:`, String((e as Error)?.message ?? e));
      }
      // Be polite to the upstream provider between tickers.
      await new Promise((r) => setTimeout(r, 250));
    }
    await withStatus((status) => {
      status.volumeOi.ok = anyOk;
      if (anyOk) status.volumeOi.lastSuccessAt = isoNow();
      status.volumeOi.error = anyOk ? null : 'All instrument fetches failed (upstream unreachable?).';
    });
    console.log(`[pipeline] Volume/OI sync ${anyOk ? 'OK' : 'FAILED'}`);
  } catch (e) {
    await withStatus((status) => {
      status.volumeOi.ok = false;
      status.volumeOi.error = String((e as Error)?.message ?? e);
    });
    console.error('[pipeline] Volume/OI sync failed:', String((e as Error)?.message ?? e));
  } finally {
    volumeSyncInFlight = false;
  }
}

/* ------------------------------------------------------------------ */
/* Bootstrap (on server boot)                                          */
/* ------------------------------------------------------------------ */

let bootstrapInFlight = false;

/**
 * On-boot bootstrap: immediately scrape CFTC COT and futures volume/OI
 * when the cache is empty or stale. Fire-and-forget from the scheduler;
 * failures are recorded in the sync status, never thrown.
 */
export async function runBootstrap(): Promise<void> {
  if (bootstrapInFlight) return;
  bootstrapInFlight = true;
  try {
    await ensureDirs();

    let cotCache: CotCache | null = null;
    let marketCache: MarketCache | null = null;
    const first = INSTRUMENTS[0];
    if (first) {
      cotCache = await readJson<CotCache>(cotFile(first.id));
      marketCache = await readJson<MarketCache>(volumeFile(first.id));
    }
    const doCot = cotIsStale(cotCache, await readStatus());
    const doVolume = marketIsStale(marketCache);

    if (doCot) await syncCOT();
    if (doVolume) await syncVolumeOi();

    await withStatus((status) => {
      status.bootstrap = {
        ranAt: isoNow(),
        cotSynced: doCot,
        volumeSynced: doVolume,
        cotOk: status.cftc.ok,
        volumeOk: status.volumeOi.ok,
      };
    });
    const after = await readStatus();
    console.log(
      `[pipeline] Bootstrap complete — COT ${after.cftc.ok ? 'ok' : 'pending'} · volume/OI ${after.volumeOi.ok ? 'ok' : 'pending'}`,
    );
  } catch (e) {
    console.error('[pipeline] Bootstrap failed:', String((e as Error)?.message ?? e));
  } finally {
    bootstrapInFlight = false;
  }
}

/* ------------------------------------------------------------------ */
/* API state assembly (no network)                                     */
/* ------------------------------------------------------------------ */

export interface InstrumentState {
  id: string;
  displayName: string;
  tvLiveSymbol: string;
  tvFuturesSymbol: string;
  yahooFuturesTicker: string;
  finvizCode: string;
  cot: CotCache | null;
  market: MarketCache | null;
  kpis: {
    commercialNet: number | null;
    commercialNetChange: number | null;
    commercialLabel: string;
    nonCommercialNet: number | null;
    nonCommercialNetChange: number | null;
    nonCommercialLabel: string;
    openInterest: number | null;
    openInterestChange: number | null;
    dailyVolume: number | null;
    dailyVolumeDelta: number | null;
    institutionalRatio: number | null;
  };
}

export interface TerminalState {
  generatedAt: string;
  serverTime: string;
  sync: SyncStatus;
  instruments: InstrumentState[];
}

export async function buildTerminalState(): Promise<TerminalState> {
  await ensureDirs();
  const sync = await readStatus();

  const instruments: InstrumentState[] = [];
  for (const inst of INSTRUMENTS) {
    const cot = await readJson<CotCache>(cotFile(inst.id));
    const market = await readJson<MarketCache>(volumeFile(inst.id));
    const last = cot?.series?.length ? cot.series[cot.series.length - 1] : null;
    const commercialLabel =
      inst.cftcReportSource === 'disaggregated'
        ? 'Commercials — Banks & Producers (CFTC Legacy)'
        : 'Commercial / Bank Net (CFTC Legacy)';
    const nonCommercialLabel =
      inst.cftcReportSource === 'disaggregated'
        ? 'Large Speculators (Managed Money + Other)'
        : 'Large Speculators (Asset Mgrs + Lev Funds)';
    const ratio =
      last && last.oi > 0 ? (last.commLong + last.nonCommLong + last.nonCommSpread) / last.oi : null;
    instruments.push({
      id: inst.id,
      displayName: inst.displayName,
      tvLiveSymbol: inst.tvLiveSymbol,
      tvFuturesSymbol: inst.tvFuturesSymbol,
      yahooFuturesTicker: inst.yahooFuturesTicker,
      finvizCode: inst.finvizCode,
      cot,
      market,
      kpis: {
        commercialNet: last?.commNet ?? null,
        commercialNetChange: last?.commNetChange ?? null,
        commercialLabel,
        nonCommercialNet: last?.nonCommNet ?? null,
        nonCommercialNetChange: last?.nonCommNetChange ?? null,
        nonCommercialLabel,
        openInterest: last?.oi ?? null,
        openInterestChange: last?.oiChange ?? null,
        dailyVolume: market?.dailyVolume ?? null,
        dailyVolumeDelta: market?.dailyVolumeDelta ?? null,
        institutionalRatio: ratio,
      },
    });
  }

  return { generatedAt: isoNow(), serverTime: new Date().toISOString(), sync, instruments };
}
