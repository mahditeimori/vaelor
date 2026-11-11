/**
 * Institutional Market Structure & Macro Terminal — client engine.
 *
 * Fully automated, zero manual refresh:
 *  - TradingView Advanced Real-Time chart (tv.js CDN) when reachable
 *  - Automatic Lightweight Charts fallback fed by the Worker `/api/chart` proxy,
 *    so a live price chart is ALWAYS visible even if TradingView is blocked
 *  - CFTC COT visualizer (candle / histogram / line)
 *  - 60-second silent poll of /api/terminal/state with cache busting
 */
import {
  createChart,
  ColorType,
  CrosshairMode,
  CandlestickSeries,
  BarSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
} from 'lightweight-charts';

/**
 * Base URL of the Cloudflare Worker that owns the macro/COT pipeline.
 * Overridable per page with `data-api="https://…"` on #institutional-chart-section.
 */
const API_BASE = (
  document.getElementById('institutional-chart-section')?.getAttribute('data-api') ?? ''
).replace(/\/+$/, '');

/* ------------------------------------------------------------------ */
/* Types (mirror of the /api/terminal/state payload)                   */
/* ------------------------------------------------------------------ */

interface CotCandle { open: number; high: number; low: number; close: number }
interface CotSeriesRow {
  date: string; oi: number; commLong: number; commShort: number;
  nonCommLong: number; nonCommShort: number; nonCommSpread: number; totRepLong: number;
  commNet: number; commNetChange: number | null; nonCommNet: number;
  nonCommNetChange: number | null; oiChange: number | null; candle: CotCandle | null;
}
interface CategorySnapshot {
  date: string; oi: number; source: 'disaggregated' | 'financial';
  categories: Record<string, { long: number; short: number }>;
}
interface CotCache {
  instrumentId: string; updatedAt: string; source: string; reportDate: string | null;
  series: CotSeriesRow[]; snapshot: CategorySnapshot | null;
}
interface MarketCache {
  instrumentId: string; updatedAt: string; provider: string; lastPrice: number | null;
  dailyVolume: number | null; dailyVolumeDelta: number | null; openInterest: number | null;
  openInterestSource: 'yahoo-quote' | 'cftc-fallback' | null;
  series: { date: string; close: number | null; volume: number | null }[];
}
interface InstrumentState {
  id: string; displayName: string; tvLiveSymbol: string; tvFuturesSymbol: string;
  yahooFuturesTicker: string; finvizCode: string;
  cot: CotCache | null; market: MarketCache | null;
  kpis: {
    commercialNet: number | null; commercialNetChange: number | null; commercialLabel: string;
    nonCommercialNet: number | null; nonCommercialNetChange: number | null; nonCommercialLabel: string;
    openInterest: number | null; openInterestChange: number | null;
    dailyVolume: number | null; dailyVolumeDelta: number | null; institutionalRatio: number | null;
  };
}
interface TerminalState {
  generatedAt: string; serverTime: string;
  sync: {
    cftc: { ok: boolean; lastSuccessAt: string | null; latestReportDate: string | null; error: string | null };
    volumeOi: { ok: boolean; lastSuccessAt: string | null; error: string | null };
    bootstrap: { ranAt: string | null; cotSynced: boolean; volumeSynced: boolean };
  };
  instruments: InstrumentState[];
}
interface ChartBar { time: number; open: number; high: number; low: number; close: number; volume: number }
interface ChartPayload { symbol: string; interval: string; bars: ChartBar[] }

declare global {
  interface Window { TradingView?: any }
}

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

const el = (id: string): HTMLElement | null => document.getElementById(id);

const POLL_INTERVAL_MS = 60_000;
const TV_LOAD_TIMEOUT_MS = 7000;

/* ------------------------------------------------------------------ */
/* Module state                                                        */
/* ------------------------------------------------------------------ */

let state: TerminalState | null = null;
let activeId = 'gold';
let cotMode: 'candles' | 'histo' | 'line' = 'candles';
let chartType = '1';
let timeframe = '15';
let tvWidget: any = null;
let tvChartApi: any = null;
let tvCotWidget: any = null;
let tvCotStarted = false;
let cotLwChart: IChartApi | null = null;
let cotLwSeries: ISeriesApi<any>[] = [];
let polling = false;
let chartEngine: 'none' | 'tradingview' | 'fallback' = 'none';
let lwLiveChart: IChartApi | null = null;
let lwLiveSeries: ISeriesApi<any>[] = [];
let lwLoading = false;

