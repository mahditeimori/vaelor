/**
 * Institutional Market Structure & Macro Terminal — client engine.
 *
 * Responsibilities (fully automated, zero manual refresh):
 *  - boots the TradingView tv.js live chart (sub-second WebSocket stream)
 *  - renders the CFTC COT visualizer with Lightweight Charts (candle/histogram/line)
 *  - silently polls /api/terminal/state every 60 seconds with cache busting and
 *    re-renders KPIs, charts and Finviz panels in place (no page reload)
 */
import {
  createChart,
  ColorType,
  CrosshairMode,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
} from 'lightweight-charts';

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

const POLL_INTERVAL_MS = 60_000;

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

const current = (): InstrumentState => {
  const s = state?.instruments.find((i) => i.id === activeId);
  return s ?? (state?.instruments[0] as InstrumentState);
};

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
  const dot = $('pulseDot');
  dot.className = `pulse-dot ${kind === 'live' ? 'pulse-live' : kind === 'dead' ? 'pulse-dead' : 'pulse-connecting'}`;
  $('pulseLabel').textContent = label;
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

function initLiveWidget(): void {
  loadTradingView()
    .then(() => {
      const inst = current();
      tvWidget = new window.TradingView.widget({
        container_id: 'tv-live-chart',
        autosize: true,
        symbol: inst.tvLiveSymbol,
        interval: timeframe,
        timezone: 'Etc/UTC',
        theme: 'dark',
        style: chartType,
        locale: 'en',
        toolbar_bg: '#151921',
        enable_publishing: false,
        allow_symbol_change: false,
        withdateranges: true,
        fullscreen: true,
        studies: [],
        overrides: TV_OVERRIDES,
      });
      tvWidget.onChartReady(() => {
        tvChartApi = tvWidget.chart();
        setPulse('live', 'REAL-TIME STREAM ACTIVE');
        applyTvControls();
      });
    })
    .catch(() => {
      setPulse('dead', 'STREAM UNAVAILABLE');
      $('tvFallback').hidden = false;
    });
}

function applyTvControls(): void {
  if (!tvChartApi) return;
  try { tvChartApi.setChartType(chartType); } catch { /* ignore */ }
  try { tvChartApi.setResolution(timeframe); } catch { /* ignore */ }
}

function switchTvSymbol(symbol: string): void {
  if (!tvWidget) return;
  if (typeof tvWidget.setSymbol === 'function') {
    tvWidget.setSymbol(symbol);
  } else {
    // Older embed: recreate the widget with the new symbol.
    const inst = current();
    tvWidget = new window.TradingView.widget({
      container_id: 'tv-live-chart',
      autosize: true,
      symbol: inst.tvLiveSymbol,
      interval: timeframe,
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: chartType,
      locale: 'en',
      toolbar_bg: '#151921',
      enable_publishing: false,
      allow_symbol_change: false,
      withdateranges: true,
      fullscreen: true,
      studies: [],
      overrides: TV_OVERRIDES,
    });
    tvWidget.onChartReady(() => {
      tvChartApi = tvWidget.chart();
      applyTvControls();
    });
  }
}

/** Lazily created the first time tab 2 (TradingView COT & OI) is opened. */
function initCotWidget(): void {
  if (tvCotStarted) return;
  tvCotStarted = true;
  loadTradingView()
    .then(() => {
      const inst = current();
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
        allow_symbol_change: false,
        withdateranges: true,
        studies: [],
        overrides: TV_OVERRIDES,
      });
      tvCotWidget.onChartReady(() => {
        try { tvCotWidget.chart().createStudy('COT', false, false); } catch { /* optional study */ }
        try { tvCotWidget.chart().createStudy('OpenInterest@tv-basicstudies', false, false); } catch { /* optional study */ }
      });
    })
    .catch(() => { /* the CFTC tab remains authoritative */ });
}

/* ------------------------------------------------------------------ */
/* Lightweight Charts COT visualizer                                   */
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

