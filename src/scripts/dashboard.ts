/**
 * Composite dashboard — live macro data.
 *
 * Panels, all fed by the Worker (same engine as the institutional terminal):
 *   1. price + volume        → /api/chart (weekly OHLCV, 2y) aggregated to W/M/Q
 *   2. futures open interest → CFTC weekly series from /api/terminal/state
 *   3. commercial vs spec net → CFTC weekly series from /api/terminal/state
 *
 * Everything auto-refreshes. No mock series, no manual refresh.
 */
import {
  createChart,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';

const API_BASE = 'https://trading-llc-mcp.mahdi-t8256.workers.dev';
const POLL_MS = 60_000;

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

type Tf = 'W' | 'M' | 'Q';

let state: TerminalState | null = null;
let activeId = 'gold';
let currentTf: Tf = 'W';
let priceChart: IChartApi | null = null;
let oiChart: IChartApi | null = null;
let cotChart: IChartApi | null = null;
let priceLine: ISeriesApi<'Line'> | null = null;
let volumeSeries: ISeriesApi<'Histogram'> | null = null;
let oiSeries: ISeriesApi<'Line'> | null = null;
let cotHist: ISeriesApi<'Histogram'> | null = null;
let cotLine: ISeriesApi<'Line'> | null = null;
let priceBars: MarketPoint[] = [];
let priceKey = '';
let priceToken = 0;
let polling = false;

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const fmt = (n: number | null | undefined): string =>
  n == null ? '—' : Math.round(n).toLocaleString('en-US');
const fmtSigned = (n: number | null | undefined): string =>
  n == null ? '—' : (n > 0 ? '+' : '') + Math.round(n).toLocaleString('en-US');
const fmtPct = (n: number): string => `${n > 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
const fmtTime = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toUTCString().replace('GMT', 'UTC') : '—';

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = avg(xs);
  return Math.sqrt(avg(xs.map((x) => (x - m) ** 2)));
};

const current = (): Instrument | null =>
  state?.instruments.find((i) => i.id === activeId) ?? state?.instruments[0] ?? null;

const isoDay = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toISOString().slice(0, 10);

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
      vertLines: { color: 'rgba(35,43,58,0.45)' },
      horzLines: { color: 'rgba(35,43,58,0.45)' },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: 'rgba(94,234,212,0.35)', labelBackgroundColor: '#1f2937' },
      horzLine: { color: 'rgba(94,234,212,0.35)', labelBackgroundColor: '#1f2937' },
    },
    timeScale: { borderColor: '#232b3a', rightOffset: 4, timeVisible: false },
    rightPriceScale: { borderColor: '#232b3a' },
  };
}

/** Size both the layout and the canvas bitmap synchronously. */
function sizeChart(chart: IChartApi, w: number, h: number): void {
  const width = Math.max(1, Math.floor(w));
  const height = Math.max(1, Math.floor(h));
  try {
    (chart as unknown as { resize?: (w: number, h: number, f?: boolean) => void }).resize?.(
      width,
      height,
      true,
    );
  } catch {
    try {
      chart.applyOptions({ width, height });
    } catch {
      /* ignore */
    }
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
/* Aggregation (weekly source → W / M / Q buckets)                     */
/* ------------------------------------------------------------------ */

function bucketKey(date: string, tf: Tf): string {
  if (tf === 'W') return date;
  if (tf === 'M') return date.slice(0, 7);
  const [y, m] = date.split('-').map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

interface Bar {
  date: string;
  close: number;
  volume: number;
}

/** Price bars: weekly source, so W keeps each week; M/Q take the last close and sum volume. */
function aggregateMarket(rows: MarketPoint[], tf: Tf): Bar[] {
  const clean = rows
    .filter((p): p is MarketPoint & { close: number } => typeof p.close === 'number')
    .sort((a, b) => a.date.localeCompare(b.date));
  if (tf === 'W') {
    return clean.map((p) => ({ date: p.date, close: p.close, volume: p.volume ?? 0 }));
  }
  const out = new Map<string, Bar>();
  for (const p of clean) {
    const key = bucketKey(p.date, tf);
    const prev = out.get(key);
    out.set(key, {
      date: p.date,
      close: p.close,
      volume: (prev?.volume ?? 0) + (p.volume ?? 0),
    });
  }
  return [...out.values()];
}

/** COT/OI: weekly source; M/Q keep the last observation in each bucket. */
function aggregateCot(series: CotRow[], tf: Tf): CotRow[] {
  if (tf === 'W') return series;
  const out = new Map<string, CotRow>();
  for (const row of series) out.set(bucketKey(row.date, tf), row);
  return [...out.values()];
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderPrice(inst: Instrument): void {
  if (!priceChart) return;
  const rows = aggregateMarket(priceBars.length ? priceBars : (inst.market?.series ?? []), currentTf);
  if (!rows.length) return;
  if (!priceLine) {
    priceLine = priceChart.addSeries(LineSeries, {
      color: '#5eead4',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    volumeSeries = priceChart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    priceChart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  }
  priceLine.setData(rows.map((r) => ({ time: r.date as Time, value: r.close })));
  volumeSeries!.setData(
    rows.map((r, i) => ({
      time: r.date as Time,
      value: r.volume,
      color:
        i > 0 && r.close >= rows[i - 1].close
          ? 'rgba(52,211,153,0.40)'
          : 'rgba(248,113,113,0.40)',
    })),
  );
  priceChart.timeScale().fitContent();

  const stat = el('priceStat');
  if (stat) {
    const last = rows.at(-1)!;
    const prev = rows.at(-2);
    const chg = prev && prev.close ? (last.close - prev.close) / prev.close : 0;
    stat.innerHTML = `Last <b>${last.close.toFixed(2)}</b> · ${fmtPct(chg)} · Vol <b>${fmt(last.volume)}</b>`;
  }
}

function renderOi(inst: Instrument): void {
  if (!oiChart) return;
  const rows = aggregateCot(inst.cot?.series ?? [], currentTf);
  if (!rows.length) return;
  if (!oiSeries) {
    oiSeries = oiChart.addSeries(LineSeries, {
      color: '#fbbf24',
      lineWidth: 2,
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
    });
  }
  oiSeries.setData(rows.map((r) => ({ time: r.date as Time, value: r.oi })));
  oiChart.timeScale().fitContent();

  const k = inst.kpis;
  const stat = el('oiStat');
  if (stat) {
    const pct = k.openInterest && k.openInterestChange
      ? fmtPct(k.openInterestChange / (k.openInterest - k.openInterestChange))
      : '—';
    stat.innerHTML = `Latest <b>${fmt(k.openInterest)}</b> · Δ w/w <b>${fmtSigned(k.openInterestChange)}</b> (${pct})`;
  }
}

function renderCot(inst: Instrument): void {
  if (!cotChart) return;
  const rows = aggregateCot(inst.cot?.series ?? [], currentTf);
  if (!rows.length) return;
  if (!cotHist) {
    cotHist = cotChart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
    });
    cotLine = cotChart.addSeries(LineSeries, {
      color: '#fbbf24',
      lineWidth: 2,
      priceLineVisible: false,
    });
  }
  cotHist.setData(
    rows.map((r) => ({
      time: r.date as Time,
      value: r.commNet,
      color: r.commNet >= 0 ? 'rgba(52,211,153,0.72)' : 'rgba(248,113,113,0.72)',
    })),
  );
  cotLine!.setData(rows.map((r) => ({ time: r.date as Time, value: r.nonCommNet })));
  cotChart.timeScale().fitContent();

  const k = inst.kpis;
  const stat = el('cotStat');
  if (stat) {
    stat.innerHTML =
      `Commercials <b>${fmt(k.commercialNet)}</b> (${fmtSigned(k.commercialNetChange)}) · ` +
      `Specs <b>${fmt(k.nonCommercialNet)}</b>`;
  }
}

function priceAt(date: string): number | null {
  let best: number | null = null;
  for (const p of priceBars) {
    if (p.date <= date && typeof p.close === 'number') best = p.close;
  }
  return best;
}

function updateComposite(inst: Instrument): void {
  const rows = inst.cot?.series ?? [];
  const prices = (inst.market?.series ?? []).filter(
    (p): p is MarketPoint & { close: number } => typeof p.close === 'number',
  );
  const lastRow = rows.at(-1);
  const prevRow = rows.at(-2);
  const lastPrice = prices.at(-1)?.close ?? null;
  const prevPrice = prices.at(-2)?.close ?? lastPrice;

  const comm = rows.map((r) => r.commNet);
  const recent = comm.slice(-156);
  const sd = stdev(recent);
  const z = sd ? (comm.at(-1)! - avg(recent)) / sd : 0;

  const dPrice = lastPrice && prevPrice ? (lastPrice - prevPrice) / prevPrice : 0;
  const dOi = lastRow && prevRow && prevRow.oi ? (lastRow.oi - prevRow.oi) / prevRow.oi : 0;

  let stateLabel = '—';
  let stateDetail = 'Awaiting open-interest history';
  let tone = '';
  if (lastRow && prevRow) {
    if (dPrice >= 0 && dOi >= 0) {
      stateLabel = 'Long buildup';
      tone = 'state-up';
    } else if (dPrice < 0 && dOi >= 0) {
      stateLabel = 'Short buildup';
      tone = 'state-down';
    } else if (dPrice >= 0 && dOi < 0) {
      stateLabel = 'Short covering';
      tone = 'state-up';
    } else {
      stateLabel = 'Long liquidation';
      tone = 'state-down';
    }
    stateDetail = `Price ${fmtPct(dPrice)} · OI ${fmtPct(dOi)}`;
  }

  let flipPrice: number | null = null;
  for (let i = rows.length - 1; i > 0; i--) {
    if (Math.sign(rows[i].commNet) !== Math.sign(rows[i - 1].commNet)) {
      flipPrice = priceAt(rows[i].date);
      break;
    }
  }
  const distBp =
    flipPrice && lastPrice ? ((flipPrice - lastPrice) / lastPrice) * 10_000 : null;

  const ma = prices.length ? avg(prices.slice(-50).map((p) => p.close)) : 0;
  const regime = lastPrice && ma ? (lastPrice >= ma ? 'Risk-on' : 'Risk-off') : 'Neutral';

  let aligned = 0;
  if (Math.abs(z) >= 2) aligned++;
  if (stateLabel === 'Long buildup' || stateLabel === 'Short covering') aligned++;
  if ((lastRow?.commNetChange ?? 0) > 0) aligned++;
  const flag = aligned >= 3 ? 'Aligned' : aligned === 2 ? 'Watch' : 'None';

  const set = (id: string, text: string, cls?: string) => {
    const node = el(id);
    if (!node) return;
    node.textContent = text;
    if (cls !== undefined) node.className = cls;
  };
  set('stateLabel', stateLabel, `v ${tone}`);
  set('stateDetail', stateDetail);
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
  renderOi(inst);
  renderCot(inst);
  updateComposite(inst);
  renderAges(inst);
}

/* ------------------------------------------------------------------ */
/* Live price series (/api/chart, weekly, 2y)                          */
/* ------------------------------------------------------------------ */

async function loadPriceSeries(inst: Instrument): Promise<void> {
  const token = ++priceToken;
  try {
    const res = await fetch(
      `${API_BASE}/api/chart?id=${encodeURIComponent(inst.id)}&range=2y&interval=1wk&t=${Date.now()}`,
      { cache: 'no-store' },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { bars?: ChartBar[] };
    if (token !== priceToken) return;
    priceBars = (data.bars ?? [])
      .map((b) => ({ date: isoDay(b.time), close: b.close, volume: b.volume ?? 0 }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (priceBars.length) {
      priceKey = inst.id;
      renderPrice(inst);
    }
  } catch {
    if (token !== priceToken) return;
    // Fall back to the 60-day daily series carried in the state payload.
    priceBars = [];
    priceKey = inst.id;
    renderPrice(inst);
  }
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

function renderSymbolSelect(): void {
  const select = el<HTMLSelectElement>('symbolSelect');
  if (!select || !state) return;
  select.innerHTML = state.instruments
    .map((i) => `<option value="${i.id}">${i.displayName}</option>`)
    .join('');
  select.value = activeId;
  if (!select.dataset.bound) {
    select.dataset.bound = '1';
    select.addEventListener('change', () => {
      activeId = select.value;
      const inst = current();
      if (!inst) return;
      renderAll();
      void loadPriceSeries(inst);
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
      renderAll();
      if (priceKey !== inst.id) void loadPriceSeries(inst);
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
  const oiEl = el('oiChart');
  const cotEl = el('cotChart');
  if (!priceEl || !oiEl || !cotEl) return;

  priceChart = mountChart(priceEl, 420);
  oiChart = mountChart(oiEl, 240);
  cotChart = mountChart(cotEl, 260);

  const toggle = el('tfToggle');
  toggle?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-tf]');
    if (!btn) return;
    toggle.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentTf = (btn as HTMLButtonElement).dataset.tf as Tf;
    renderAll();
  });

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