const FALLBACK_SYMBOL = 'FOREXCOM:XAUUSD';

const current = (): InstrumentState | null =>
  state?.instruments.find((i) => i.id === activeId) ?? state?.instruments[0] ?? null;

const currentTvSymbol = (): string => current()?.tvLiveSymbol ?? FALLBACK_SYMBOL;

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const fmt = (n: number | null): string =>
  n == null ? '—' : Math.round(n).toLocaleString('en-US');

const fmtSigned = (n: number | null): string =>
  n == null ? '—' : (n > 0 ? '+' : '') + Math.round(n).toLocaleString('en-US');

const fmtTime = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toUTCString().replace('GMT', 'UTC') : '—';

const signClass = (n: number | null): string => (n == null ? '' : n > 0 ? 'pos' : 'neg');

/* ------------------------------------------------------------------ */
/* Pulse indicator                                                     */
/* ------------------------------------------------------------------ */

function setPulse(kind: 'connecting' | 'live' | 'dead', label: string): void {
  const dot = el('pulseDot');
  const labelEl = el('pulseLabel');
  if (dot) {
    dot.className = `pulse-dot ${
      kind === 'live' ? 'pulse-live' : kind === 'dead' ? 'pulse-dead' : 'pulse-connecting'
    }`;
  }
  if (labelEl) labelEl.textContent = label;
}

/* ------------------------------------------------------------------ */
/* TradingView live widget (tv.js CDN)                                 */
/* ------------------------------------------------------------------ */

function loadTradingView(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.TradingView) return resolve();
    const s = document.createElement('script');
    s.src = 'https://s3.tradingview.com/tv.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('tv.js CDN failed to load'));
    document.head.appendChild(s);
  });
}

const TV_OVERRIDES = {
  'paneProperties.background': '#0B0E14',
  'paneProperties.vertGridProperties.color': '#1B2230',
  'paneProperties.horzGridProperties.color': '#1B2230',
  'mainSeriesProperties.candleStyle.upColor': '#3DD68C',
  'mainSeriesProperties.candleStyle.downColor': '#E0656B',
  'mainSeriesProperties.candleStyle.wickUpColor': '#3DD68C',
  'mainSeriesProperties.candleStyle.wickDownColor': '#E0656B',
  'mainSeriesProperties.candleStyle.borderUpColor': '#3DD68C',
  'mainSeriesProperties.candleStyle.borderDownColor': '#E0656B',
};

function tvWidgetOptions(symbol: string): Record<string, unknown> {
  return {
    container_id: 'tv-live-chart',
    autosize: true,
    symbol,
    interval: timeframe,
    timezone: 'Etc/UTC',
    theme: 'dark',
    style: Number(chartType),
    locale: 'en',
    toolbar_bg: '#151921',
    enable_publishing: false,
    allow_symbol_change: true,
    withdateranges: true,
    hide_side_toolbar: false,
    details: true,
    studies: [],
    overrides: TV_OVERRIDES,
  };
}

function initLiveWidget(): void {
  let settled = false;
  const timer = window.setTimeout(() => {
    if (!settled) {
      settled = true;
      activateFallbackChart('TradingView stream timed out');
    }
  }, TV_LOAD_TIMEOUT_MS);

  loadTradingView()
    .then(() => {
      if (settled) return;
      tvWidget = new window.TradingView.widget(tvWidgetOptions(currentTvSymbol()));
      tvWidget.onChartReady(() => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        chartEngine = 'tradingview';
        tvChartApi = tvWidget.chart();
        try { tvChartApi.setChartType(Number(chartType)); } catch { /* ignore */ }
        setPulse('live', 'REAL-TIME TRADINGVIEW STREAM ACTIVE');
        const fallback = el('tvFallback');
        if (fallback) fallback.hidden = true;
      });
    })
    .catch(() => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      activateFallbackChart('TradingView unreachable');
    });
}

function applyTvControls(): void {
  if (!tvChartApi) return;
  try { tvChartApi.setChartType(Number(chartType)); } catch { /* ignore */ }
  try { tvChartApi.setResolution(timeframe); } catch { /* ignore */ }
}

function switchTvSymbol(symbol: string): void {
  if (chartEngine === 'tradingview' && tvChartApi) {
    try { tvChartApi.setSymbol(symbol); return; } catch { /* fall through */ }
  }
  if (chartEngine === 'fallback') void loadLiveFallbackData();
}

/* ------------------------------------------------------------------ */
/* Lightweight Charts — guaranteed live price fallback                 */
/* ------------------------------------------------------------------ */

