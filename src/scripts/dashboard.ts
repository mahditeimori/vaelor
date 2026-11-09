import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';
import {
  BUNDLES,
  aggregate,
  compositeFlag,
  CURRENT_REGIME,
  type SeriesBundle,
  type TfId,
} from './mockData.ts';

let priceChart: IChartApi | null = null;
let oiChart: IChartApi | null = null;
let cotChart: IChartApi | null = null;
let candle: ISeriesApi<'Candlestick'> | null = null;
let volSeries: ISeriesApi<'Histogram'> | null = null;
let oiSeries: ISeriesApi<'Line'> | null = null;
let cotHist: ISeriesApi<'Histogram'> | null = null;
let cotZ: ISeriesApi<'Line'> | null = null;

let currentSymbol = 'GC';
let currentTf: TfId = 'D';

const el = (id: string) => document.getElementById(id);

function chartTheme(base: Record<string, unknown> = {}) {
  return {
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: '#9aa7bd',
      fontSize: 11,
      fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
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
    ...base,
  };
}

function resolveSymbol(input: string): string | null {
  const q = input.trim().toLowerCase().replace(/\s+/g, ' ');
  const gc = ['gc', 'gold', 'gold futures', 'xau', 'xauusd', 'gold futures (gc)', 'gcf'];
  const dx = ['dx', 'dxy', 'usd index', 'usdx', 'us dollar index', 'dx futures', 'dollar index'];
  if (gc.includes(q)) return 'GC';
  if (dx.includes(q)) return 'DX';
  return null;
}

function buildPriceChart(container: HTMLDivElement): IChartApi {
  return createChart(container, chartTheme({ height: 420 })) as IChartApi;
}

function buildOiChart(container: HTMLDivElement): IChartApi {
  return createChart(container, chartTheme({ height: 220 })) as IChartApi;
}

function buildCotChart(container: HTMLDivElement): IChartApi {
  return createChart(container, chartTheme({ height: 240 })) as IChartApi;
}

function setUpVolumeScales(chart: IChartApi) {
  chart.priceScale('volume').applyOptions({
    scaleMargins: { top: 0.82, bottom: 0 },
  });
}

function renderPrice(bundle: SeriesBundle, tf: TfId) {
  if (!priceChart) return;
  const agg = aggregate(bundle, tf);
  if (!candle) {
    candle = priceChart.addSeries(CandlestickSeries, {
      upColor: '#34d399',
      downColor: '#f87171',
      borderUpColor: '#34d399',
      borderDownColor: '#f87171',
      wickUpColor: '#34d399',
      wickDownColor: '#f87171',
    });
    volSeries = priceChart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    setUpVolumeScales(priceChart);
  }
  candle.setData(agg.ohlc.map((b) => ({ time: b.time as Time, ...b })));
  volSeries!.setData(
    agg.volume.map((v) => {
      const day = bundle.ohlc.find((x) => x.time === v.time);
      return {
        time: v.time as Time,
        value: v.value,
        color: day && day.close >= day.open ? 'rgba(52,211,153,0.4)' : 'rgba(248,113,113,0.4)',
      };
    }),
  );
  priceChart.timeScale().fitContent();
}

function renderOi(bundle: SeriesBundle, tf: TfId) {
  if (!oiChart) return;
  const agg = aggregate(bundle, tf);
  if (!oiSeries) {
    oiSeries = oiChart.addSeries(LineSeries, {
      color: '#5eead4',
      lineWidth: 2,
      priceFormat: { type: 'volume' },
    });
  }
  oiSeries.setData(agg.oi.map((p) => ({ time: p.time as Time, value: p.value })));
  const markers = [];
  for (let i = 1; i < agg.oi.length; i++) {
    const prev = agg.oi[i - 1].value;
    const cur = agg.oi[i].value;
    const pct = ((cur - prev) / prev) * 100;
    if (Math.abs(pct) >= 5) {
      markers.push({
        time: agg.oi[i].time as Time,
        position: pct > 0 ? 'aboveBar' : 'belowBar',
        color: pct > 0 ? '#fbbf24' : '#f87171',
        shape: pct > 0 ? 'arrowUp' : 'arrowDown',
        text: `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`,
      });
    }
  }
  oiSeries.setMarkers(markers as never);
  oiChart.timeScale().fitContent();
}

