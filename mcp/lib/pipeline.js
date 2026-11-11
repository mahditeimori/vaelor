/**
 * Macro/COT pipeline for the Cloudflare Worker runtime.
 *
 * State lives in the Worker KV namespace bound as AI_STATE:
 *   macro:cot:<instrumentId>  -> CotCache
 *   macro:vol:<instrumentId>  -> MarketCache
 *   macro:status              -> SyncStatus
 *
 * Zero-touch behaviour:
 *   - scheduled()      : cron every 5 min -> Friday release window + daily + hourly checks
 *   - bootstrapIfStale : first HTTP request after a cold/empty cache seeds in the background
 *   - buildTerminalState: KV-only read, safe for 60s frontend polling
 */
import { INSTRUMENTS } from './instruments.js';
import * as cftc from './cftc.js';
import * as yahoo from './yahoo.js';

const PREFIX = 'macro:';
const K_COT = (id) => `${PREFIX}cot:${id}`;
const K_VOL = (id) => `${PREFIX}vol:${id}`;
const K_STATUS = `${PREFIX}status`;

export const CRON_JOBS = [
  {
    id: 'cftc_release_watcher',
    schedule: '*/5 * * * 5',
    timezone: 'UTC',
    description:
      'Polls CFTC.gov every 5 minutes during the Friday 15:30-16:30 America/New_York release window until the new weekly report is ingested.',
  },
  {
    id: 'cftc_daily_integrity_sync',
    schedule: '5 0 * * *',
    timezone: 'UTC',
    description: 'Daily verification of the CFTC Legacy, Disaggregated and TFF reports.',
  },
  {
    id: 'futures_volume_oi_sync',
    schedule: '0 * * * 1-5',
    timezone: 'UTC',
    description:
      'Hourly sync of futures daily volume and open interest for GC=F, SI=F, DX=F, NQ=F, ES=F, YM=F.',
  },
];

const DEFAULT_STATUS = {
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
    note: 'Worker-side proxy with browser headers; degrades gracefully when the upstream blocks the request.',
  },
  cron: {
    startedAt: null,
    timezone: 'UTC',
    jobs: CRON_JOBS,
  },
  bootstrap: {
    ranAt: null,
    cotSynced: false,
    volumeSynced: false,
    cotOk: false,
    volumeOk: false,
  },
};

/* ------------------------------------------------------------------ */
/* KV helpers                                                          */
/* ------------------------------------------------------------------ */

function kv(env) {
  if (!env?.AI_STATE) throw new Error('AI_STATE KV namespace is not bound');
  return env.AI_STATE;
}

async function kvGet(env, key) {
  return await kv(env).get(key, 'json');
}

async function kvPut(env, key, value) {
  await kv(env).put(key, JSON.stringify(value));
}

export function isoNow() {
  return new Date().toISOString();
}

export function hoursSince(iso) {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return (Date.now() - then) / 3_600_000;
}

export async function readStatus(env) {
  const s = await kvGet(env, K_STATUS);
  return s ?? structuredClone(DEFAULT_STATUS);
}

export async function writeStatus(env, status) {
  await kvPut(env, K_STATUS, status);
}

async function patchStatus(env, fn) {
  const status = await readStatus(env);
  await fn(status);
  await writeStatus(env, status);
  return status;
}

/* ------------------------------------------------------------------ */
/* CFTC sync                                                           */
/* ------------------------------------------------------------------ */

let cotSyncInFlight = false;

export function cotIsStale(cache) {
  if (!cache?.reportDate) return true;
  const age = hoursSince(cache.updatedAt);
  return age === null || age > 9 * 24;
}