const LW_LAYOUT = {
  background: { type: ColorType.Solid, color: '#0B0E14' },
  textColor: '#8B93A1',
  fontSize: 11,
  attributionLogo: false,
};
const LW_GRID = {
  vertLines: { color: '#1D232D' },
  horzLines: { color: '#1D232D' },
};

/** Measure a container, falling back to sane defaults when hidden. */
function measure(container: HTMLElement): { width: number; height: number } {
  const rect = container.getBoundingClientRect();
  return {
    width: Math.max(1, Math.floor(rect.width || container.clientWidth || 320)),
    height: Math.max(1, Math.floor(rect.height || container.clientHeight || 300)),
  };
}

/** Create a chart at the container's real pixel size and keep it in sync. */
function mountChart(container: HTMLElement, onResize: (c: IChartApi) => void): IChartApi {
  const { width, height } = measure(container);
  const chart = createChart(container, {
    width,
    height,
    layout: LW_LAYOUT,
    grid: LW_GRID,
    rightPriceScale: { borderColor: '#262C36' },
    timeScale: { borderColor: '#262C36' },
    crosshair: { mode: CrosshairMode.Normal },
  });
  const ro = new ResizeObserver(() => {
    const r = container.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      chart.applyOptions({ width: Math.floor(r.width), height: Math.floor(r.height) });
    }
    onResize(chart);
  });
  ro.observe(container);
  (chart as any).__ro = ro;
  return chart;
}

function teardownChart(chart: IChartApi | null): void {
  if (!chart) return;
  try { (chart as any).__ro?.disconnect?.(); } catch { /* ignore */ }
  try { chart.remove(); } catch { /* ignore */ }
}

/** Map the UI timeframe button to Yahoo range + interval. */
function yahooWindow(): { range: string; interval: string } {
  switch (timeframe) {
    case '1': return { range: '1d', interval: '1m' };
    case '5': return { range: '5d', interval: '5m' };
    case '15': return { range: '5d', interval: '15m' };
    case '60': return { range: '1mo', interval: '1h' };
    case '240': return { range: '3mo', interval: '1h' };
    case 'D': return { range: '1y', interval: '1d' };
    case 'W': return { range: '2y', interval: '1wk' };
    default: return { range: '5d', interval: '15m' };
  }
}

function activateFallbackChart(reason: string): void {
  chartEngine = 'fallback';
  setPulse('live', 'LIVE CHART ACTIVE · AUTOMATED FEED');

  const tvContainer = el('tv-live-chart');
  if (tvContainer) tvContainer.style.display = 'none';
  const lwContainer = el('lw-live-chart');
  if (lwContainer) lwContainer.hidden = false;
  const fallback = el('tvFallback');
  if (fallback) fallback.hidden = true;

  // Keep a subtle note in the panel footer about the engine switch.
  const foot = document.querySelector('.term-root .panel-foot');
  if (foot) {
    foot.innerHTML =
      `Drawing tools &amp; indicators: <b>enabled</b> · Engine: Lightweight Charts (${reason}) ` +
      '· Data: automated Yahoo OHLC proxy — no manual refresh required';
  }

  buildLiveFallbackChart();
  void loadLiveFallbackData();
}

function buildLiveFallbackChart(): void {
  const container = el('lw-live-chart');
  if (!container) return;
  teardownChart(lwLiveChart);
  lwLiveChart = null;
  lwLiveSeries = [];

  lwLiveChart = mountChart(container, () => {
    // No-op: mountChart already applies the new size.
  });
  lwLiveChart.applyOptions({
    rightPriceScale: { borderColor: '#262C36', scaleMargins: { top: 0.08, bottom: 0.28 } },
    timeScale: { borderColor: '#262C36', timeVisible: true, secondsVisible: false },
  });

  const chart = lwLiveChart;

  if (chartType === '2') {
    const s = chart.addSeries(LineSeries, { color: '#c9a24b', lineWidth: 2, priceLineVisible: false });
    lwLiveSeries = [s];
  } else if (chartType === '0') {
    const s = chart.addSeries(BarSeries, {
      upColor: '#3DD68C',
      downColor: '#E0656B',
    });
    lwLiveSeries = [s];
  } else {
    const s = chart.addSeries(CandlestickSeries, {
      upColor: '#3DD68C',
      downColor: '#E0656B',
      borderUpColor: '#3DD68C',
      borderDownColor: '#E0656B',
      wickUpColor: '#3DD68C',
      wickDownColor: '#E0656B',
    });
    const vol = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    lwLiveSeries = [s, vol];
  }
}