function renderCot(bundle: SeriesBundle) {
  if (!cotChart) return;
  if (!cotHist) {
    cotHist = cotChart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
    });
  }
  cotHist.setData(
    bundle.cot.map((p) => ({
      time: p.time as Time,
      value: p.value,
      color: p.value >= 0 ? 'rgba(52,211,153,0.7)' : 'rgba(248,113,113,0.7)',
    })),
  );
  if (!cotZ) {
    cotZ = cotChart.addSeries(LineSeries, {
      color: '#fbbf24',
      lineWidth: 2,
      priceScaleId: 'z',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    const zScale = cotChart.priceScale('z');
    zScale.applyOptions({ scaleMargins: { top: 0.05, bottom: 0.42 } });
    zScale.applyOptions({ borderColor: 'rgba(251,191,36,0.4)' });
    cotZ.createPriceLine({
      price: 2.0,
      color: 'rgba(251,191,36,0.55)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Z +2.0',
    });
    cotZ.createPriceLine({
      price: -2.0,
      color: 'rgba(251,191,36,0.55)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Z −2.0',
    });
  }
  cotZ.setData(bundle.cot.map((p) => ({ time: p.time as Time, value: p.z })));
  cotChart.timeScale().fitContent();
}

function updateComposite(bundle: SeriesBundle) {
  const c = compositeFlag(bundle);
  const stateLabel = el('stateLabel');
  const stateDetail = el('stateDetail');
  const zScore = el('zScore');
  const flipDist = el('flipDist');
  const compFlag = el('compFlag');
  if (stateLabel) {
    stateLabel.textContent = c.fourState.state;
    stateLabel.className = `v ${c.fourState.cls}`;
  }
  if (stateDetail) stateDetail.textContent = c.fourState.label;
  if (zScore) {
    zScore.textContent = `${c.z >= 0 ? '+' : ''}${c.z.toFixed(2)}`;
    zScore.className = `v mono ${Math.abs(c.z) >= 2 ? (c.z > 0 ? 'state-up' : 'state-down') : ''}`;
  }
  if (flipDist) {
    flipDist.textContent = `${c.distBp >= 0 ? '+' : ''}${c.distBp.toFixed(0)} bp`;
    flipDist.className = 'v';
  }
  if (compFlag) {
    compFlag.textContent = c.flag;
    compFlag.className = `v flag-${c.flag.toLowerCase()}`;
  }
}

function attachResize(target: HTMLElement, chart: IChartApi | null) {
  if (!chart) return;
  const ro = new ResizeObserver(() => chart.resize(target.clientWidth, target.clientHeight || 420));
  ro.observe(target);
}

function renderAll(symbol: string, tf: TfId) {
  const bundle = BUNDLES[symbol];
  if (!bundle) return;
  renderPrice(bundle, tf);
  renderOi(bundle, tf);
  renderCot(bundle);
  updateComposite(bundle);
  const note = el('resolveNote');
  if (note) note.textContent = `${bundle.symbol} → ${bundle.name}`;
}

function init() {
  const priceEl = el('priceChart') as HTMLDivElement | null;
  const oiEl = el('oiChart') as HTMLDivElement | null;
  const cotEl = el('cotChart') as HTMLDivElement | null;
  if (!priceEl || !oiEl || !cotEl) return;

  priceChart = buildPriceChart(priceEl);
  oiChart = buildOiChart(oiEl);
  cotChart = buildCotChart(cotEl);
  attachResize(priceEl, priceChart);
  attachResize(oiEl, oiChart);
  attachResize(cotEl, cotChart);

  renderAll(currentSymbol, currentTf);

  const search = el('symbolSearch') as HTMLInputElement | null;
  const go = el('symbolGo');
  const doSearch = () => {
    if (!search) return;
    const resolved = resolveSymbol(search.value);
    if (!resolved) {
      search.style.borderColor = '#f87171';
      return;
    }
    search.style.borderColor = '';
    currentSymbol = resolved;
    renderAll(currentSymbol, currentTf);
  };
  go?.addEventListener('click', doSearch);
  search?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  const toggle = el('tfToggle');
  toggle?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-tf]');
    if (!btn) return;
    toggle.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    (btn as HTMLButtonElement).classList.add('active');
    currentTf = (btn as HTMLButtonElement).dataset.tf as TfId;
    renderAll(currentSymbol, currentTf);
  });

  const chip = el('regimeChip');
  if (chip) chip.textContent = `REGIME: ${CURRENT_REGIME.toUpperCase()}`;
  const regimeValue = el('regimeValue');
  if (regimeValue) regimeValue.textContent = CURRENT_REGIME;
}

export function mountDashboard() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}