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
const TV_LOAD_TIMEOUT_MS = 15000;

/* ------------------------------------------------------------------ */
/* Module state                                                        */
/* ------------------------------------------------------------------ */

let state: TerminalState | null = null;
let activeId = 'gold';
let cotMode: 'candles' | 'histo' | 'line' = 'candles';
let chartType = '1';
let timeframe = '15';
let tvTimezone = 'Etc/UTC';
let tvStudyPreset = 'none';
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

/* ------------------------------------------------------------------ */
/* TradingView Advanced Chart embed (full drawing toolbar)             */
/* ------------------------------------------------------------------ */

/** tv.js is still used by the optional COT tab; the price chart uses the embed. */
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

const TV_EMBED_SRC = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
let tvEmbedWatchdog: number | null = null;

/** Map the terminal timeframe buttons to TradingView intervals. */
function tvInterval(): string {
  switch (timeframe) {
    case '1': return '1';
    case '5': return '5';
    case '15': return '15';
    case '60': return '60';
    case '240': return '240';
    case 'D': return 'D';
    case 'W': return 'W';
    default: return '15';
  }
}

/** 1 = candles, 0 = bars, 2 = line — same mapping as TradingView. */
function tvStyle(): string {
  return chartType === '2' ? '2' : chartType === '0' ? '0' : '1';
}

/**
 * Indicator presets for the TradingView embed. Objects (never bare strings)
 * are required so several studies can be stacked without breaking the embed.
 */
function tvStudies(): Array<{ id: string; inputs?: Record<string, number> }> {
  switch (tvStudyPreset) {
    case 'ema':
      return [
        { id: 'MAExp@tv-basicstudies', inputs: { length: 20 } },
        { id: 'MAExp@tv-basicstudies', inputs: { length: 50 } },
        { id: 'MAExp@tv-basicstudies', inputs: { length: 200 } },
      ];
    case 'rsi':
      return [{ id: 'RSI@tv-basicstudies' }];
    case 'macd':
      return [{ id: 'MACD@tv-basicstudies' }];
    case 'bb':
      return [{ id: 'BB@tv-basicstudies' }];
    case 'combo':
      return [
        { id: 'MAExp@tv-basicstudies', inputs: { length: 20 } },
        { id: 'MAExp@tv-basicstudies', inputs: { length: 50 } },
        { id: 'RSI@tv-basicstudies' },
        { id: 'MACD@tv-basicstudies' },
      ];
    default:
      return [];
  }
}

function syncEngineButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('#engineBtns button').forEach((b) => {
    b.classList.toggle('active', b.dataset.engine === chartEngine);
  });
  syncEngineControls();
}

/**
 * The asset/pair pill belongs to the Basic engine only — TradingView carries
 * its own symbol search. Timezone and indicator selects only affect the
 * TradingView embed, so they are disabled while Basic is active.
 */
function syncEngineControls(): void {
  const isTv = chartEngine === 'tradingview';
  const pill = el('tqInstrument');
  if (pill) pill.hidden = isTv;

  const tz = el('tvTimezone') as HTMLSelectElement | null;
  if (tz) {
    tz.disabled = !isTv;
    tz.value = tvTimezone;
  }
  const studies = el('tvStudies') as HTMLSelectElement | null;
  if (studies) {
    studies.disabled = !isTv;
    studies.value = tvStudyPreset;
  }
}

/**
 * Render the official TradingView Advanced Chart widget. It ships the complete
 * TradingView toolbar: drawing tools, Fibonacci, indicators, symbol search.
 */