async function loadLiveFallbackData(): Promise<void> {
  if (chartEngine !== 'fallback' || lwLoading) return;
  const inst = current();
  if (!inst) return;
  lwLoading = true;
  try {
    const { range, interval } = yahooWindow();
    const url = `${API_BASE}/api/chart?id=${encodeURIComponent(inst.id)}&range=${range}&interval=${interval}&t=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = (await res.json()) as ChartPayload;
    if (!lwLiveChart || !payload.bars?.length) return;

    const bars = payload.bars;
    if (chartType === '2') {
      (lwLiveSeries[0] as ISeriesApi<'Line'>).setData(bars.map((b) => ({ time: b.time as any, value: b.close })));
    } else if (chartType === '0') {
      (lwLiveSeries[0] as ISeriesApi<'Bar'>).setData(
        bars.map((b) => ({ time: b.time as any, open: b.open, high: b.high, low: b.low, close: b.close })),
      );
    } else {
      (lwLiveSeries[0] as ISeriesApi<'Candlestick'>).setData(
        bars.map((b) => ({ time: b.time as any, open: b.open, high: b.high, low: b.low, close: b.close })),
      );
      (lwLiveSeries[1] as ISeriesApi<'Histogram'>).setData(
        bars.map((b) => ({
          time: b.time as any,
          value: b.volume,
          color: b.close >= b.open ? 'rgba(61,214,140,0.35)' : 'rgba(224,101,107,0.35)',
        })),
      );
    }
    lwLiveChart.timeScale().fitContent();
  } catch {
    // Next poll retries automatically.
  } finally {
    lwLoading = false;
  }
}

/* ------------------------------------------------------------------ */
/* TradingView COT & OI widget (tab 2)                                 */
/* ------------------------------------------------------------------ */

/** Lazily created the first time tab 2 (TradingView COT & OI) is opened. */
function initCotWidget(): void {
  if (tvCotStarted) return;
  tvCotStarted = true;
  const inst = current();
  if (!inst) return;
  loadTradingView()
    .then(() => {
      const host = el('tv-cot-chart');
      if (!host) return;
      tvCotWidget = new window.TradingView.widget({
        container_id: 'tv-cot-chart',
        autosize: true,
        symbol: inst.tvFuturesSymbol,
        interval: '1W',
        timezone: 'Etc/UTC',
        theme: 'dark',
        style: '1',
        locale: 'en',
        toolbar_bg: '#151921',
        enable_publishing: false,
        allow_symbol_change: true,
        withdateranges: true,
        studies: [],
        overrides: TV_OVERRIDES,
      });
      tvCotWidget.onChartReady(() => {
        try { tvCotWidget.chart().createStudy('COT', false, false); } catch { /* optional study */ }
        try { tvCotWidget.chart().createStudy('OpenInterest@tv-basicstudies', false, false); } catch { /* optional study */ }
      });
    })
    .catch(() => {
      const host = el('tv-cot-chart');
      if (host) {
        host.innerHTML =
          '<div class="tv-cot-offline">TradingView is not reachable from this network. ' +
          'Use tab 1 (CFTC raw data) — it is authoritative and fully automated.</div>';
      }
    });
}

/* ------------------------------------------------------------------ */
/* Lightweight Charts COT visualizer                                   */
/* ------------------------------------------------------------------ */

function buildCotChart(inst: InstrumentState): void {
  const container = el('cotChart');
  if (!container) return;

  if (cotLwChart) {
    teardownChart(cotLwChart);
    cotLwChart = null;
  }
  cotLwSeries = [];

  const chart = mountChart(container, (c) => {
    // Keep the COT chart fitted after a resize.
    try { c.timeScale().fitContent(); } catch { /* ignore */ }
  });

  const series = inst.cot?.series ?? [];
  const legend = el('cotLegend');

  if (cotMode === 'candles') {
    const s = chart.addSeries(CandlestickSeries, {
      upColor: '#3DD68C',
      downColor: '#E0656B',
      borderUpColor: '#3DD68C',
      borderDownColor: '#E0656B',
      wickUpColor: '#3DD68C',
      wickDownColor: '#E0656B',
    });
    s.setData(
      series
        .filter((r) => r.candle)
        .map((r) => ({
          time: r.date as any,
          open: r.candle!.open,
          high: r.candle!.high,
          low: r.candle!.low,
          close: r.candle!.close,
        })),
    );
    cotLwSeries = [s];
    if (legend) {
      legend.innerHTML =
        '<span class="lg"><span class="sw" style="background:#3DD68C"></span>Commercial net weekly candle (open/close = net, range padded by |ΔOI|)</span>';
    }
  } else if (cotMode === 'histo') {
    const s1 = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' } });
    s1.setData(
      series
        .filter((r) => r.commNetChange != null)
        .map((r) => ({
          time: r.date as any,
          value: r.commNetChange!,
          color: r.commNetChange! >= 0 ? 'rgba(61,214,140,0.85)' : 'rgba(224,101,107,0.85)',
        })),
    );
    const s2 = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' } });
    s2.setData(
      series
        .filter((r) => r.nonCommNetChange != null)
        .map((r) => ({
          time: r.date as any,
          value: r.nonCommNetChange!,
          color: r.nonCommNetChange! >= 0 ? 'rgba(201,162,75,0.8)' : 'rgba(201,162,75,0.35)',
        })),
    );
    cotLwSeries = [s1, s2];
    if (legend) {
      legend.innerHTML =
        '<span class="lg"><span class="sw" style="background:rgba(61,214,140,0.85)"></span>Commercial net change (w/w)</span>' +
        '<span class="lg"><span class="sw" style="background:rgba(201,162,75,0.8)"></span>Large speculator net change (w/w)</span>';
    }
  } else {
    const s1 = chart.addSeries(LineSeries, { color: '#3DD68C', lineWidth: 2, priceLineVisible: false });
    s1.setData(series.map((r) => ({ time: r.date as any, value: r.commNet })));
    const s2 = chart.addSeries(LineSeries, { color: '#C9A24B', lineWidth: 2, priceLineVisible: false });
    s2.setData(series.map((r) => ({ time: r.date as any, value: r.nonCommNet })));
    const s3 = chart.addSeries(LineSeries, {
      color: '#5A6270',
      lineWidth: 1,
      priceLineVisible: false,
      priceScaleId: 'right',
    });
    s3.setData(series.map((r) => ({ time: r.date as any, value: r.oi })));
    chart.priceScale('right').applyOptions({ visible: true });
    cotLwSeries = [s1, s2, s3];
    if (legend) {
      legend.innerHTML =
        '<span class="lg"><span class="sw" style="background:#3DD68C"></span>Commercial net</span>' +
        '<span class="lg"><span class="sw" style="background:#C9A24B"></span>Large speculator net</span>' +
        '<span class="lg"><span class="sw" style="background:#5A6270"></span>Open interest (right scale)</span>';
    }
  }

  if (series.length) chart.timeScale().fitContent();
  cotLwChart = chart;
}

/** Silent in-place update: re-feed series data without rebuilding the chart. */
function updateCotChartData(inst: InstrumentState): void {
  if (!cotLwChart) {
    buildCotChart(inst);
    return;
  }
  const series = inst.cot?.series ?? [];
  if (cotMode === 'candles') {
    (cotLwSeries[0] as ISeriesApi<'Candlestick'>).setData(
      series
        .filter((r) => r.candle)
        .map((r) => ({
          time: r.date as any,
          open: r.candle!.open,
          high: r.candle!.high,
          low: r.candle!.low,
          close: r.candle!.close,
        })),
    );
  } else if (cotMode === 'histo') {
    (cotLwSeries[0] as ISeriesApi<'Histogram'>).setData(
      series
        .filter((r) => r.commNetChange != null)
        .map((r) => ({
          time: r.date as any,
          value: r.commNetChange!,
          color: r.commNetChange! >= 0 ? 'rgba(61,214,140,0.85)' : 'rgba(224,101,107,0.85)',
        })),
    );
    (cotLwSeries[1] as ISeriesApi<'Histogram'>).setData(
      series
        .filter((r) => r.nonCommNetChange != null)
        .map((r) => ({
          time: r.date as any,
          value: r.nonCommNetChange!,
          color: r.nonCommNetChange! >= 0 ? 'rgba(201,162,75,0.8)' : 'rgba(201,162,75,0.35)',
        })),
    );
  } else {
    (cotLwSeries[0] as ISeriesApi<'Line'>).setData(series.map((r) => ({ time: r.date as any, value: r.commNet })));
    (cotLwSeries[1] as ISeriesApi<'Line'>).setData(series.map((r) => ({ time: r.date as any, value: r.nonCommNet })));
    (cotLwSeries[2] as ISeriesApi<'Line'>).setData(series.map((r) => ({ time: r.date as any, value: r.oi })));
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderPills(): void {
  if (!state) return;
  const wrap = el('assetPills');
  if (wrap) {
    wrap.innerHTML = state.instruments
      .map(
        (i) =>
          `<button type="button" role="tab" aria-selected="${i.id === activeId}" class="asset-pill${
            i.id === activeId ? ' active' : ''
          }" data-asset="${i.id}">${i.displayName}</button>`,
      )
      .join('');
    wrap.querySelectorAll<HTMLButtonElement>('.asset-pill').forEach((b) => {
      b.addEventListener('click', () => switchInstrument(b.dataset.asset ?? 'gold'));
    });
  }
  renderAssetSelect();
}