export async function syncCOT(env) {
  if (cotSyncInFlight) return { ok: false, skipped: true };
  cotSyncInFlight = true;
  await patchStatus(env, (s) => {
    s.cftc.lastAttemptAt = isoNow();
  });

  const files = [];
  try {
    const codes = new Set(INSTRUMENTS.map((i) => i.cftcContractCode));
    const history = await cftc.fetchAnnualHistory(codes);
    files.push(...cftc.CFTC_SOURCE_URLS.history);

    const latest = await cftc.fetchLegacyLatest(codes);
    files.push('deafut.txt');

    let disagg = new Map();
    let tff = new Map();
    try {
      disagg = await cftc.fetchDisaggLatest(INSTRUMENTS);
      files.push('f_disagg.txt');
    } catch {
      /* optional enrichment */
    }
    try {
      tff = await cftc.fetchTffLatest(INSTRUMENTS);
      files.push('FinFutWk.txt');
    } catch {
      /* optional enrichment */
    }

    let newestReportDate = null;

    for (const inst of INSTRUMENTS) {
      const hist = history.get(inst.cftcContractCode) ?? [];
      const live = latest.get(inst.cftcContractCode);
      const series = [...hist];
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

      await kvPut(env, K_COT(inst.id), {
        instrumentId: inst.id,
        updatedAt: isoNow(),
        source: 'CFTC Legacy futures-only (annual history + weekly deafut.txt)',
        reportDate,
        series: derived.slice(-104),
        snapshot: disagg.get(inst.cftcContractCode) ?? tff.get(inst.cftcContractCode) ?? null,
      });
    }

    await patchStatus(env, (s) => {
      s.cftc.ok = true;
      s.cftc.lastSuccessAt = isoNow();
      s.cftc.latestReportDate = newestReportDate;
      s.cftc.sourceFiles = files;
      s.cftc.error = null;
    });
    return { ok: true, reportDate: newestReportDate, files };
  } catch (e) {
    const message = String(e?.message ?? e);
    await patchStatus(env, (s) => {
      s.cftc.ok = false;
      s.cftc.error = message;
    });
    return { ok: false, error: message };
  } finally {
    cotSyncInFlight = false;
  }
}

