/**
 * Composite dashboard — live macro data, barchart-style panels.
 *
 *   Panel 1  Price / volume   → /api/chart weekly OHLCV, candlestick or bar
 *   Panel 2  CFTC COT         → commercial (red) vs large-spec (green) step lines
 *   Panel 3  Open interest    → separate panel, COT overlay, or off
 *
 * Plus an "Analyze" engine that combines positioning, open interest, price
 * structure and momentum into a directional bias and an entry zone for every
 * instrument. Everything auto-refreshes; nothing is simulated.
 */
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  LineType,
  BarSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';

const API_BASE = 'https://trading-llc-mcp.mahdi-t8256.workers.dev';
const POLL_MS = 60_000;
const BARS_TTL_MS = 5 * 60_000;

const UP = '#26a69a';
const DOWN = '#ef5350';
const COMM = '#ef5350';
const SPEC = '#26a69a';
const OI = '#a855f7';

interface CotRow {
  date: string;
  oi: number;
  commNet: number;
  nonCommNet: number;
  commNetChange: number | null;
  nonCommNetChange: number | null;
}
interface MarketPoint {
  date: string;
  close: number | null;
  volume: number | null;
}
interface ChartBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
}
interface Instrument {
  id: string;
  displayName: string;
  tvLiveSymbol: string;
  cot: { reportDate: string | null; series: CotRow[] } | null;
  market: { series: MarketPoint[]; updatedAt?: string } | null;
  kpis: {
    openInterest: number | null;
    openInterestChange: number | null;
    dailyVolume: number | null;
    dailyVolumeChange?: number | null;
    dailyVolumeDelta: number | null;
    commercialNet: number | null;
    commercialNetChange: number | null;
    nonCommercialNet: number | null;
  };
}
interface TerminalState {
  generatedAt: string;
  sync: {
    cftc: { ok: boolean; latestReportDate: string | null; lastSuccessAt: string | null };
    volumeOi: { ok: boolean; lastSuccessAt: string | null };
  };
  instruments: Instrument[];
}

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type Tf = 'W' | 'M' | 'Q';
type PriceStyle = 'candles' | 'bars';
type OiMode = 'panel' | 'overlay' | 'off';

let state: TerminalState | null = null;
let activeId = 'gold';
let currentTf: Tf = 'W';
let priceStyle: PriceStyle = 'candles';
let showVolume = true;
let showComm = true;
let showSpecs = true;
let oiMode: OiMode = 'panel';

let priceChart: IChartApi | null = null;
let cotChart: IChartApi | null = null;
let oiChart: IChartApi | null = null;
let candleSeries: ISeriesApi<'Candlestick'> | null = null;
let barSeries: ISeriesApi<'Bar'> | null = null;
let volumeSeries: ISeriesApi<'Histogram'> | null = null;
let commSeries: ISeriesApi<'Line'> | null = null;
let specSeries: ISeriesApi<'Line'> | null = null;
let oiPanelSeries: ISeriesApi<'Line'> | null = null;
let oiOverlaySeries: ISeriesApi<'Line'> | null = null;

const barsCache = new Map<string, Bar[]>();
const barsAt = new Map<string, number>();
let polling = false;
let analyzing = false;

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const fmt = (n: number | null | undefined, dp = 0): string =>
  n == null || !Number.isFinite(n)
    ? '—'
    : n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtSigned = (n: number | null | undefined, dp = 0): string =>
  n == null || !Number.isFinite(n)
    ? '—'
    : (n > 0 ? '+' : '') + fmt(n, dp);