/** The prominent "Asset / Pair" dropdown in the chart control bar. */
function renderAssetSelect(): void {
  const select = el('assetSelect') as HTMLSelectElement | null;
  if (!select || !state) return;
  select.innerHTML = state.instruments
    .map((i) => {
      const label = i.tvLiveSymbol.includes(':') ? i.tvLiveSymbol.split(':')[1] : i.tvLiveSymbol;
      return `<option value="${i.id}">${i.displayName} · ${label}</option>`;
    })
    .join('');
  select.value = activeId;
  if (!select.dataset.bound) {
    select.dataset.bound = '1';
    select.addEventListener('change', () => switchInstrument(select.value));
  }
}

function renderSyncBadge(): void {
  if (!state) return;
  const badge = el('syncBadge');
  if (!badge) return;
  const { cftc, volumeOi, bootstrap } = state.sync;
  const parts: string[] = [];
  parts.push(
    cftc.latestReportDate
      ? `CFTC report ${cftc.latestReportDate} · synced ${fmtTime(cftc.lastSuccessAt)}`
      : 'CFTC: initial bootstrap in progress…',
  );
  parts.push(volumeOi.ok ? `Futures Vol/OI ${fmtTime(volumeOi.lastSuccessAt)}` : 'Futures Vol/OI: pending');
  if (!cftc.ok || !volumeOi.ok) parts.push('⚠ partial — retrying automatically');
  badge.textContent = `Last automated CFTC & CME sync — ${parts.join(' · ')}${
    bootstrap.ranAt ? ' · next check: 60s' : ''
  }`;
}