function cotTimeData(series: CotSeriesRow[]): { time: string; value: number }[] {
  return series.map((r) => ({ time: r.date, value: r.commNet }));
}

function buildCotChart(inst: InstrumentState): void {
  if (cotLwChart) { cotLwChart.remove(); cotLwChart = null; }
  cotLwSeries = [];

  const el = $('cotChart');
  const chart = createChart(el, {
    autoSize: true,
    layout: LW_LAYOUT,
    grid: LW_GRID,
    rightPriceScale: { borderColor: '#262C36' },
    timeScale: { borderColor: '#262C36' },
    crosshair: { mode: CrosshairMode.Normal },
  });

  const series = inst.cot?.series ?? [];
  const legend = $('cotLegend');

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
          time: r.date,
          open: r.candle!.open,
          high: r.candle!.high,
          low: r.candle!.low,
          close: r.candle!.close,
        })),
    );
    cotLwSeries = [s];
    legend.innerHTML =
      '<span class="lg"><span class="sw" style="background:#3DD68C"></span>Commercial net weekly candle (open/close = net, range padded by |ΔOI|)</span>';
  } else if (cotMode === 'histo') {
    const s1 = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' } });
    s1.setData(
      series
        .filter((r) => r.commNetChange != null)
        .map((r) => ({
          time: r.date,
          value: r.commNetChange!,
          color: r.commNetChange! >= 0 ? 'rgba(61,214,140,0.85)' : 'rgba(224,101,107,0.85)',
        })),
    );
    const s2 = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' } });
    s2.setData(
      series
        .filter((r) => r.nonCommNetChange != null)
        .map((r) => ({
          time: r.date,
          value: r.nonCommNetChange!,
          color: r.nonCommNetChange! >= 0 ? 'rgba(201,162,75,0.8)' : 'rgba(201,162,75,0.35)',
        })),
    );
    cotLwSeries = [s1, s2];
    legend.innerHTML =
      '<span class="lg"><span class="sw" style="background:rgba(61,214,140,0.85)"></span>Commercial net change (w/w)</span>' +
      '<span class="lg"><span class="sw" style="background:rgba(201,162,75,0.8)"></span>Large speculator net change (w/w)</span>';
  } else {
    const s1 = chart.addSeries(LineSeries, { color: '#3DD68C', lineWidth: 2, priceLineVisible: false });
    s1.setData(series.map((r) => ({ time: r.date, value: r.commNet })));
    const s2 = chart.addSeries(LineSeries, { color: '#C9A24B', lineWidth: 2, priceLineVisible: false });
    s2.setData(series.map((r) => ({ time: r.date, value: r.nonCommNet })));
    const s3 = chart.addSeries(LineSeries, {
      color: '#5A6270',
      lineWidth: 1,
      priceLineVisible: false,
      priceScaleId: 'right',
    });
    s3.setData(series.map((r) => ({ time: r.date, value: r.oi })));
    chart.priceScale('right').applyOptions({ visible: true });
    cotLwSeries = [s1, s2, s3];
    legend.innerHTML =
      '<span class="lg"><span class="sw" style="background:#3DD68C"></span>Commercial net</span>' +
      '<span class="lg"><span class="sw" style="background:#C9A24B"></span>Large speculator net</span>' +
      '<span class="lg"><span class="sw" style="background:#5A6270"></span>Open interest (right scale)</span>';
  }

  if (series.length) chart.timeScale().fitContent();
  cotLwChart = chart;
}