const fmtPct = (n: number | null | undefined, dp = 2): string =>
  n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${(n * 100).toFixed(dp)}%`;
const fmtTime = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toUTCString().replace('GMT', 'UTC') : '—';
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = avg(xs);
  return Math.sqrt(avg(xs.map((x) => (x - m) ** 2)));
};
const clamp = (x: number, lo = -1, hi = 1): number => Math.min(hi, Math.max(lo, x));
const zscore = (xs: number[], latest: number, lookback = 156): number => {
  const arr = xs.slice(-lookback);
  const sd = stdev(arr);
  return sd ? (latest - avg(arr)) / sd : 0;
};
const isoDay = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toISOString().slice(0, 10);

const current = (): Instrument | null =>
  state?.instruments.find((i) => i.id === activeId) ?? state?.instruments[0] ?? null;

/* ------------------------------------------------------------------ */
/* Charts                                                              */
/* ------------------------------------------------------------------ */

function chartTheme(height: number, width: number) {
  return {
    width,
    height,
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: '#9aa7bd',
      fontSize: 11,
      fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: 'rgba(35,43,58,0.38)' },
      horzLines: { color: 'rgba(35,43,58,0.38)' },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: 'rgba(148,163,184,0.35)', labelBackgroundColor: '#1f2937' },
      horzLine: { color: 'rgba(148,163,184,0.35)', labelBackgroundColor: '#1f2937' },
    },
    timeScale: { borderColor: '#232b3a', rightOffset: 4, timeVisible: false },
    rightPriceScale: { borderColor: '#232b3a' },
  };
}

function sizeChart(chart: IChartApi, w: number, h: number): void {
  const width = Math.max(1, Math.floor(w));
  const height = Math.max(1, Math.floor(h));
  try {
    (chart as unknown as { resize?: (w: number, h: number, f?: boolean) => void }).resize?.(width, height, true);
  } catch {
    try { chart.applyOptions({ width, height }); } catch { /* ignore */ }
  }
}

function mountChart(container: HTMLElement, height: number): IChartApi {
  const width = container.clientWidth || 900;
  const chart = createChart(container, chartTheme(height, width));
  sizeChart(chart, width, height);
  const ro = new ResizeObserver(() => {
    if (container.clientWidth > 0) sizeChart(chart, container.clientWidth, height);
  });
  ro.observe(container);
  return chart;
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

function bucketKey(date: string, tf: Tf): string {
  if (tf === 'W') return date;
  if (tf === 'M') return date.slice(0, 7);
  const [y, m] = date.split('-').map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** Weekly OHLCV → W / M / Q buckets (open=first, high=max, low=min, close=last). */
function aggregateBars(bars: Bar[], tf: Tf): Bar[] {
  if (tf === 'W' || !bars.length) return bars;
  const out = new Map<string, Bar>();
  for (const b of bars) {
    const key = bucketKey(b.date, tf);
    const prev = out.get(key);
    if (!prev) out.set(key, { ...b });
    else
      out.set(key, {
        date: b.date,
        open: prev.open,
        high: Math.max(prev.high, b.high),
        low: Math.min(prev.low, b.low),
        close: b.close,
        volume: prev.volume + b.volume,
      });
  }
  return [...out.values()];
}

function aggregateCot(series: CotRow[], tf: Tf): CotRow[] {
  if (tf === 'W') return series;
  const out = new Map<string, CotRow>();
  for (const row of series) out.set(bucketKey(row.date, tf), row);
  return [...out.values()];
}

const activeBars = (): Bar[] => aggregateBars(barsCache.get(activeId) ?? [], currentTf);

/* ------------------------------------------------------------------ */
/* Panel rendering                                                     */
/* ------------------------------------------------------------------ */

function renderPrice(inst: Instrument): void {
  if (!priceChart || !candleSeries || !barSeries || !volumeSeries) return;
  const bars = activeBars();
  if (!bars.length) return;

  const ohlc = bars.map((b) => ({
    time: b.date as Time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
  }));
  candleSeries.setData(ohlc);
  barSeries.setData(ohlc);
  volumeSeries.setData(
    bars.map((b) => ({
      time: b.date as Time,
      value: b.volume,
      color: b.close >= b.open ? 'rgba(38,166,154,0.35)' : 'rgba(239,83,80,0.35)',
    })),
  );
  candleSeries.applyOptions({ visible: priceStyle === 'candles' });
  barSeries.applyOptions({ visible: priceStyle === 'bars' });
  volumeSeries.applyOptions({ visible: showVolume });
  priceChart.timeScale().fitContent();

  const stat = el('priceStat');
  if (stat) {
    const last = bars.at(-1)!;
    const prev = bars.at(-2);
    const chg = prev && prev.close ? (last.close - prev.close) / prev.close : 0;
    stat.innerHTML = `Last <b>${fmt(last.close, 2)}</b> · ${fmtPct(chg)} · Vol <b>${fmt(last.volume)}</b>`;
  }
  const note = el('resolveNote');
  if (note) note.textContent = inst.tvLiveSymbol;
}

function renderCot(inst: Instrument): void {
  if (!cotChart || !commSeries || !specSeries) return;
  const rows = aggregateCot(inst.cot?.series ?? [], currentTf);
  if (!rows.length) return;

  commSeries.setData(rows.map((r) => ({ time: r.date as Time, value: r.commNet })));
  specSeries.setData(rows.map((r) => ({ time: r.date as Time, value: r.nonCommNet })));
  commSeries.applyOptions({ visible: showComm });
  specSeries.applyOptions({ visible: showSpecs });
  cotChart.timeScale().fitContent();

  const k = inst.kpis;
  const stat = el('cotStat');
  if (stat) {
    const parts: string[] = [];
    if (showComm) parts.push(`Commercials <b class="c-red">${fmt(k.commercialNet)}</b> (${fmtSigned(k.commercialNetChange)})`);
    if (showSpecs) parts.push(`Specs <b class="c-green">${fmt(k.nonCommercialNet)}</b>`);
    stat.innerHTML = parts.join(' · ') || 'Both series hidden';
  }

  const oiLegend = el('cotOiLegend');
  if (oiLegend) oiLegend.hidden = oiMode !== 'overlay';
}

function renderOi(inst: Instrument): void {
  const panel = el('oiPanel');
  const rows = aggregateCot(inst.cot?.series ?? [], currentTf);
  const data = rows.map((r) => ({ time: r.date as Time, value: r.oi }));

  if (oiMode === 'panel') {
    if (panel) panel.hidden = false;
    if (!oiPanelSeries && oiChart) {
      oiPanelSeries = oiChart.addSeries(LineSeries, {
        color: OI,
        lineWidth: 2,
        priceFormat: { type: 'volume' },
        priceLineVisible: false,
      });
    }
    if (oiPanelSeries) oiPanelSeries.setData(data);
    oiChart?.timeScale().fitContent();
  } else if (oiMode === 'overlay') {
    if (panel) panel.hidden = true;
    if (!oiOverlaySeries && cotChart) {
      oiOverlaySeries = cotChart.addSeries(LineSeries, {
        color: OI,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: true,
      });
    }
    if (oiOverlaySeries) oiOverlaySeries.setData(data);
  } else if (panel) {
    panel.hidden = true;
  }

  const k = inst.kpis;
  const stat = el('oiStat');
  if (stat) {
    const pct =
      k.openInterest && k.openInterestChange
        ? fmtPct(k.openInterestChange / (k.openInterest - k.openInterestChange))
        : '—';
    stat.innerHTML = `Latest <b class="c-purple">${fmt(k.openInterest)}</b> · Δ w/w <b>${fmtSigned(k.openInterestChange)}</b> (${pct})`;
  }

  const oiLegend = el('cotOiLegend');
  if (oiLegend) oiLegend.hidden = oiMode !== 'overlay';
}

function destroyOiSeries(): void {
  if (oiPanelSeries && oiChart) {
    try { oiChart.removeSeries(oiPanelSeries); } catch { /* ignore */ }
  }
  if (oiOverlaySeries && cotChart) {
    try { cotChart.removeSeries(oiOverlaySeries); } catch { /* ignore */ }
  }
  oiPanelSeries = null;
  oiOverlaySeries = null;
}

/* ------------------------------------------------------------------ */
/* Composite metrics                                                   */
/* ------------------------------------------------------------------ */

interface StateRead {
  label: string;
  detail: string;
  score: number;
  tone: string;
}

function readState(dPrice: number, dOi: number, hasHistory: boolean): StateRead {
  if (!hasHistory) return { label: '—', detail: 'Awaiting open-interest history', score: 0, tone: '' };
  if (dPrice >= 0 && dOi >= 0)
    return { label: 'Long buildup', detail: `Price ${fmtPct(dPrice)} · OI ${fmtPct(dOi)}`, score: 1, tone: 'state-up' };
  if (dPrice < 0 && dOi >= 0)
    return { label: 'Short buildup', detail: `Price ${fmtPct(dPrice)} · OI ${fmtPct(dOi)}`, score: -1, tone: 'state-down' };
  if (dPrice >= 0 && dOi < 0)
    return { label: 'Short covering', detail: `Price ${fmtPct(dPrice)} · OI ${fmtPct(dOi)}`, score: 0.5, tone: 'state-up' };
  return { label: 'Long liquidation', detail: `Price ${fmtPct(dPrice)} · OI ${fmtPct(dOi)}`, score: -0.5, tone: 'state-down' };
}

function priceAt(id: string, date: string): number | null {
  const bars = barsCache.get(id) ?? [];
  let best: number | null = null;
  for (const b of bars) if (b.date <= date) best = b.close;
  return best;
}

function updateComposite(inst: Instrument): void {
  const rows = inst.cot?.series ?? [];
  const bars = activeBars();
  const lastRow = rows.at(-1);
  const prevRow = rows.at(-2);
  const lastPrice = bars.at(-1)?.close ?? null;
  const prevPrice = bars.at(-2)?.close ?? lastPrice;

  const comm = rows.map((r) => r.commNet);
  const z = comm.length ? zscore(comm, comm.at(-1)!) : 0;
  const dOi = lastRow && prevRow && prevRow.oi ? (lastRow.oi - prevRow.oi) / prevRow.oi : 0;
  const dPrice = lastPrice && prevPrice ? (lastPrice - prevPrice) / prevPrice : 0;
  const read = readState(dPrice, dOi, !!lastRow && !!prevRow);

  let flipPrice: number | null = null;
  for (let i = rows.length - 1; i > 0; i--) {
    if (Math.sign(rows[i].commNet) !== Math.sign(rows[i - 1].commNet)) {
      flipPrice = priceAt(inst.id, rows[i].date);
      break;
    }
  }
  const distBp = flipPrice && lastPrice ? ((flipPrice - lastPrice) / lastPrice) * 10_000 : null;

  const closes = bars.map((b) => b.close);
  const ma = closes.length ? avg(closes.slice(-50)) : 0;
  const regime = lastPrice && ma ? (lastPrice >= ma ? 'Risk-on' : 'Risk-off') : 'Neutral';

  let aligned = 0;
  if (Math.abs(z) >= 2) aligned++;
  if (read.score >= 1) aligned++;
  if ((lastRow?.commNetChange ?? 0) > 0) aligned++;
  const flag = aligned >= 3 ? 'Aligned' : aligned === 2 ? 'Watch' : 'None';

  const set = (id: string, text: string, cls?: string) => {
    const node = el(id);
    if (!node) return;
    node.textContent = text;
    if (cls !== undefined) node.className = cls;
  };
  set('stateLabel', read.label, `v ${read.tone}`);
  set('stateDetail', read.detail);
  set('zScore', `${z >= 0 ? '+' : ''}${z.toFixed(2)}`, 'v mono');
  set('flipDist', distBp == null ? 'No flip in window' : `${fmtSigned(distBp)} bp`, 'v');
  set('compFlag', flag, `v flag-${flag.toLowerCase()}`);
  set('regimeValue', regime, 'v');

  const chip = el('regimeChip');
  if (chip) chip.textContent = `REGIME: ${regime.toUpperCase()}`;
}

function renderAges(inst: Instrument): void {
  const priceAge = el('priceAge');
  if (priceAge) priceAge.innerHTML = `Updated: <b>${fmtTime(inst.market?.updatedAt)}</b>`;
  const oiAge = el('oiAge');
  if (oiAge) oiAge.innerHTML = `Report: <b>${inst.cot?.reportDate ?? '—'}</b>`;
  const cotAge = el('cotAge');
  if (cotAge) cotAge.innerHTML = `Report: <b>${inst.cot?.reportDate ?? '—'}</b>`;

  const note = el('resolveNote');
  if (note) note.textContent = inst.tvLiveSymbol;
}

function renderAll(): void {
  const inst = current();
  if (!inst) return;
  renderPrice(inst);
  renderCot(inst);
  renderOi(inst);
  updateComposite(inst);
  renderAges(inst);
}

/* ------------------------------------------------------------------ */
/* Analysis engine                                                     */
/* ------------------------------------------------------------------ */

interface Factor {
  label: string;
  detail: string;
  score: number;
  weight: number;
}
interface Analysis {
  id: string;
  name: string;
  symbol: string;
  price: number | null;
  bias: 'Bullish' | 'Bearish' | 'Neutral';
  conviction: 'High' | 'Moderate' | 'Low';
  score: number;
  zone: [number, number] | null;
  stop: number | null;
  target: number | null;
  factors: Factor[];
  rationale: string[];
  weeks: number;
}

function atr(bars: Bar[], period = 14): number {
  if (bars.length < 2) return 0;
  const slice = bars.slice(-period - 1);
  const trs: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1].close;
    trs.push(Math.max(slice[i].high - slice[i].low, Math.abs(slice[i].high - prev), Math.abs(slice[i].low - prev)));
  }
  return trs.length ? avg(trs) : slice.at(-1)!.high - slice.at(-1)!.low;
}

function horizonLabel(weeks: number): string {
  if (weeks <= 1) return 'next week';
  if (weeks <= 4) return 'next month';
  if (weeks <= 13) return 'next quarter';
  return `next ${weeks} weeks`;
}

function computeAnalysis(inst: Instrument, bars: Bar[], weeks: number): Analysis | null {
  if (!bars.length) return null;
  const rows = inst.cot?.series ?? [];
  const closes = bars.map((b) => b.close);
  const last = bars.at(-1)!;
  const close = last.close;
  const a = atr(bars);

  const comm = rows.map((r) => r.commNet);
  const commZ = comm.length ? zscore(comm, comm.at(-1)!) : 0;
  const spec = rows.map((r) => r.nonCommNet);
  const specZ = spec.length ? zscore(spec, spec.at(-1)!) : 0;

  const lastRow = rows.at(-1);
  const prevRow = rows.at(-2);
  const dOi = lastRow && prevRow && prevRow.oi ? (lastRow.oi - prevRow.oi) / prevRow.oi : 0;
  const prev = bars.at(-2);
  const dPrice = prev && prev.close ? (close - prev.close) / prev.close : 0;
  const read = readState(dPrice, dOi, !!lastRow && !!prevRow);

  const ma20 = avg(closes.slice(-20));
  const ma50 = avg(closes.slice(-50));
  const ma20prev = closes.length > 24 ? avg(closes.slice(-24, -4)) : ma20;
  let trendScore = 0;
  trendScore += close >= ma20 ? 0.4 : -0.4;
  trendScore += ma20 >= ma50 ? 0.3 : -0.3;
  trendScore += ma20 >= ma20prev ? 0.3 : -0.3;

  const look = Math.min(4, closes.length - 1);
  const ret4 = look > 0 ? (close - closes[closes.length - 1 - look]) / closes[closes.length - 1 - look] : 0;
  const momScore = clamp(ret4 / 0.06);

  const factors: Factor[] = [
    {
      label: 'Commercial positioning',
      detail: `Z ${fmtSigned(commZ, 2)} vs 3-year norm`,
      score: clamp(commZ / 2),
      weight: 0.3,
    },
    {
      label: 'Large-speculator positioning',
      detail: `Z ${fmtSigned(specZ, 2)} · net ${fmt(inst.kpis.nonCommercialNet)}`,
      score: clamp(specZ / 2),
      weight: 0.2,
    },
    {
      label: 'Price / open-interest state',
      detail: `${read.label} · ${read.detail}`,
      score: read.score,
      weight: 0.2,
    },
    {
      label: 'Trend structure',
      detail: `${close >= ma20 ? 'Above' : 'Below'} 20W MA (${fmt(ma20, 2)}) · ${ma20 >= ma50 ? 'bullish' : 'bearish'} MA stack`,
      score: clamp(trendScore),
      weight: 0.2,
    },
    {
      label: 'Momentum (4W)',
      detail: `${fmtPct(ret4)} over four weeks`,
      score: momScore,
      weight: 0.1,
    },
  ];

  const score = factors.reduce((s, f) => s + f.score * f.weight, 0);
  const bias: Analysis['bias'] = score >= 0.2 ? 'Bullish' : score <= -0.2 ? 'Bearish' : 'Neutral';
  const conviction: Analysis['conviction'] = Math.abs(score) >= 0.55 ? 'High' : Math.abs(score) >= 0.35 ? 'Moderate' : 'Low';

  const recent = bars.slice(-8);
  const swingLow = Math.min(...recent.map((b) => b.low));
  const swingHigh = Math.max(...recent.map((b) => b.high));
  const pull = a * 0.8;
  let zone: [number, number] | null = null;
  let stop: number | null = null;
  let target: number | null = null;

  if (bias === 'Bullish') {
    const lo = Math.max(swingLow, close - pull * 1.3);
    const hi = Math.min(close - pull * 0.2, close);
    zone = [Math.min(lo, hi), Math.max(lo, hi)];
    stop = Math.min(swingLow, zone[0]) - a * 0.4;
    target = close + a * Math.sqrt(Math.max(weeks, 1)) * 1.2;
  } else if (bias === 'Bearish') {
    const hi = Math.min(swingHigh, close + pull * 1.3);
    const lo = Math.max(close + pull * 0.2, close);
    zone = [Math.min(lo, hi), Math.max(lo, hi)];
    stop = Math.max(swingHigh, zone[1]) + a * 0.4;
    target = close - a * Math.sqrt(Math.max(weeks, 1)) * 1.2;
  } else {
    zone = [close - a * 0.5, close + a * 0.5];
  }

  const horizon = horizonLabel(weeks);
  const rationale: string[] = [];
  rationale.push(
    commZ >= 0
      ? `Commercials are more net-long than their three-year norm (Z ${fmtSigned(commZ, 2)}), a supportive positioning signal.`
      : `Commercials are more net-short than usual (Z ${fmtSigned(commZ, 2)}), which caps upside.`,
  );
  rationale.push(
    specZ >= 0
      ? `Large speculators hold a net-long skew (Z ${fmtSigned(specZ, 2)}), confirming trend participation.`
      : `Large speculators are positioned short (Z ${fmtSigned(specZ, 2)}), keeping pressure on rallies.`,
  );
  rationale.push(`Price moved ${fmtPct(dPrice)} last week with open interest ${fmtPct(dOi)} — ${read.label.toLowerCase()}.`);
  rationale.push(
    `Price is ${close >= ma20 ? 'above' : 'below'} its 20-week average and ${ma20 >= ma50 ? 'above' : 'below'} the 50-week average.`,
  );
  if (bias !== 'Neutral' && zone) {
    rationale.push(
      `For the ${horizon}, the ${bias.toLowerCase()} entry zone is ${fmt(zone[0], 2)}–${fmt(zone[1], 2)}; ` +
        `invalidation ${fmt(stop, 2)} and first target ${fmt(target, 2)}.`,
    );
  } else if (zone) {
    rationale.push(
      `Signals conflict, so the ${horizon} stance is neutral: wait for a break above ${fmt(zone[1], 2)} or below ` +
        `${fmt(zone[0], 2)} before committing risk.`,
    );
  }

  return {
    id: inst.id,
    name: inst.displayName,
    symbol: inst.tvLiveSymbol,
    price: close,
    bias,
    conviction,
    score,
    zone,
    stop,
    target,
    factors,
    rationale,
    weeks,
  };
}

function biasClass(bias: Analysis['bias']): string {
  return bias === 'Bullish' ? 'bias-bull' : bias === 'Bearish' ? 'bias-bear' : 'bias-neutral';
}

function renderAnalysis(results: Analysis[], selectedId: string, weeks: number): void {
  const host = el('analysisResults');
  if (!host) return;
  host.hidden = false;
  if (!results.length) {
    host.innerHTML = '<div class="an-empty">No price history available yet — try again in a moment.</div>';
    return;
  }
  const a = results.find((r) => r.id === selectedId) ?? results[0];
  const gauge = Math.round(((a.score + 1) / 2) * 100);
  const convClass = a.conviction === 'High' ? 'conv-high' : a.conviction === 'Moderate' ? 'conv-mid' : 'conv-low';

  const factorRows = a.factors
    .map(
      (f) => `<div class="an-factor">
        <div class="an-f-main">
          <span class="an-f-label">${esc(f.label)}</span>
          <span class="an-f-detail">${esc(f.detail)}</span>
        </div>
        <span class="an-f-score ${f.score > 0.05 ? 'pos' : f.score < -0.05 ? 'neg' : 'flat'}">${fmtSigned(f.score, 2)}</span>
        <span class="an-f-weight">w ${Math.round(f.weight * 100)}%</span>
      </div>`,
    )
    .join('');

  const tableRows = results
    .map(
      (r) => `<tr data-id="${esc(r.id)}" class="${r.id === a.id ? 'an-row-active' : ''}">
        <td>${esc(r.name)}</td>
        <td class="${biasClass(r.bias)}">${r.bias}</td>
        <td>${r.conviction}</td>
        <td>${r.zone ? `${fmt(r.zone[0], 2)} – ${fmt(r.zone[1], 2)}` : '—'}</td>
        <td>${r.stop == null ? '—' : fmt(r.stop, 2)}</td>
        <td>${r.target == null ? '—' : fmt(r.target, 2)}</td>
      </tr>`,
    )
    .join('');

  host.innerHTML = `
    <div class="an-hero">
      <div class="an-hero-left">
        <div class="an-asset">${esc(a.name)} <span>${esc(a.symbol)}</span></div>
        <div class="an-bias ${biasClass(a.bias)}">${a.bias.toUpperCase()}</div>
        <div class="an-meta">
          <span class="an-conv ${convClass}">${a.conviction} conviction</span>
          <span>Horizon: ${horizonLabel(weeks)}</span>
          <span>Score: <b>${fmtSigned(a.score, 2)}</b> / 1.00</span>
          <span>Spot: <b>${fmt(a.price, 2)}</b></span>
        </div>
      </div>
      <div class="an-gauge" aria-hidden="true">
        <span class="an-gauge-axis"></span>
        <span class="an-gauge-mid"></span>
        <span class="an-gauge-dot" style="left:${gauge}%"></span>
        <span class="an-gauge-labels"><i>Bearish</i><i>Neutral</i><i>Bullish</i></span>
      </div>
    </div>

    <div class="an-grid">
      <div class="an-cell">
        <span class="k">${a.bias === 'Neutral' ? 'Decision zone' : a.bias === 'Bullish' ? 'Long entry zone' : 'Short entry zone'}</span>
        <span class="v">${a.zone ? `${fmt(a.zone[0], 2)} – ${fmt(a.zone[1], 2)}` : '—'}</span>
        <span class="s">${a.bias === 'Neutral' ? 'Wait for a breakout of this range' : 'Scale in inside this band'}</span>
      </div>
      <div class="an-cell">
        <span class="k">Invalidation</span>
        <span class="v neg">${a.stop == null ? '—' : fmt(a.stop, 2)}</span>
        <span class="s">${a.bias === 'Neutral' ? 'Breakout failure' : 'Exit if this level trades'}</span>
      </div>
      <div class="an-cell">
        <span class="k">First target</span>
        <span class="v pos">${a.target == null ? '—' : fmt(a.target, 2)}</span>
        <span class="s">${horizonLabel(weeks)} projection · 1.2× ATR√t</span>
      </div>
    </div>

    <div class="an-cols">
      <div class="an-panel">
        <div class="an-panel-title">Signal breakdown</div>
        <div class="an-factors">${factorRows}</div>
      </div>
      <div class="an-panel">
        <div class="an-panel-title">Why this bias</div>
        <ul class="an-rationale">${a.rationale.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      </div>
    </div>

    <div class="an-panel">
      <div class="an-panel-title">All instruments · ${horizonLabel(weeks)}</div>
      <div class="an-table-wrap">
        <table class="an-table">
          <thead><tr><th>Asset</th><th>Bias</th><th>Conviction</th><th>Entry zone</th><th>Invalidation</th><th>Target</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>

    <div class="an-disclaimer">
      Computed from the live CFTC/CME feed and weekly price structure. A bias is a probability lean,
      not an executable order — position sizing and risk limits remain with the desk.
    </div>
  `;

  host.querySelectorAll<HTMLTableRowElement>('tr[data-id]').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      if (!id || !state) return;
      activeId = id;
      const select = el<HTMLSelectElement>('symbolSelect');
      if (select) select.value = id;
      renderAll();
      renderAnalysis(results, activeId, weeks);
    });
  });
}

async function runAnalysis(): Promise<void> {
  if (analyzing || !state) return;
  analyzing = true;
  const btn = el<HTMLButtonElement>('analyzeBtn');
  const host = el('analysisResults');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Analyzing…';
  }
  if (host) {
    host.hidden = false;
    host.innerHTML = '<div class="an-empty">Pulling price and positioning for all instruments…</div>';
  }
  const weeks = Number(el<HTMLSelectElement>('analysisHorizon')?.value ?? 4) || 4;
  try {
    await Promise.all(
      (state.instruments ?? []).map(async (inst) => {
        if (!barsCache.has(inst.id)) {
          try {
            const bars = await fetchBars(inst);
            barsCache.set(inst.id, bars);
            barsAt.set(inst.id, Date.now());
          } catch { /* skip asset */ }
        }
      }),
    );
    const results = (state.instruments ?? [])
      .map((inst) => {
        const bars = barsCache.get(inst.id);
        return bars && bars.length ? computeAnalysis(inst, bars, weeks) : null;
      })
      .filter((r): r is Analysis => !!r)
      .sort((x, y) => Math.abs(y.score) - Math.abs(x.score));
    renderAnalysis(results, activeId, weeks);
  } finally {
    analyzing = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Analyze';
    }
  }
}

/* ------------------------------------------------------------------ */
/* Data                                                               */
/* ------------------------------------------------------------------ */

async function fetchBars(inst: Instrument): Promise<Bar[]> {
  const res = await fetch(
    `${API_BASE}/api/chart?id=${encodeURIComponent(inst.id)}&range=2y&interval=1wk&t=${Date.now()}`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { bars?: ChartBar[] };
  return (data.bars ?? [])
    .map((b) => ({
      date: isoDay(b.time),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume ?? 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function refreshActiveBars(inst: Instrument): Promise<void> {
  const stamp = barsAt.get(inst.id) ?? 0;
  const fresh = barsCache.has(inst.id) && Date.now() - stamp < BARS_TTL_MS;
  if (fresh) return;
  try {
    barsCache.set(inst.id, await fetchBars(inst));
    barsAt.set(inst.id, Date.now());
  } catch {
    if (!barsCache.has(inst.id)) barsCache.set(inst.id, []);
  }
}

/* ------------------------------------------------------------------ */
/* State / UI wiring                                                  */
/* ------------------------------------------------------------------ */

function renderSymbolSelect(): void {
  const select = el<HTMLSelectElement>('symbolSelect');
  if (!select || !state) return;
  select.innerHTML = state.instruments
    .map((i) => `<option value="${i.id}">${esc(i.displayName)}</option>`)
    .join('');
  select.value = activeId;
  if (!select.dataset.bound) {
    select.dataset.bound = '1';
    select.addEventListener('change', () => {
      activeId = select.value;
      const inst = current();
      if (!inst) return;
      void refreshActiveBars(inst).then(renderAll);
    });
  }
}

function renderStatus(): void {
  if (!state) return;
  const status = el('dashStatus');
  if (!status) return;
  const report = state.sync.cftc.latestReportDate;
  status.textContent = report
    ? `Live · CFTC report ${report} · synced ${fmtTime(state.sync.volumeOi.lastSuccessAt)} · auto-refresh 60 s`
    : 'Live · first CFTC bootstrap in progress · auto-refresh 60 s';
}

function wireControls(): void {
  const toggle = el('tfToggle');
  toggle?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-tf]');
    if (!btn) return;
    toggle.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentTf = (btn as HTMLButtonElement).dataset.tf as Tf;
    renderAll();
  });

  const styleGroup = el('priceStyleBtns');
  styleGroup?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-style]');
    if (!btn) return;
    styleGroup.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    priceStyle = (btn as HTMLButtonElement).dataset.style as PriceStyle;
    renderAll();
  });

  const vol = el<HTMLInputElement>('volToggle');
  vol?.addEventListener('change', () => {
    showVolume = vol.checked;
    renderAll();
  });

  const comm = el<HTMLInputElement>('commToggle');
  comm?.addEventListener('change', () => {
    showComm = comm.checked;
    renderAll();
  });

  const specs = el<HTMLInputElement>('specsToggle');
  specs?.addEventListener('change', () => {
    showSpecs = specs.checked;
    renderAll();
  });

  const oiSel = el<HTMLSelectElement>('oiMode');
  oiSel?.addEventListener('change', () => {
    oiMode = (oiSel.value as OiMode) ?? 'panel';
    destroyOiSeries();
    renderAll();
  });

  el('analyzeBtn')?.addEventListener('click', () => void runAnalysis());
}

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const res = await fetch(`${API_BASE}/api/terminal/state?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state = (await res.json()) as TerminalState;
    renderSymbolSelect();
    renderStatus();
    const inst = current();
    if (inst) {
      await refreshActiveBars(inst);
      renderAll();
    }
  } catch {
    const status = el('dashStatus');
    if (status) status.textContent = 'Macro engine unreachable — automatic retry in 60 s…';
  } finally {
    polling = false;
  }
}