function renderKpis(inst: InstrumentState): void {
  const grid = el('kpiGrid');
  if (!grid) return;
  const k = inst.kpis;
  const cards: string[] = [
    `<div class="kpi">
      <div class="kpi-label">COMMERCIAL / BANK NET POSITION</div>
      <div class="kpi-value ${signClass(k.commercialNet)}">${fmt(k.commercialNet)}</div>
      <div class="kpi-delta ${signClass(k.commercialNetChange)}">Δ w/w ${fmtSigned(k.commercialNetChange)} contracts</div>
      <div class="kpi-src">${k.commercialLabel} · ${inst.cot?.reportDate ?? '—'}</div>
    </div>`,
    `<div class="kpi">
      <div class="kpi-label">LARGE SPECULATORS NET POSITION</div>
      <div class="kpi-value ${signClass(k.nonCommercialNet)}">${fmt(k.nonCommercialNet)}</div>
      <div class="kpi-delta ${signClass(k.nonCommercialNetChange)}">Δ w/w ${fmtSigned(k.nonCommercialNetChange)} contracts</div>
      <div class="kpi-src">${k.nonCommercialLabel} · ${inst.cot?.reportDate ?? '—'}</div>
    </div>`,
    `<div class="kpi">
      <div class="kpi-label">TOTAL FUTURES OPEN INTEREST</div>
      <div class="kpi-value">${fmt(k.openInterest)}</div>
      <div class="kpi-delta ${signClass(k.openInterestChange)}">Δ w/w ${fmtSigned(k.openInterestChange)} contracts</div>
      <div class="kpi-src">CFTC legacy futures-only · ${inst.cot?.reportDate ?? '—'}</div>
    </div>`,
    `<div class="kpi">
      <div class="kpi-label">DAILY FUTURES VOLUME &amp; INSTITUTIONAL PARTICIPATION</div>
      <div class="kpi-value">${fmt(k.dailyVolume)}</div>
      <div class="kpi-delta">Participation ${
        k.institutionalRatio != null ? (k.institutionalRatio * 100).toFixed(1) + '%' : '—'
      } of OI · vol Δ ${fmtSigned(k.dailyVolumeDelta)}</div>
      <div class="kpi-src">Yahoo v8 daily tape · ${inst.market ? fmtTime(inst.market.updatedAt) : '—'}</div>
    </div>`,
  ];
  grid.innerHTML = cards.join('');
}

