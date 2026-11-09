// Deterministic mock data generator for the Trading LLC dashboard demo.
// Mirrors Section 4: price/volume, Open Interest (CME settlement cadence),
// COT weekly histogram (CFTC cadence), and the Composite Signal logic.

export type TfId = 'D' | 'W' | 'M' | 'Q';

export interface Ohlc {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface VolumBar {
  time: string;
  value: number;
}

export interface OiPoint {
  time: string;
  value: number;
}

export interface CotPoint {
  time: string;
  value: number;
  z: number;
  extreme: boolean;
}

export interface AlertMeta {
  type: string;
  detail: string;
}

export interface SeriesBundle {
  symbol: string;
  name: string;
  ohlc: Ohlc[];
  volume: VolumBar[];
  oi: OiPoint[];
  cot: CotPoint[];
  flipLevel: number;
  oiShockSessions: string[];
  alerts: AlertMeta[];
}

function mulberry(seed: number) {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gaussian = (rng: () => number) => {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function tradingDays(count: number): string[] {
  const days: string[] = [];
  const d = new Date(Date.UTC(2024, 0, 2));
  while (days.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

interface PriceConfig {
  base: number;
  amp: number;
  wave: number;      // period in sessions for the cyclical component
  phase: number;     // radians offset
  noise: number;     // daily noise amplitude
  shape: number;     // skew toward a mild drift over the window
}

function makeClose(rng: () => number, days: string[], cfg: PriceConfig): number[] {
  const closes: number[] = [];
  const n = days.length;
  let walk = 0;
  days.forEach((_, i) => {
    // cyclical institutional structure + mild secular drift + noise
    walk += gaussian(rng) * cfg.noise + cfg.shape;
    const cycl = cfg.amp * Math.sin((2 * Math.PI * i) / cfg.wave + cfg.phase);
    closes.push(cfg.base + cycl + walk);
  });
  return closes;
}

function makeOhlc(closes: number[], rng: () => number, days: string[]): Ohlc[] {
  return days.map((time, i) => {
    const close = closes[i];
    const open = i === 0 ? close : closes[i - 1];
    const rngRange = (Math.abs(gaussian(rng)) * 0.35 + 0.1) * (cfgNoiseFor(close));
    const high = Math.max(open, close) * (1 + rngRange);
    const low = Math.min(open, close) * (1 - rngRange);
    return { time, open, high: +high.toFixed(2), low: +low.toFixed(2), close: +close.toFixed(2) };
  });
}

// Range noise scaled relative to a reference price (so bars look natural on both GC and DX).
function cfgNoiseFor(price: number) {
  return price > 100 ? 0.008 : 0.004;
}

function makeVolume(rng: () => number, ohlc: Ohlc[], base: number): VolumBar[] {
  return ohlc.map((b) => ({
    time: b.time,
    value: Math.round(base * (0.5 + Math.abs(gaussian(rng)) * 0.5 + (b.close > b.open ? 0.08 : 0.15))),
  }));
}

// OI series with engineered extreme sessions (|ΔOI| >= threshold%) plus warm-up noise.
function makeOi(
  rng: () => number,
  ohlc: Ohlc[],
  base: number,
  thresholdPct: number,
  shockAt: { index: number; pct: number }[],
): { oi: OiPoint[]; shockSessions: string[] } {
  const oi: OiPoint[] = [];
  const shockSessions: string[] = [];
  const isShock = new Map<number, number>();
  for (const s of shockAt) isShock.set(s.index, s.pct);
  let level = base;
  ohlc.forEach((b, i) => {
    let pct = gaussian(rng) * 0.006;
    if (isShock.has(i)) pct = isShock.get(i)! / 100;
    level = level * (1 + pct);
    oi.push({ time: b.time, value: Math.round(level) });
    if (Math.abs(pct * 100) >= thresholdPct) shockSessions.push(b.time);
  });
  return { oi, shockSessions };
}

// COT weekly net commercial positioning with a rolling 3-year z-score (~2y window here).
// The tail segment is shaped so the end of the sample lands at a positioning extreme.
interface CotConfig {
  start: number;       // starting net position level
  vol: number;         // per-week noise amplitude
  tailFrom: number;    // index at which the final directional run begins
  tailStep: number;    // per-week increment during the tail run (negative = short extreme)
  weeksCount: number;  // number of weekly COT readings
}

function makeCot(rng: () => number, cfg: CotConfig): CotPoint[] {
  const weeks: string[] = [];
  const d = new Date(Date.UTC(2022, 0, 7));
  for (let i = 0; i < cfg.weeksCount; i++) {
    weeks.push(iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  const values: number[] = [];
  let level = cfg.start;
  for (let i = 0; i < weeks.length; i++) {
    if (i >= cfg.tailFrom) {
      level += cfg.tailStep + gaussian(rng) * cfg.vol * 0.4;
    } else {
      level += gaussian(rng) * cfg.vol;
    }
    values.push(level);
  }
  const windowN = Math.min(156, values.length);
  return values.map((v, i) => {
    const start = Math.max(0, i - windowN + 1);
    const n = i - start + 1;
    let mean = 0;
    for (let j = start; j <= i; j++) mean += values[j];
    mean /= n;
    let variance = 0;
    for (let j = start; j <= i; j++) variance += (values[j] - mean) ** 2;
    variance /= n;
    const sd = Math.sqrt(variance) || 1;
    const z = (v - mean) / sd;
    return { time: weeks[i], value: Math.round(v), z: +z.toFixed(2), extreme: Math.abs(z) >= 2.0 };
  });
}

function aggregateOhlc(ohlc: Ohlc[], step: number): Ohlc[] {
  const out: Ohlc[] = [];
  for (let i = 0; i < ohlc.length; i += step) {
    const slice = ohlc.slice(i, i + step);
    if (!slice.length) break;
    out.push({
      time: slice[0].time,
      open: slice[0].open,
      high: Math.max(...slice.map((b) => b.high)),
      low: Math.min(...slice.map((b) => b.low)),
      close: slice[slice.length - 1].close,
    });
  }
  return out;
}

function aggregateVolume(volume: VolumBar[], step: number): VolumBar[] {
  const out: VolumBar[] = [];
  for (let i = 0; i < volume.length; i += step) {
    const slice = volume.slice(i, i + step);
    if (!slice.length) break;
    out.push({ time: slice[0].time, value: slice.reduce((s, b) => s + b.value, 0) });
  }
  return out;
}

function aggregateOi(oi: OiPoint[], step: number): OiPoint[] {
  const out: OiPoint[] = [];
  for (let i = 0; i < oi.length; i += step) {
    const slice = oi.slice(i, i + step);
    if (!slice.length) break;
    out.push({ time: slice[0].time, value: slice[slice.length - 1].value });
  }
  return out;
}

export const TF_STEP: Record<TfId, number> = { D: 1, W: 5, M: 21, Q: 63 };

function buildSymbol(symbol: 'GC' | 'DX', seed: number): SeriesBundle {
  const days = tradingDays(260);
  const rng = mulberry(seed);

  const priceCfg: PriceConfig =
    symbol === 'GC'
      ? { base: 2480, amp: 190, wave: 96, phase: 0.6, noise: 3.2, shape: 1.1 }
      : { base: 104.0, amp: 2.4, wave: 72, phase: 2.1, noise: 0.045, shape: 0.012 };

  const closes = makeClose(rng, days, priceCfg);
  const ohlc = makeOhlc(closes, rng, days);

  const strokes =
    symbol === 'GC'
      ? [
          { index: 42, pct: -6.4 },
          { index: 88, pct: 5.7 },
          { index: 131, pct: -7.1 },
          { index: 176, pct: 6.2 },
          { index: 228, pct: -5.8 },
          { index: 254, pct: -6.9 },
        ]
      : [
          { index: 70, pct: 5.1 },
          { index: 128, pct: -5.9 },
          { index: 190, pct: 5.4 },
          { index: 246, pct: 5.2 },
        ];

  const volumeBase = symbol === 'GC' ? 145000 : 24000;
  const volume = makeVolume(rng, ohlc, volumeBase);
  const { oi, shockSessions } = makeOi(rng, ohlc, symbol === 'GC' ? 428000 : 38200, 5.0, strokes);

  // Tail run toward a positioning extreme at the last weekly reading.
  const cot = makeCot(
    rng,
    symbol === 'GC'
      ? { start: 2600, vol: 700, tailFrom: 142, tailStep: 520, weeksCount: 156 }
      : { start: 3200, vol: 420, tailFrom: 148, tailStep: -90, weeksCount: 156 },
  );

  // COT flip level anchored at the most recent substantial pivot low/high.
  const closesArr = ohlc.map((b) => b.close);
  const last = ohlc[ohlc.length - 1];
  let flipLevel: number;
  if (symbol === 'GC') {
    const lookback = closesArr.slice(216, 256);
    flipLevel = Math.min(...lookback);
  } else {
    const lookback = closesArr.slice(100, 170);
    flipLevel = Math.max(...lookback);
  }
  flipLevel = +flipLevel.toFixed(2);

  const lastOi = oi[oi.length - 1];
  const prevOi = oi[oi.length - 2];
  const oiDeltaPct = ((lastOi.value - prevOi.value) / prevOi.value) * 100;
  const lastCot = cot[cot.length - 1];

  const alerts: AlertMeta[] = [];
  if (Math.abs(oiDeltaPct) >= 5) {
    alerts.push({ type: 'OI Shock', detail: `${symbol} ΔOI ${oiDeltaPct >= 0 ? '+' : ''}${oiDeltaPct.toFixed(1)}%` });
  }
  if (Math.abs(lastCot.z) >= 2) {
    alerts.push({ type: 'COT Extreme', detail: `${symbol} Z=${lastCot.z.toFixed(2)} commercial` });
  }

  return {
    symbol,
    name: symbol === 'GC' ? 'Gold Futures (GC) · XAUUSD' : 'US Dollar Index (DX)',
    ohlc,
    volume,
    oi,
    cot,
    flipLevel,
    oiShockSessions: shockSessions,
    alerts,
  };
}

export const BUNDLES: Record<string, SeriesBundle> = {
  GC: buildSymbol('GC', 101),
  DX: buildSymbol('DX', 707),
};

export const LAST_SESSION_DATE: string = BUNDLES.GC.ohlc[BUNDLES.GC.ohlc.length - 1].time;
export const COT_DATA_DATE: string = BUNDLES.GC.cot[BUNDLES.GC.cot.length - 1].time;

// Client-side timeframe aggregation (Section 4.1: cache daily, aggregate locally).
export function aggregate(bundle: SeriesBundle, tf: TfId) {
  const step = TF_STEP[tf];
  return {
    ohlc: aggregateOhlc(bundle.ohlc, step),
    volume: aggregateVolume(bundle.volume, step),
    oi: aggregateOi(bundle.oi, step),
  };
}

// Four-state engine (Section 4.3).
export function fourState(priceDelta: number, oiDelta: number) {
  const pUp = priceDelta > 0;
  const oUp = oiDelta > 0;
  if (pUp && oUp) return { state: 'Price ↑ · OI ↑', label: 'New longs entering — trend confirmation and capital expansion', cls: 'state-up' };
  if (pUp && !oUp) return { state: 'Price ↑ · OI ↓', label: 'Short covering — technical rally driven by liquidation; lower conviction', cls: 'state-up' };
  if (!pUp && oUp) return { state: 'Price ↓ · OI ↑', label: 'New shorts entering — downtrend confirmation and aggressive selling', cls: 'state-down' };
  return { state: 'Price ↓ · OI ↓', label: 'Long liquidation — decline driven by position closing; weaker trend conviction', cls: 'state-down' };
}

// Composite flag (Section 4.6): Aligned = all 3, Watch = 2, None < 2.
export function compositeFlag(bundle: SeriesBundle) {
  const last = bundle.ohlc[bundle.ohlc.length - 1];
  const prev = bundle.ohlc[bundle.ohlc.length - 2];
  const lastOi = bundle.oi[bundle.oi.length - 1];
  const prevOi = bundle.oi[bundle.oi.length - 2];
  const z = bundle.cot[bundle.cot.length - 1].z;

  const factors = {
    cotExtreme: Math.abs(z) >= 2.0,
    oiContraction: lastOi.value < prevOi.value,
    flipTest: Math.abs(last.close - bundle.flipLevel) / bundle.flipLevel <= 0.015,
  };
  const met = Object.values(factors).filter(Boolean).length;
  const flag = met === 3 ? 'Aligned' : met === 2 ? 'Watch' : 'None';
  const fs = fourState(last.close - prev.close, lastOi.value - prevOi.value);
  const distBp = ((last.close - bundle.flipLevel) / bundle.flipLevel) * 10000;
  return {
    flag,
    factors,
    priceDelta: last.close - prev.close,
    oiDelta: lastOi.value - prevOi.value,
    fourState: fs,
    z,
    distBp,
  };
}

export const REGIMES = ['reflation', 'disinflation', 'stagflation', 'goldilocks', 'risk-off'] as const;
export const CURRENT_REGIME: string = 'risk-off';

export const COT_FRIDAY = 'Friday 15:30 ET';