function renderTradingView(): void {
  const host = el('tv-live-chart');
  if (!host) return;

  chartEngine = 'tradingview';
  syncEngineButtons();
  setPulse('connecting', 'CONNECTING TO TRADINGVIEW…');

  const lw = el('lw-live-chart');
  if (lw) lw.hidden = true;
  const fallbackNote = el('tvFallback');
  if (fallbackNote) fallbackNote.hidden = true;
  host.style.display = '';
  host.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'tradingview-widget-container';
  container.style.cssText = 'width:100%;height:100%';
  const widgetHost = document.createElement('div');
  widgetHost.className = 'tradingview-widget-container__widget';
  widgetHost.style.cssText = 'width:100%;height:100%';
  container.appendChild(widgetHost);
  host.appendChild(container);

  const inst = current();
  const symbol = inst?.tvLiveSymbol ?? FALLBACK_SYMBOL;

  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.async = true;
  script.src = TV_EMBED_SRC;
  script.innerHTML = JSON.stringify({
    autosize: true,
    symbol,
    interval: tvInterval(),
    timezone: tvTimezone,
    theme: 'dark',
    style: tvStyle(),
    locale: 'en',
    enable_publishing: false,
    allow_symbol_change: true,
    withdateranges: true,
    hide_side_toolbar: false,
    hide_top_toolbar: false,
    hide_legend: false,
    hide_volume: false,
    save_image: false,
    calendar: false,
    details: false,
    studies: tvStudies(),
    support_host: 'https://www.tradingview.com',
  });
  script.onerror = () => {
    if (chartEngine === 'tradingview') activateFallbackChart('TradingView embed blocked');
  };
  container.appendChild(script);

  const foot = el('liveFoot');
  if (foot) {
    foot.innerHTML =
      'Engine: <b>TradingView Advanced Chart</b> · drawing tools, Fibonacci, indicators and symbol ' +
      'search enabled · Data: TradingView real-time feed';
  }

  // The embed gives no ready callback, so watch for its iframe. A mutation
  // observer flips the status the moment the chart appears; the timeout is
  // only the failure path.
  if (tvEmbedWatchdog) window.clearTimeout(tvEmbedWatchdog);
  const readyObserver = new MutationObserver(() => {
    if (!host.querySelector('iframe')) return;
    readyObserver.disconnect();
    if (tvEmbedWatchdog) window.clearTimeout(tvEmbedWatchdog);
    if (chartEngine === 'tradingview') {
      setPulse('live', 'TRADINGVIEW CHARTS · DRAWING TOOLS ENABLED');
    }
  });
  readyObserver.observe(container, { childList: true, subtree: true });
  tvEmbedWatchdog = window.setTimeout(() => {
    readyObserver.disconnect();
    if (host.querySelector('iframe')) {
      setPulse('live', 'TRADINGVIEW CHARTS · DRAWING TOOLS ENABLED');
    } else if (chartEngine === 'tradingview') {
      activateFallbackChart('TradingView did not render');
    }
  }, TV_LOAD_TIMEOUT_MS);
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
  // Lightweight Charts defers canvas bitmap sizing to an animation frame. In a
  // background/throttled tab that frame never runs, leaving a blurry 300×150
  // bitmap stretched over the container. resize() sizes the bitmap immediately.
  forceChartSize(chart, width, height);
  const ro = new ResizeObserver(() => {
    const r = container.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      forceChartSize(chart, Math.floor(r.width), Math.floor(r.height));
    }
    onResize(chart);
  });
  ro.observe(container);
  (chart as any).__ro = ro;
  return chart;
}