function renderBreakdown(inst: InstrumentState): void {
  const snap = inst.cot?.snapshot;
  const title = el('bdTitle');
  const table = el('cotBreakdown');
  if (!title || !table) return;
  if (!snap) {
    title.textContent = 'Category breakdown — awaiting first CFTC ingest…';
    table.innerHTML = '';
    return;
  }
  title.textContent = `Category breakdown — ${
    snap.source === 'disaggregated' ? 'Disaggregated (f_disagg)' : 'Traders in Financial Futures (TFF)'
  } · report ${snap.date}`;
  const rows = Object.entries(snap.categories)
    .map(([cat, v]) => {
      const net = v.long - v.short;
      return `<tr>
        <td>${cat}</td>
        <td>${fmt(v.long)}</td>
        <td>${fmt(v.short)}</td>
        <td class="${net >= 0 ? 'net-pos' : 'net-neg'}">${fmt(net)}</td>
      </tr>`;
    })
    .join('');
  table.innerHTML = `<table>
    <thead><tr><th>Category</th><th>Long</th><th>Short</th><th>Net</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderHubMeta(inst: InstrumentState): void {
  const meta = el('hubMeta');
  if (!meta) return;
  const cot = inst.cot;
  meta.textContent = cot
    ? `CFTC ${cot.reportDate ?? '—'} · ${cot.series.length} weekly observations · ${inst.displayName}`
    : 'CFTC: awaiting bootstrap…';
}

function renderFinviz(inst: InstrumentState, bust: number): void {
  const main = el('finvizMain') as HTMLImageElement | null;
  const fallback = el('finvizFallback');
  if (main) {
    main.src = `${API_BASE}/api/finviz?code=${inst.finvizCode}&p=w1&t=${bust}`;
    main.onload = () => { main.style.display = ''; if (fallback) fallback.hidden = true; };
    main.onerror = () => { main.style.display = 'none'; if (fallback) fallback.hidden = false; };
  }

  const compare = el('finvizCompare');
  if (!compare || !state) return;
  const seen = new Set<string>();
  const uniq: InstrumentState[] = [];
  for (const i of state.instruments) {
    if (!seen.has(i.finvizCode)) { seen.add(i.finvizCode); uniq.push(i); }
  }
  compare.innerHTML = uniq
    .map(
      (i) => `<div class="finviz-thumb" data-thumb="${i.finvizCode}">
        <span class="thumb-label">${i.finvizCode}</span>
        <img src="${API_BASE}/api/finviz?code=${i.finvizCode}&p=w1&t=${bust}" alt="Finviz COT ${i.finvizCode}" loading="lazy" onerror="this.closest('.finviz-thumb')?.classList.add('failed')" />
      </div>`,
    )
    .join('');
}

function renderInstrument(inst: InstrumentState, bust: number): void {
  const label = el('liveSymbolLabel');
  if (label) label.textContent = `${inst.tvLiveSymbol} — ${inst.displayName}`;
  renderKpis(inst);
  buildCotChart(inst);
  renderBreakdown(inst);
  renderHubMeta(inst);
  renderFinviz(inst, bust);
}

function switchInstrument(id: string): void {
  if (!state) return;
  activeId = id;
  document.querySelectorAll<HTMLButtonElement>('.asset-pill').forEach((b) => {
    const active = b.dataset.asset === id;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  const select = el('assetSelect') as HTMLSelectElement | null;
  if (select) select.value = id;

  const inst = current();
  if (!inst) return;
  renderInstrument(inst, Date.now());
  switchTvSymbol(inst.tvLiveSymbol);
  if (tvCotWidget && typeof tvCotWidget.setSymbol === 'function') {
    try { tvCotWidget.setSymbol(inst.tvFuturesSymbol); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/* Polling (60-second silent auto-sync, cache-busted)                  */
/* ------------------------------------------------------------------ */

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const res = await fetch(`${API_BASE}/api/terminal/state?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = (await res.json()) as TerminalState;
    const first = !state;
    state = next;
    if (first) {
      renderPills();
      renderInstrument(current() ?? next.instruments[0], Date.now());
      renderSyncBadge();
      if (chartEngine === 'fallback') void loadLiveFallbackData();
    } else {
      // Silent in-place refresh: KPIs, chart data, badges, images.
      renderSyncBadge();
      const inst = current();
      if (inst) {
        renderKpis(inst);
        updateCotChartData(inst);
        renderBreakdown(inst);
        renderHubMeta(inst);
        if (chartEngine === 'fallback') void loadLiveFallbackData();
      }
      const bust = Date.now();
      const main = el('finvizMain') as HTMLImageElement | null;
      if (main && inst) main.src = `${API_BASE}/api/finviz?code=${inst.finvizCode}&p=w1&t=${bust}`;
      document.querySelectorAll<HTMLImageElement>('#finvizCompare img').forEach((img) => {
        img.src = `${img.src.split('&t=')[0]}&t=${bust}`;
      });
    }
  } catch {
    // Keep the last known state; the next cycle retries automatically.
    if (!state) {
      const badge = el('syncBadge');
      if (badge) badge.textContent = 'Backend not reachable yet — automated retry in 60s…';
    }
  } finally {
    polling = false;
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

/** Point the MCP / REST cards at the actual Worker host. */
function renderAiLinks(): void {
  if (!API_BASE) return;
  const mcp = el('mcpUrl');
  if (mcp) mcp.textContent = `${API_BASE}/mcp`;
  const stateUrl = el('stateUrl');
  if (stateUrl) stateUrl.textContent = `${API_BASE}/api/terminal/state`;
}

function wireCopyButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('.ai-copy').forEach((b) => {
    b.addEventListener('click', async () => {
      const target = b.dataset.copy;
      const text = (target ? el(target)?.textContent : '')?.trim() ?? '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const prev = b.textContent;
        b.textContent = 'Copied ✓';
        window.setTimeout(() => { b.textContent = prev; }, 1500);
      } catch {
        /* clipboard permission blocked — the URL stays selectable */
      }
    });
  });
}