function init(): void {
  const priceEl = el('priceChart');
  const cotEl = el('cotChart');
  const oiEl = el('oiChart');
  if (!priceEl || !cotEl || !oiEl) return;

  priceChart = mountChart(priceEl, 440);
  cotChart = mountChart(cotEl, 280);
  oiChart = mountChart(oiEl, 240);

  candleSeries = priceChart.addSeries(CandlestickSeries, {
    upColor: UP,
    downColor: DOWN,
    borderUpColor: UP,
    borderDownColor: DOWN,
    wickUpColor: UP,
    wickDownColor: DOWN,
  });
  barSeries = priceChart.addSeries(BarSeries, {
    upColor: UP,
    downColor: DOWN,
    visible: false,
  });
  volumeSeries = priceChart.addSeries(HistogramSeries, {
    priceScaleId: 'volume',
    priceFormat: { type: 'volume' },
    lastValueVisible: false,
    priceLineVisible: false,
  });
  priceChart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  commSeries = cotChart.addSeries(LineSeries, {
    color: COMM,
    lineWidth: 2,
    lineType: LineType.WithSteps,
    priceLineVisible: false,
  });
  specSeries = cotChart.addSeries(LineSeries, {
    color: SPEC,
    lineWidth: 2,
    lineType: LineType.WithSteps,
    priceLineVisible: false,
  });

  wireControls();
  void poll();
  window.setInterval(() => void poll(), POLL_MS);
}

export function mountDashboard(): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}