/** Derive net positions, weekly changes and COT OHLC candles from legacy rows. */
export function deriveSeries(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = i > 0 ? rows[i - 1] : null;
    const commNet = r.commLong - r.commShort;
    const nonCommNet = r.nonCommLong - r.nonCommShort;
    const oiChange = prev ? r.oi - prev.oi : null;
    const commNetChange = prev ? commNet - (prev.commLong - prev.commShort) : null;
    const nonCommNetChange = prev ? nonCommNet - (prev.nonCommLong - prev.nonCommShort) : null;
    let candle = null;
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

let volumeSyncInFlight = false;

export function marketIsStale(cache) {
  if (!cache) return true;
  const age = hoursSince(cache.updatedAt);
  return age === null || age > 26;
}

export async function syncVolumeOi(env) {
  if (volumeSyncInFlight) return { ok: false, skipped: true };
  volumeSyncInFlight = true;
  await patchStatus(env, (s) => {
    s.volumeOi.lastAttemptAt = isoNow();
  });

  let anyOk = false;
  try {
    // Fetch each unique ticker once; several instruments share NQ=F.
    const byTicker = new Map();
    for (const inst of INSTRUMENTS) {
      const list = byTicker.get(inst.yahooFuturesTicker) ?? [];
      list.push(inst);
      byTicker.set(inst.yahooFuturesTicker, list);
    }

    for (const [ticker, insts] of byTicker) {
      try {
        const bars = await yahoo.fetchYahooChart(ticker, '3mo', '1d');
        const quote = await yahoo.fetchYahooQuote(ticker);
        const last = bars?.length ? bars[bars.length - 1] : null;
        const prev = bars && bars.length > 1 ? bars[bars.length - 2] : null;

        for (const inst of insts) {
          const cotCache = await kvGet(env, K_COT(inst.id));
          const cotOi = cotCache?.series?.length ? cotCache.series[cotCache.series.length - 1].oi : null;
          await kvPut(env, K_VOL(inst.id), {
            instrumentId: inst.id,
            updatedAt: isoNow(),
            provider: 'Yahoo Finance v8 chart API (+ v7 quote best-effort, CFTC OI fallback)',
            lastPrice: quote?.price ?? last?.close ?? null,
            dailyVolume: last?.volume ?? null,
            dailyVolumeDelta:
              last && prev && typeof prev.volume === 'number' && typeof last.volume === 'number'
                ? last.volume - prev.volume
                : null,
            openInterest: quote?.openInterest ?? cotOi ?? null,
            openInterestSource:
              quote?.openInterest != null ? 'yahoo-quote' : cotOi != null ? 'cftc-fallback' : null,
            series: (bars ?? []).slice(-60),
          });
          anyOk = true;
        }
      } catch {
        /* one ticker failing must not abort the rest */
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    await patchStatus(env, (s) => {
      s.volumeOi.ok = anyOk;
      if (anyOk) s.volumeOi.lastSuccessAt = isoNow();
      s.volumeOi.error = anyOk ? null : 'All instrument fetches failed (upstream unreachable?).';
    });
    return { ok: anyOk };
  } catch (e) {
    const message = String(e?.message ?? e);
    await patchStatus(env, (s) => {
      s.volumeOi.ok = false;
      s.volumeOi.error = message;
    });
    return { ok: false, error: message };
  } finally {
    volumeSyncInFlight = false;
  }
}

/* ------------------------------------------------------------------ */
/* Bootstrap (first request after cold start)                          */
/* ------------------------------------------------------------------ */

let bootstrapInFlight = false;

export async function bootstrapIfStale(env, ctx) {
  if (bootstrapInFlight) return { scheduled: false, reason: 'in-flight' };
  bootstrapInFlight = true;
  try {
    const status = await readStatus(env);
    const cot = await kvGet(env, K_COT(INSTRUMENTS[0].id));
    const vol = await kvGet(env, K_VOL(INSTRUMENTS[0].id));

    const needCot = cotIsStale(cot) && (hoursSince(status.cftc.lastAttemptAt) ?? 99) > 0.25;
    const needVol = marketIsStale(vol) && (hoursSince(status.volumeOi.lastAttemptAt) ?? 99) > 0.25;

    if (needCot) ctx?.waitUntil?.(syncCOT(env).catch(() => {}));
    if (needVol) ctx?.waitUntil?.(syncVolumeOi(env).catch(() => {}));

    if (!status.cron.startedAt) {
      await patchStatus(env, (s) => {
        s.cron.startedAt = s.cron.startedAt ?? isoNow();
      });
    }
    return { scheduled: needCot || needVol, cot: needCot, volume: needVol };
  } catch {
    return { scheduled: false, reason: 'error' };
  } finally {
    bootstrapInFlight = false;
  }
}

/* ------------------------------------------------------------------ */
/* Scheduled cron handler                                              */
/* ------------------------------------------------------------------ */

function newYorkClock(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { weekday: get('weekday'), hour: Number(get('hour')), minute: Number(get('minute')) };
}

export async function runScheduled(env) {
  const now = new Date();
  const { weekday, hour, minute } = newYorkClock(now);
  const inReleaseWindow =
    weekday === 'Fri' && ((hour === 15 && minute >= 30) || (hour === 16 && minute <= 30));

  const status = await readStatus(env);
  const attemptAge = hoursSince(status.cftc.lastAttemptAt);
  const successAge = hoursSince(status.cftc.lastSuccessAt);
  const volumeAge = hoursSince(status.volumeOi.lastSuccessAt);

  const needDaily = status.cftc.lastSuccessAt == null || (successAge ?? 99) > 23;
  const canAttempt = attemptAge == null || attemptAge > 0.4 || inReleaseWindow;
  const needCot = (needDaily || inReleaseWindow) && canAttempt;
  const needVolume = volumeAge == null || volumeAge > 0.95;

  const results = { at: now.toISOString(), inReleaseWindow, needCot, needVolume };
  if (needCot) results.cot = await syncCOT(env);
  if (needVolume) results.volume = await syncVolumeOi(env);

  await patchStatus(env, (s) => {
    s.cron.startedAt = s.cron.startedAt ?? now.toISOString();
    s.cron.lastRunAt = now.toISOString();
    s.cron.lastReleaseWindow = inReleaseWindow;
  });
  return results;
}

/* ------------------------------------------------------------------ */
/* State assembly (KV only)                                            */
/* ------------------------------------------------------------------ */

export async function buildTerminalState(env) {
  const sync = await readStatus(env);

  const instruments = await Promise.all(
    INSTRUMENTS.map(async (inst) => {
      const [cot, market] = await Promise.all([
        kvGet(env, K_COT(inst.id)),
        kvGet(env, K_VOL(inst.id)),
      ]);
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

      return {
        id: inst.id,
        displayName: inst.displayName,
        tvLiveSymbol: inst.tvLiveSymbol,
        tvFuturesSymbol: inst.tvFuturesSymbol,
        yahooFuturesTicker: inst.yahooFuturesTicker,
        finvizCode: inst.finvizCode,
        cot: cot ?? null,
        market: market ?? null,
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
      };
    }),
  );

  return { generatedAt: isoNow(), serverTime: new Date().toISOString(), sync, instruments };
}

/* ------------------------------------------------------------------ */
/* Finviz proxy                                                        */
/* ------------------------------------------------------------------ */

const FINVIZ_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Finviz period codes for chart.ashx (d=daily, w=weekly, m=monthly). */
const FINVIZ_PERIOD_MAP = { d1: 'd', w1: 'w', m1: 'm' };

export async function finvizImage(code, period) {
  const p = FINVIZ_PERIOD_MAP[period] ?? 'w';
  const upstream = `https://finviz.com/chart.ashx?t=${code}&ty=c&ta=0&p=${p}`;
  const res = await fetch(upstream, {
    headers: {
      'user-agent': FINVIZ_UA,
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      referer: 'https://finviz.com/futures.ashx',
    },
    signal: AbortSignal.timeout(25_000),
  });
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!res.ok || !type.startsWith('image/')) {
    return { ok: false, status: 502, error: 'finviz_upstream_blocked' };
  }
  return { ok: true, type, body: await res.arrayBuffer() };
}