/** Run one init block; a single failure must never abort the whole app. */
function guard(name: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn(`[terminal] ${name} init skipped:`, e);
  }
}

export function initTerminal(): void {
  // Chart-type controls (live price panel + fallback engine).
  guard('chart-type', () => {
    $('chartTypeBtns').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.addEventListener('click', () => {
        chartType = b.dataset.type ?? '1';
        document.querySelectorAll('#chartTypeBtns button').forEach((x) => x.classList.toggle('active', x === b));
        if (chartEngine === 'tradingview' && tvChartApi) {
          try { tvChartApi.setChartType(Number(chartType)); } catch { /* ignore */ }
        } else if (chartEngine === 'fallback') {
          buildLiveFallbackChart();
          void loadLiveFallbackData();
        }
      });
    });
  });

  // Timeframe controls.
  guard('timeframe', () => {
    $('timeframeBtns').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.addEventListener('click', () => {
        timeframe = b.dataset.tf ?? '15';
        document.querySelectorAll('#timeframeBtns button').forEach((x) => x.classList.toggle('active', x === b));
        if (chartEngine === 'tradingview' && tvChartApi) {
          try { tvChartApi.setResolution(timeframe); } catch { /* ignore */ }
        } else if (chartEngine === 'fallback') {
          void loadLiveFallbackData();
        }
      });
    });
  });

  // COT render-mode switcher.
  guard('cot-mode', () => {
    $('cotModeBtns').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.addEventListener('click', () => {
        cotMode = (b.dataset.mode ?? 'candles') as 'candles' | 'histo' | 'line';
        document.querySelectorAll('#cotModeBtns button').forEach((x) => x.classList.toggle('active', x === b));
        const inst = current();
        if (inst) buildCotChart(inst);
      });
    });
  });

  // Hub tabs.
  guard('hub-tabs', () => {
    $('hubTabs').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.addEventListener('click', () => {
        const tab = b.dataset.tab ?? 'cftc';
        document.querySelectorAll('#hubTabs button').forEach((x) => {
          const active = x === b;
          x.classList.toggle('active', active);
          x.setAttribute('aria-selected', String(active));
        });
        (['cftc', 'tvcot', 'finviz'] as const).forEach((t) => {
          const panel = el('tab-' + t);
          if (panel) panel.hidden = t !== tab;
        });
        if (tab === 'tvcot') initCotWidget();
      });
    });
  });

  // Live price chart + automated state polling. No manual refresh anywhere.
  guard('ai-links', () => { renderAiLinks(); wireCopyButtons(); });
  guard('live-chart', () => initLiveWidget());
  guard('poll', () => {
    void poll();
    window.setInterval(() => void poll(), POLL_INTERVAL_MS);
  });
}