/** Apply a size synchronously to both layout and canvas bitmap. */
function forceChartSize(chart: IChartApi, width: number, height: number): void {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  try {
    (chart as any).resize?.(w, h, true);
  } catch {
    try { chart.applyOptions({ width: w, height: h }); } catch { /* ignore */ }
  }
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
  syncEngineButtons();
  setPulse('live', 'LIVE CHART ACTIVE · AUTOMATED FEED');

  const tvContainer = el('tv-live-chart');
  if (tvContainer) {
    tvContainer.style.display = 'none';
    // Kill the embed iframe so TradingView stops streaming in the background.
    tvContainer.innerHTML = '';
  }
  const lwContainer = el('lw-live-chart');
  if (lwContainer) lwContainer.hidden = false;
  const fallback = el('tvFallback');
  if (fallback) fallback.hidden = true;

  // Keep a clear note in the chart footer about the engine switch.
  const foot = el('liveFoot');
  if (foot) {
    foot.innerHTML =
      `Engine: <b>Basic</b> (Lightweight Charts — ${reason}) · Data: automated Yahoo OHLC proxy ` +
      '· switch back to TradingView any time — no manual refresh required';
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
        timezone: tvTimezone,
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

/** Rebuild the lazy TradingView COT widget after a timezone change. */
function rebuildCotWidget(): void {
  if (!tvCotStarted) return;
  tvCotStarted = false;
  tvCotWidget = null;
  const host = el('tv-cot-chart');
  if (host) host.innerHTML = '';
  const panel = el('tab-tvcot');
  if (panel && !panel.hidden) initCotWidget();
}

/* ------------------------------------------------------------------ */
/* Lightweight Charts COT visualizer                                   */
/* ------------------------------------------------------------------ */function buildCotChart(inst: InstrumentState): void {
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
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
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
        '<span class="lg"><span class="sw" style="background:#26a69a"></span><b>Green candle</b> — commercial net position improved week-on-week (close ≥ open)</span>' +
        '<span class="lg"><span class="sw" style="background:#ef5350"></span><b>Red candle</b> — commercial net position deteriorated (close &lt; open)</span>' +
        '<span class="lg"><span class="sw sw-hollow" style="border-color:#8b93a1"></span>Body = commercial net long/short · wick range padded by |Δ open interest|</span>';
    }
  } else if (cotMode === 'histo') {
    const s1 = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' } });
    s1.setData(
      series
        .filter((r) => r.commNetChange != null)
        .map((r) => ({
          time: r.date as any,
          value: r.commNetChange!,
          color: r.commNetChange! >= 0 ? 'rgba(239,83,80,0.9)' : 'rgba(239,83,80,0.4)',
        })),
    );
    const s2 = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' } });
    s2.setData(
      series
        .filter((r) => r.nonCommNetChange != null)
        .map((r) => ({
          time: r.date as any,
          value: r.nonCommNetChange!,
          color: r.nonCommNetChange! >= 0 ? 'rgba(38,166,154,0.9)' : 'rgba(38,166,154,0.4)',
        })),
    );
    cotLwSeries = [s1, s2];
    if (legend) {
      legend.innerHTML =
        '<span class="lg"><span class="sw" style="background:#ef5350"></span><b>Commercials</b> — red bar, weekly net change (solid = added longs, faded = reduced)</span>' +
        '<span class="lg"><span class="sw" style="background:#26a69a"></span><b>Large speculators</b> — green bar, weekly net change</span>' +
        '<span class="lg"><span class="sw sw-hollow" style="border-color:#8b93a1"></span>Bar above zero = net-long added · below zero = net-long cut</span>';
    }
  } else {
    const s1 = chart.addSeries(LineSeries, { color: '#ef5350', lineWidth: 2, priceLineVisible: false });
    s1.setData(series.map((r) => ({ time: r.date as any, value: r.commNet })));
    const s2 = chart.addSeries(LineSeries, { color: '#26a69a', lineWidth: 2, priceLineVisible: false });
    s2.setData(series.map((r) => ({ time: r.date as any, value: r.nonCommNet })));
    const s3 = chart.addSeries(LineSeries, {
      color: '#a855f7',
      lineWidth: 1,
      priceLineVisible: false,
      priceScaleId: 'right',
    });
    s3.setData(series.map((r) => ({ time: r.date as any, value: r.oi })));
    chart.priceScale('right').applyOptions({ visible: true });
    cotLwSeries = [s1, s2, s3];
    if (legend) {
      legend.innerHTML =
        '<span class="lg"><span class="sw" style="background:#ef5350"></span><b>Red line</b> — commercial / bank net position (hedging flow)</span>' +
        '<span class="lg"><span class="sw" style="background:#26a69a"></span><b>Green line</b> — large-speculator net position (trend flow)</span>' +
        '<span class="lg"><span class="sw" style="background:#a855f7"></span><b>Purple line</b> — total open interest, right scale</span>';
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
          color: r.commNetChange! >= 0 ? 'rgba(239,83,80,0.9)' : 'rgba(239,83,80,0.4)',
        })),
    );
    (cotLwSeries[1] as ISeriesApi<'Histogram'>).setData(
      series
        .filter((r) => r.nonCommNetChange != null)
        .map((r) => ({
          time: r.date as any,
          value: r.nonCommNetChange!,
          color: r.nonCommNetChange! >= 0 ? 'rgba(38,166,154,0.9)' : 'rgba(38,166,154,0.4)',
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
  renderAssetSelect();
}

/** The single "Asset / Pair" dropdown lives in the sticky quick bar. */
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
  const select = el('assetSelect') as HTMLSelectElement | null;
  if (select) select.value = id;

  const inst = current();
  if (!inst) return;
  renderInstrument(inst, Date.now());
  if (chartEngine === 'tradingview') renderTradingView();
  else void loadLiveFallbackData();
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

/** Run one init block; a single failure must never abort the whole app. */
function guard(name: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn(`[terminal] ${name} init skipped:`, e);
  }
}

export function initTerminal(): void {
  // Chart-type controls (TradingView embed + Basic engine).
  guard('chart-type', () => {
    $('chartTypeBtns').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.addEventListener('click', () => {
        chartType = b.dataset.type ?? '1';
        document.querySelectorAll('#chartTypeBtns button').forEach((x) => x.classList.toggle('active', x === b));
        if (chartEngine === 'tradingview') {
          renderTradingView();
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
        if (chartEngine === 'tradingview') {
          renderTradingView();
        } else if (chartEngine === 'fallback') {
          void loadLiveFallbackData();
        }
      });
    });
  });

  // Chart engine switch (TradingView tools ↔ guaranteed Basic chart).
  guard('engine', () => {
    $('engineBtns').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.dataset.engine === 'fallback') {
          activateFallbackChart('manual switch');
        } else {
          renderTradingView();
        }
      });
    });
  });

  // TradingView timezone + indicator presets (TradingView engine only).
  guard('tv-settings', () => {
    const tz = el('tvTimezone') as HTMLSelectElement | null;
    tz?.addEventListener('change', () => {
      tvTimezone = tz.value || 'Etc/UTC';
      if (chartEngine === 'tradingview') renderTradingView();
      rebuildCotWidget();
    });
    const studies = el('tvStudies') as HTMLSelectElement | null;
    studies?.addEventListener('change', () => {
      tvStudyPreset = studies.value || 'none';
      if (chartEngine === 'tradingview') renderTradingView();
    });
  });

  // Quick-access anchors — jump without scrolling hunting, and open the
  // cross-asset tab before jumping to it.
  guard('quick-nav', () => {
    document.querySelectorAll<HTMLAnchorElement>('.tq-link[href^="#"]').forEach((a) => {
      a.addEventListener('click', (e) => {
        const id = (a.getAttribute('href') ?? '').slice(1);
        if (!id) return;
        if (id === 'cross-asset') activateHubTab('finviz');
        const target = el(id);
        if (!target) return;
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(null, '', `#${id}`);
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
      b.addEventListener('click', () => activateHubTab(b.dataset.tab ?? 'cftc'));
    });
  });

  // Live price chart + automated state polling. No manual refresh anywhere.
  guard('live-chart', () => renderTradingView());
  guard('poll', () => {
    void poll();
    window.setInterval(() => void poll(), POLL_INTERVAL_MS);
  });
}

/** Switch the macro hub tab, keeping ARIA state and lazy widgets in sync. */
function activateHubTab(tab: string): void {
  document.querySelectorAll<HTMLButtonElement>('#hubTabs button').forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  (['cftc', 'tvcot', 'finviz'] as const).forEach((t) => {
    const panel = el('tab-' + t);
    if (panel) panel.hidden = t !== tab;
  });
  if (tab === 'tvcot') initCotWidget();
}