/** Silent in-place update: re-feed series data without rebuilding the chart. */
function updateCotChartData(inst: InstrumentState): void {
  if (!cotLwChart) return;
  const series = inst.cot?.series ?? [];
  if (cotMode === 'candles') {
    (cotLwSeries[0] as ISeriesApi<'Candlestick'>).setData(
      series
        .filter((r) => r.candle)
        .map((r) => ({
          time: r.date,
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
          time: r.date,
          value: r.commNetChange!,
          color: r.commNetChange! >= 0 ? 'rgba(61,214,140,0.85)' : 'rgba(224,101,107,0.85)',
        })),
    );
    (cotLwSeries[1] as ISeriesApi<'Histogram'>).setData(
      series
        .filter((r) => r.nonCommNetChange != null)
        .map((r) => ({
          time: r.date,
          value: r.nonCommNetChange!,
          color: r.nonCommNetChange! >= 0 ? 'rgba(201,162,75,0.8)' : 'rgba(201,162,75,0.35)',
        })),
    );
  } else {
    (cotLwSeries[0] as ISeriesApi<'Line'>).setData(series.map((r) => ({ time: r.date, value: r.commNet })));
    (cotLwSeries[1] as ISeriesApi<'Line'>).setData(series.map((r) => ({ time: r.date, value: r.nonCommNet })));
    (cotLwSeries[2] as ISeriesApi<'Line'>).setData(series.map((r) => ({ time: r.date, value: r.oi })));
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderPills(): void {
  if (!state) return;
  const wrap = $('assetPills');
  wrap.innerHTML = state.instruments
    .map(
      (i) =>
        `<button type="button" role="tab" aria-selected="${i.id === activeId}" class="asset-pill${i.id === activeId ? ' active' : ''}" data-asset="${i.id}">${i.displayName}</button>`,
    )
    .join('');
  wrap.querySelectorAll<HTMLButtonElement>('.asset-pill').forEach((b) => {
    b.addEventListener('click', () => switchInstrument(b.dataset.asset ?? 'gold'));
  });
}

function renderSyncBadge(): void {
  if (!state) return;
  const { cftc, volumeOi, bootstrap } = state.sync;
  const parts: string[] = [];
  parts.push(
    cftc.latestReportDate
      ? `CFTC report ${cftc.latestReportDate} · synced ${fmtTime(cftc.lastSuccessAt)}`
      : 'CFTC: initial bootstrap in progress…',
  );
  parts.push(volumeOi.ok ? `Futures Vol/OI ${fmtTime(volumeOi.lastSuccessAt)}` : 'Futures Vol/OI: pending');
  if (!cftc.ok || !volumeOi.ok) parts.push('⚠ partial — retrying automatically');
  $('syncBadge').textContent = `Last automated CFTC & CME sync — ${parts.join(' · ')}${bootstrap.ranAt ? ' · next check: 60s' : ''}`;
}

function renderKpis(inst: InstrumentState): void {
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
      <div class="kpi-delta">Participation ${k.institutionalRatio != null ? (k.institutionalRatio * 100).toFixed(1) + '%' : '—'} of OI · vol Δ ${fmtSigned(k.dailyVolumeDelta)}</div>
      <div class="kpi-src">Yahoo v8 daily tape · ${inst.market ? fmtTime(inst.market.updatedAt) : '—'}</div>
    </div>`,
  ];
  $('kpiGrid').innerHTML = cards.join('');
}

function renderBreakdown(inst: InstrumentState): void {
  const snap = inst.cot?.snapshot;
  const title = $('bdTitle');
  const table = $('cotBreakdown');
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
  const cot = inst.cot;
  $('hubMeta').textContent = cot
    ? `CFTC ${cot.reportDate ?? '—'} · ${cot.series.length} weekly observations · ${inst.displayName}`
    : 'CFTC: awaiting bootstrap…';
}

function renderFinviz(inst: InstrumentState, bust: number): void {
  const main = $('finvizMain') as HTMLImageElement;
  const fallback = $('finvizFallback');
  main.src = `/api/finviz?code=${inst.finvizCode}&p=w1&t=${bust}`;
  main.onload = () => { main.style.display = ''; fallback.hidden = true; };
  main.onerror = () => { main.style.display = 'none'; fallback.hidden = false; };

  // Cross-asset comparison strip (unique Finviz codes).
  const seen = new Set<string>();
  const uniq: InstrumentState[] = [];
  for (const i of state!.instruments) {
    if (!seen.has(i.finvizCode)) { seen.add(i.finvizCode); uniq.push(i); }
  }
  $('finvizCompare').innerHTML = uniq
    .map(
      (i) => `<div class="finviz-thumb" data-thumb="${i.finvizCode}">
        <span class="thumb-label">${i.finvizCode}</span>
        <img src="/api/finviz?code=${i.finvizCode}&p=w1&t=${bust}" alt="Finviz COT ${i.finvizCode}" loading="lazy" />
      </div>`,
    )
    .join('');
}

function renderInstrument(inst: InstrumentState, bust: number): void {
  $('liveSymbolLabel').textContent = `${inst.tvLiveSymbol} — ${inst.displayName}`;
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
  const inst = current();
  renderInstrument(inst, Date.now());
  switchTvSymbol(inst.tvLiveSymbol);
  if (tvCotWidget && typeof tvCotWidget.setSymbol === 'function') {
    tvCotWidget.setSymbol(inst.tvFuturesSymbol);
  }
}

/* ------------------------------------------------------------------ */
/* Polling (60-second silent auto-sync, cache-busted)                  */
/* ------------------------------------------------------------------ */

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const res = await fetch(`/api/terminal/state?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = (await res.json()) as TerminalState;
    const first = !state;
    state = next;
    if (first) {
      renderPills();
      renderInstrument(current(), Date.now());
      renderSyncBadge();
    } else {
      // Silent in-place refresh: KPIs, chart data, badges, images.
      renderSyncBadge();
      renderKpis(current());
      updateCotChartData(current());
      renderBreakdown(current());
      renderHubMeta(current());
      const bust = Date.now();
      (($('finvizMain') as HTMLImageElement)).src = `/api/finviz?code=${current().finvizCode}&p=w1&t=${bust}`;
      document.querySelectorAll<HTMLImageElement>('#finvizCompare img').forEach((img) => {
        img.src = `${img.src.split('&t=')[0]}&t=${bust}`;
      });
    }
  } catch {
    // Keep the last known state; the next cycle retries automatically.
    if (!state) $('syncBadge').textContent = 'Backend not reachable yet — automated retry in 60s…';
  } finally {
    polling = false;
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

export function initTerminal(): void {
  // Chart-type / timeframe controls (live TV panel).
  $('chartTypeBtns').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.addEventListener('click', () => {
      chartType = b.dataset.type ?? '1';
      document.querySelectorAll('#chartTypeBtns button').forEach((x) => x.classList.toggle('active', x === b));
      if (tvChartApi) { try { tvChartApi.setChartType(chartType); } catch { /* ignore */ } }
    });
  });
  $('timeframeBtns').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.addEventListener('click', () => {
      timeframe = b.dataset.tf ?? '15';
      document.querySelectorAll('#timeframeBtns button').forEach((x) => x.classList.toggle('active', x === b));
      if (tvChartApi) { try { tvChartApi.setResolution(timeframe); } catch { /* ignore */ } }
    });
  });

  // COT render-mode switcher.
  $('cotModeBtns').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.addEventListener('click', () => {
      cotMode = (b.dataset.mode ?? 'candles') as 'candles' | 'histo' | 'line';
      document.querySelectorAll('#cotModeBtns button').forEach((x) => x.classList.toggle('active', x === b));
      if (state) buildCotChart(current());
    });
  });

  // Hub tabs.
  $('hubTabs').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.addEventListener('click', () => {
      const tab = b.dataset.tab ?? 'cftc';
      document.querySelectorAll('#hubTabs button').forEach((x) => {
        const active = x === b;
        x.classList.toggle('active', active);
        x.setAttribute('aria-selected', String(active));
      });
      (['cftc', 'tvcot', 'finviz'] as const).forEach((t) => {
        $('tab-' + t).hidden = t !== tab;
      });
      if (tab === 'tvcot') initCotWidget();
    });
  });

  // Live stream + automated state polling. No manual refresh anywhere.
  initLiveWidget();
  void poll();
  setInterval(() => void poll(), POLL_INTERVAL_MS);
}
