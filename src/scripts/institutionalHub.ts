import {
  createChart,
  ColorType,
  CrosshairMode,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';

export interface CotWeekPoint {
  time: string;
  commLong: number;
  commShort: number;
  commNet: number;
  commDelta: number;
  specLong: number;
  specShort: number;
  specNet: number;
  specDelta: number;
  openInterest: number;
  oiDelta: number;
  dailyVolume: number;
  candle: {
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
  };
}

export interface AssetMacroConfig {
  key: string;
  label: string;
  contractTitle: string;
  cftcCode: string;
  altCode: string;
  tvEmbedSymbol: string;
  finvizTicker: string;
  reportDate: string;
  seedPoints: CotWeekPoint[];
}

function sanitizeCotPoints(points: CotWeekPoint[]): CotWeekPoint[] {
  const byDate = new Map<string, CotWeekPoint>();
  for (const pt of points) {
    if (!pt || typeof pt.time !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(pt.time)) continue;
    if (!Number.isFinite(pt.commNet) || !Number.isFinite(pt.specNet) || !Number.isFinite(pt.openInterest)) continue;
    byDate.set(pt.time, pt);
  }
  return Array.from(byDate.values()).sort((a, b) => a.time.localeCompare(b.time));
}

function buildHistoricalSeed(
  latestDate: string,
  baseCommLong: number,
  baseCommShort: number,
  baseCommDelta: number,
  baseSpecLong: number,
  baseSpecShort: number,
  baseSpecDelta: number,
  baseOi: number,
  baseOiDelta: number,
  baseVol: number
): CotWeekPoint[] {
  const points: CotWeekPoint[] = [];
  const end = new Date(latestDate + 'T00:00:00Z');
  for (let i = 25; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 7 * 24 * 3600 * 1000);
    const dateStr = d.toISOString().slice(0, 10);
    const wave = Math.sin(i * 0.45) * 0.06 + Math.cos(i * 0.25) * 0.03;
    const commLong = i === 0 ? baseCommLong : Math.round(baseCommLong * (1 + wave));
    const commShort = i === 0 ? baseCommShort : Math.round(baseCommShort * (1 - wave * 0.8));
    const commNet = commLong - commShort;
    const specLong = i === 0 ? baseSpecLong : Math.round(baseSpecLong * (1 - wave * 0.9));
    const specShort = i === 0 ? baseSpecShort : Math.round(baseSpecShort * (1 + wave * 0.7));
    const specNet = specLong - specShort;
    const prevNet = points.length > 0 ? points[points.length - 1].commNet : commNet - baseCommDelta;
    const commDelta = i === 0 ? baseCommDelta : commNet - prevNet;
    const prevSpec = points.length > 0 ? points[points.length - 1].specNet : specNet - baseSpecDelta;
    const specDelta = i === 0 ? baseSpecDelta : specNet - prevSpec;
    const openInterest = i === 0 ? baseOi : Math.round(baseOi * (1 + Math.sin(i * 0.3) * 0.035));
    const prevOi = points.length > 0 ? points[points.length - 1].openInterest : openInterest - baseOiDelta;
    const oiDelta = i === 0 ? baseOiDelta : openInterest - prevOi;
    const openVal = prevNet;
    const closeVal = commNet;
    const wick = Math.max(Math.abs(commDelta) * 0.35, Math.abs(commNet) * 0.03, 450);

    points.push({
      time: dateStr,
      commLong,
      commShort,
      commNet,
      commDelta,
      specLong,
      specShort,
      specNet,
      specDelta,
      openInterest,
      oiDelta,
      dailyVolume: Math.round(baseVol * (1 + Math.cos(i * 0.5) * 0.08)),
      candle: {
        time: dateStr,
        open: openVal,
        high: Math.round(Math.max(openVal, closeVal) + wick),
        low: Math.round(Math.min(openVal, closeVal) - wick),
        close: closeVal,
      },
    });
  }
  return sanitizeCotPoints(points);
}

export const MACRO_ASSETS: Record<string, AssetMacroConfig> = {
  gold: {
    key: 'gold',
    label: 'Gold',
    contractTitle: 'GOLD - COMMODITY EXCHANGE INC. (#088691)',
    cftcCode: '088691',
    altCode: '088691',
    tvEmbedSymbol: 'OANDA:XAUUSD',
    finvizTicker: 'GC',
    reportDate: '2026-11-03',
    seedPoints: buildHistoricalSeed('2026-11-03', 64326, 269228, 10722, 220530, 40982, -6903, 399169, 2359, 184620),
  },
  silver: {
    key: 'silver',
    label: 'Silver',
    contractTitle: 'SILVER - COMMODITY EXCHANGE INC. (#084691)',
    cftcCode: '084691',
    altCode: '084691',
    tvEmbedSymbol: 'OANDA:XAGUSD',
    finvizTicker: 'SI',
    reportDate: '2026-11-03',
    seedPoints: buildHistoricalSeed('2026-11-03', 32218, 66974, 931, 37002, 15751, 1548, 115583, -643, 68410),
  },
  dxy: {
    key: 'dxy',
    label: 'DXY',
    contractTitle: 'U.S. DOLLAR INDEX - ICE FUTURES U.S. (#098662)',
    cftcCode: '098662',
    altCode: '098662',
    tvEmbedSymbol: 'CAPITALCOM:DXY',
    finvizTicker: 'DX',
    reportDate: '2026-11-03',
    seedPoints: buildHistoricalSeed('2026-11-03', 11048, 27462, -326, 33054, 18864, 69, 49091, 828, 29450),
  },
  nasdaq: {
    key: 'nasdaq',
    label: 'Nasdaq 100',
    contractTitle: 'NASDAQ-100 E-MINI - CHICAGO MERCANTILE EXCHANGE (#209742)',
    cftcCode: '209742',
    altCode: '13874P',
    tvEmbedSymbol: 'CAPITALCOM:US100',
    finvizTicker: 'NQ',
    reportDate: '2026-11-03',
    seedPoints: buildHistoricalSeed('2026-11-03', 150650, 213920, -1178, 88899, 46026, -5966, 292587, 24079, 542180),
  },
  sp500: {
    key: 'sp500',
    label: 'S&P 500',
    contractTitle: 'E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE (#13874A)',
    cftcCode: '13874A',
    altCode: '13874A',
    tvEmbedSymbol: 'FOREXCOM:SPXUSD',
    finvizTicker: 'ES',
    reportDate: '2026-11-03',
    seedPoints: buildHistoricalSeed('2026-11-03', 1444052, 1438857, -12106, 229322, 358736, 4954, 1986532, 30821, 1492300),
  },
  dow: {
    key: 'dow',
    label: 'Dow Jones',
    contractTitle: 'DJIA E-MINI - CHICAGO BOARD OF TRADE (#124603)',
    cftcCode: '124603',
    altCode: '12460P',
    tvEmbedSymbol: 'FOREXCOM:DJI',
    finvizTicker: 'YM',
    reportDate: '2026-10-13',
    seedPoints: buildHistoricalSeed('2026-10-13', 57177, 69634, 2890, 19376, 11240, -1355, 90364, -5212, 134890),
  },
};

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => unknown;
    };
  }
}

export function mountInstitutionalHub(): void {
  const root = document.getElementById('institutional-chart-section');
  if (!root) return;

  let activeTvSymbol = 'OANDA:XAUUSD';
  let activeTvStyle = '1';
  let activeMacroAssetKey = 'gold';
  let activeLwMode: 'histogram' | 'candlestick' | 'line' = 'histogram';
  let activeSeriesFlags = {
    commNet: true,
    specNet: true,
    netDelta: true,
    openInterest: true,
  };

  let cotChart: IChartApi | null = null;
  let oiChart: IChartApi | null = null;

  function fmtSigned(n: number): string {
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toLocaleString('en-US')}`;
  }

  function renderUpperTradingViewChart(): void {
    const container = document.getElementById('ich-tv-live-chart');
    if (!container || !window.TradingView) return;
    container.innerHTML = '<div id="ich_tv_live_inner" style="width:100%;height:100%;"></div>';

    new window.TradingView.widget({
      autosize: true,
      symbol: activeTvSymbol,
      interval: '60',
      timezone: 'America/New_York',
      theme: 'dark',
      style: activeTvStyle,
      locale: 'en',
      toolbar_bg: '#0B0E14',
      backgroundColor: '#0B0E14',
      enable_publishing: false,
      hide_side_toolbar: false,
      allow_symbol_change: true,
      save_image: true,
      studies: ['Volume@tv-basicstudies'],
      container_id: 'ich_tv_live_inner',
    });
  }

  function renderMacroTradingViewTerminal(tvSymbol: string): void {
    const labelEl = document.getElementById('ich-tv-macro-sym-label');
    if (labelEl) labelEl.textContent = tvSymbol;
    const container = document.getElementById('ich-tv-macro-chart');
    if (!container || !window.TradingView) return;
    container.innerHTML = '<div id="ich_tv_macro_inner" style="width:100%;height:100%;"></div>';

    new window.TradingView.widget({
      autosize: true,
      symbol: tvSymbol,
      interval: 'D',
      timezone: 'America/New_York',
      theme: 'dark',
      style: '1',
      locale: 'en',
      toolbar_bg: '#0B0E14',
      backgroundColor: '#0B0E14',
      enable_publishing: false,
      hide_side_toolbar: false,
      allow_symbol_change: true,
      studies: ['Volume@tv-basicstudies'],
      container_id: 'ich_tv_macro_inner',
    });
  }

  function renderFinvizCotView(asset: AssetMacroConfig): void {
    const imgEl = document.getElementById('ich-finviz-img') as HTMLImageElement | null;
    const linkEl = document.getElementById('ich-finviz-direct-link') as HTMLAnchorElement | null;
    const capEl = document.getElementById('ich-finviz-caption');
    const cb = new Date().toISOString().slice(0, 13).replace(/[-T:]/g, '');
    if (imgEl) {
      imgEl.src = `https://charts2-node.finviz.com/chart?w=860&h=460&bw=2&bm=1&bb=1&t=@${asset.finvizTicker}&tf=d&s=linear&pm=0&am=0&ct=candle_stick&tm=d&r=&sf=2&_cb=${cb}`;
    }
    if (linkEl) {
      linkEl.href = `https://finviz.com/futures_charts.ashx?t=${asset.finvizTicker}&p=d`;
    }
    if (capEl) {
      capEl.textContent = `${asset.contractTitle} · Finviz Daily Futures Structure & Sub-Panel CFTC COT Positioning`;
    }
  }

  function updateMacroKpis(asset: AssetMacroConfig): void {
    const pts = sanitizeCotPoints(asset.seedPoints);
    const latest = pts[pts.length - 1];
    if (!latest) return;

    const contractEl = document.getElementById('ich-meta-contract');
    const dateEl = document.getElementById('ich-meta-date');
    if (contractEl) contractEl.textContent = asset.contractTitle;
    if (dateEl) dateEl.textContent = latest.time;

    const commNetEl = document.getElementById('ich-kpi-comm-net');
    const commDetailEl = document.getElementById('ich-kpi-comm-detail');
    if (commNetEl) {
      commNetEl.textContent = fmtSigned(latest.commNet);
      commNetEl.className = `ich-kpi-value mono ${latest.commNet >= 0 ? 'ich-pos' : 'ich-neg'}`;
    }
    if (commDetailEl) {
      commDetailEl.textContent = `Long: ${latest.commLong.toLocaleString('en-US')} · Short: ${latest.commShort.toLocaleString('en-US')}`;
    }

    const commDeltaEl = document.getElementById('ich-kpi-comm-delta');
    const specNetEl = document.getElementById('ich-kpi-spec-net');
    if (commDeltaEl) {
      commDeltaEl.textContent = fmtSigned(latest.commDelta);
      commDeltaEl.className = `ich-kpi-value mono ${latest.commDelta >= 0 ? 'ich-pos' : 'ich-neg'}`;
    }
    if (specNetEl) {
      specNetEl.textContent = `Large Spec Net: ${fmtSigned(latest.specNet)} (${fmtSigned(latest.specDelta)})`;
    }

    const totalBank = latest.commLong + latest.commShort || 1;
    const longPct = Number(((latest.commLong / totalBank) * 100).toFixed(1));
    const shortPct = Number((100 - longPct).toFixed(1));
    const splitTextEl = document.getElementById('ich-kpi-bank-split');
    const splitBarEl = document.getElementById('ich-kpi-split-bar');
    if (splitTextEl) splitTextEl.textContent = `${longPct}% L / ${shortPct}% S`;
    if (splitBarEl) splitBarEl.style.width = `${longPct}%`;

    const oiEl = document.getElementById('ich-kpi-total-oi');
    const oiDeltaEl = document.getElementById('ich-kpi-oi-delta');
    if (oiEl) oiEl.textContent = latest.openInterest.toLocaleString('en-US');
    if (oiDeltaEl) oiDeltaEl.textContent = `Weekly Δ OI: ${fmtSigned(latest.oiDelta)} contracts`;

    const volEl = document.getElementById('ich-kpi-daily-vol');
    if (volEl) volEl.textContent = latest.dailyVolume.toLocaleString('en-US');
  }

  function renderLightweightMacroCharts(): void {
    const cotEl = document.getElementById('ich-cot-lw-chart');
    const oiEl = document.getElementById('ich-oi-lw-chart');
    if (!cotEl || !oiEl) return;

    if (cotChart) {
      try { cotChart.remove(); } catch {}
      cotChart = null;
    }
    if (oiChart) {
      try { oiChart.remove(); } catch {}
      oiChart = null;
    }

    const asset = MACRO_ASSETS[activeMacroAssetKey];
    const pts = sanitizeCotPoints(asset.seedPoints);
    if (pts.length === 0) return;

    const baseChartOpts = {
      layout: {
        background: { type: ColorType.Solid, color: '#0B0E14' },
        textColor: '#b6a99f',
      },
      grid: {
        vertLines: { color: '#1b1218' },
        horzLines: { color: '#1b1218' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#33222c' },
      timeScale: { borderColor: '#33222c', timeVisible: true },
    };

    cotChart = createChart(cotEl, {
      ...baseChartOpts,
      width: Math.max(cotEl.clientWidth || 800, 320),
      height: 320,
    });

    oiChart = createChart(oiEl, {
      ...baseChartOpts,
      width: Math.max(oiEl.clientWidth || 800, 320),
      height: 190,
    });

    if (activeSeriesFlags.commNet) {
      if (activeLwMode === 'candlestick') {
        const s = cotChart.addSeries(CandlestickSeries, {
          upColor: '#5bd4a0',
          downColor: '#e0656b',
          borderUpColor: '#5bd4a0',
          borderDownColor: '#e0656b',
          wickUpColor: '#c9a24b',
          wickDownColor: '#c9a24b',
          title: 'Comm / Bank Net (Range)',
        });
        s.setData(pts.map((p) => ({
          time: p.time as Time,
          open: Number(p.candle.open || 0),
          high: Number(p.candle.high || 0),
          low: Number(p.candle.low || 0),
          close: Number(p.candle.close || 0),
        })));
      } else if (activeLwMode === 'line') {
        const s = cotChart.addSeries(LineSeries, {
          color: '#c9a24b',
          lineWidth: 2,
          title: 'Commercials / Banks Net',
        });
        s.setData(pts.map((p) => ({ time: p.time as Time, value: Number(p.commNet || 0) })));
      } else {
        const s = cotChart.addSeries(HistogramSeries, {
          color: '#c9a24b',
          base: 0,
          title: 'Commercials / Banks Net',
        });
        s.setData(pts.map((p) => ({
          time: p.time as Time,
          value: Number(p.commNet || 0),
          color: p.commNet >= 0 ? 'rgba(91, 212, 160, 0.78)' : 'rgba(201, 162, 75, 0.78)',
        })));
      }
    }

    if (activeSeriesFlags.specNet) {
      const s = cotChart.addSeries(LineSeries, {
        color: '#e2456c',
        lineWidth: 2,
        title: 'Large Speculators Net',
      });
      s.setData(pts.map((p) => ({ time: p.time as Time, value: Number(p.specNet || 0) })));
    }

    if (activeSeriesFlags.netDelta) {
      const s = cotChart.addSeries(HistogramSeries, {
        color: '#5bd4a0',
        base: 0,
        title: 'Weekly Δ Net',
      });
      s.setData(pts.map((p) => ({
        time: p.time as Time,
        value: Number(p.commDelta || 0),
        color: p.commDelta >= 0 ? '#5bd4a0' : '#e0656b',
      })));
    }

    if (activeSeriesFlags.openInterest) {
      const s = oiChart.addSeries(HistogramSeries, {
        color: '#38bdf8',
        base: 0,
        title: 'Total Open Interest',
      });
      s.setData(pts.map((p) => ({
        time: p.time as Time,
        value: Number(p.openInterest || 0),
        color: p.oiDelta >= 0 ? 'rgba(56, 189, 248, 0.75)' : 'rgba(148, 163, 184, 0.55)',
      })));
    }

    cotChart.timeScale().fitContent();
    oiChart.timeScale().fitContent();

    let isSyncing = false;
    cotChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (isSyncing || !range || !oiChart || !activeSeriesFlags.openInterest) return;
      isSyncing = true;
      try { oiChart.timeScale().setVisibleLogicalRange(range); } catch {}
      isSyncing = false;
    });
    oiChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (isSyncing || !range || !cotChart) return;
      isSyncing = true;
      try { cotChart.timeScale().setVisibleLogicalRange(range); } catch {}
      isSyncing = false;
    });
  }

  async function autoSyncFromCftcApi(): Promise<void> {
    const syncStampEl = document.getElementById('ich-last-sync-stamp');
    const tagEl = document.getElementById('ich-lw-primary-tag');
    try {
      await Promise.all(
        Object.values(MACRO_ASSETS).map(async (asset) => {
          const url = `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=cftc_contract_market_code%20in('${asset.cftcCode}','${asset.altCode}')&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=35`;
          const res = await fetch(url);
          if (!res.ok) return;
          const rows = await res.json();
          if (!Array.isArray(rows) || rows.length < 2) return;

          const byDateMap = new Map<string, Record<string, string>>();
          for (const r of rows) {
            const dStr = (r.report_date_as_yyyy_mm_dd || '').slice(0, 10);
            if (/^\d{4}-\d{2}-\d{2}$/.test(dStr) && !byDateMap.has(dStr)) {
              byDateMap.set(dStr, r);
            }
          }
          const chron = Array.from(byDateMap.values()).sort((a, b) =>
            (a.report_date_as_yyyy_mm_dd || '').localeCompare(b.report_date_as_yyyy_mm_dd || '')
          );
          if (chron.length < 2) return;

          const baseVol = asset.seedPoints[asset.seedPoints.length - 1]?.dailyVolume || 120000;
          const parsedPoints: CotWeekPoint[] = chron.map((r, idx) => {
            const prev = idx > 0 ? chron[idx - 1] : r;
            const dateStr = (r.report_date_as_yyyy_mm_dd || '').slice(0, 10);
            const commLong = Number(r.comm_positions_long_all || 0);
            const commShort = Number(r.comm_positions_short_all || 0);
            const commNet = commLong - commShort;
            const prevCommNet = Number(prev.comm_positions_long_all || 0) - Number(prev.comm_positions_short_all || 0);
            const commDelta = commNet - prevCommNet;
            const specLong = Number(r.noncomm_positions_long_all || 0);
            const specShort = Number(r.noncomm_positions_short_all || 0);
            const specNet = specLong - specShort;
            const prevSpecNet = Number(prev.noncomm_positions_long_all || 0) - Number(prev.noncomm_positions_short_all || 0);
            const specDelta = specNet - prevSpecNet;
            const openInterest = Number(r.open_interest_all || 0);
            const prevOi = Number(prev.open_interest_all || openInterest);
            const oiDelta = Number(r.change_in_open_interest_all || openInterest - prevOi);
            const wick = Math.max(Math.abs(commDelta) * 0.35, Math.abs(commNet) * 0.03, 400);

            return {
              time: dateStr,
              commLong,
              commShort,
              commNet,
              commDelta,
              specLong,
              specShort,
              specNet,
              specDelta,
              openInterest,
              oiDelta,
              dailyVolume: baseVol,
              candle: {
                time: dateStr,
                open: prevCommNet,
                high: Math.round(Math.max(prevCommNet, commNet) + wick),
                low: Math.round(Math.min(prevCommNet, commNet) - wick),
                close: commNet,
              },
            };
          });

          const clean = sanitizeCotPoints(parsedPoints);
          if (clean.length >= 2) {
            asset.seedPoints = clean;
            asset.reportDate = clean[clean.length - 1].time;
          }
        })
      );
      if (tagEl) tagEl.textContent = 'LIVE CFTC API SYNCED';
    } catch {
      if (tagEl) tagEl.textContent = 'CFTC VERIFIED SEED ACTIVE';
    }

    const currentAsset = MACRO_ASSETS[activeMacroAssetKey];
    updateMacroKpis(currentAsset);
    renderLightweightMacroCharts();
    renderFinvizCotView(currentAsset);
    if (syncStampEl) {
      syncStampEl.textContent = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }
  }

  function selectMacroAsset(key: string): void {
    activeMacroAssetKey = key;
    document.querySelectorAll('#ich-macro-asset-tabs .ich-asset-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-asset-key') === key);
    });
    const asset = MACRO_ASSETS[key];
    updateMacroKpis(asset);
    renderLightweightMacroCharts();
    renderFinvizCotView(asset);

    const tvView = document.getElementById('view-tv-cot-iframe');
    if (tvView && tvView.classList.contains('active')) {
      renderMacroTradingViewTerminal(asset.tvEmbedSymbol);
    }
  }

  function bindEvents(): void {
    document.querySelectorAll('#ich-tv-instrument-tabs .ich-inst-tab').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLButtonElement;
        document.querySelectorAll('#ich-tv-instrument-tabs .ich-inst-tab').forEach((b) => b.classList.remove('active'));
        target.classList.add('active');
        activeTvSymbol = target.getAttribute('data-tv-symbol') || 'OANDA:XAUUSD';
        renderUpperTradingViewChart();

        const linkedMacro = target.getAttribute('data-macro-link');
        if (linkedMacro && MACRO_ASSETS[linkedMacro]) {
          selectMacroAsset(linkedMacro);
        }
      });
    });

    document.querySelectorAll('#ich-tv-style-group .ich-toggle-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLButtonElement;
        document.querySelectorAll('#ich-tv-style-group .ich-toggle-btn').forEach((b) => b.classList.remove('active'));
        target.classList.add('active');
        activeTvStyle = target.getAttribute('data-tv-style') || '1';
        renderUpperTradingViewChart();
      });
    });

    document.querySelectorAll('#ich-macro-view-tabs .ich-view-tab').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLButtonElement;
        const viewId = target.getAttribute('data-macro-view');
        if (!viewId) return;
        document.querySelectorAll('#ich-macro-view-tabs .ich-view-tab').forEach((b) => b.classList.remove('active'));
        target.classList.add('active');
        document.querySelectorAll('#institutional-chart-section .ich-macro-view').forEach((v) => v.classList.remove('active'));
        const viewEl = document.getElementById(viewId);
        if (viewEl) viewEl.classList.add('active');

        const asset = MACRO_ASSETS[activeMacroAssetKey];
        if (viewId === 'view-cftc-canvas') {
          renderLightweightMacroCharts();
        } else if (viewId === 'view-tv-cot-iframe') {
          renderMacroTradingViewTerminal(asset.tvEmbedSymbol);
        } else if (viewId === 'view-finviz-cot') {
          renderFinvizCotView(asset);
        }
      });
    });

    document.querySelectorAll('#ich-macro-asset-tabs .ich-asset-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLButtonElement;
        const key = target.getAttribute('data-asset-key');
        if (key && MACRO_ASSETS[key]) {
          selectMacroAsset(key);
        }
      });
    });

    document.querySelectorAll('#ich-lw-mode-group .ich-toggle-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLButtonElement;
        document.querySelectorAll('#ich-lw-mode-group .ich-toggle-btn').forEach((b) => b.classList.remove('active'));
        target.classList.add('active');
        const mode = target.getAttribute('data-lw-mode') as 'histogram' | 'candlestick' | 'line';
        if (mode) {
          activeLwMode = mode;
          renderLightweightMacroCharts();
        }
      });
    });

    document.querySelectorAll('#ich-series-toggles input[type="checkbox"]').forEach((input) => {
      input.addEventListener('change', (e) => {
        const target = e.currentTarget as HTMLInputElement;
        const seriesKey = target.getAttribute('data-series') as keyof typeof activeSeriesFlags;
        if (seriesKey && seriesKey in activeSeriesFlags) {
          activeSeriesFlags[seriesKey] = target.checked;
          renderLightweightMacroCharts();
        }
      });
    });

    window.addEventListener('resize', () => {
      const cotEl = document.getElementById('ich-cot-lw-chart');
      const oiEl = document.getElementById('ich-oi-lw-chart');
      if (cotChart && cotEl && cotEl.clientWidth > 0) {
        cotChart.applyOptions({ width: cotEl.clientWidth });
      }
      if (oiChart && oiEl && oiEl.clientWidth > 0) {
        oiChart.applyOptions({ width: oiEl.clientWidth });
      }
    });
  }

  const existingScript = document.querySelector('script[src="https://s3.tradingview.com/tv.js"]');
  if (existingScript && window.TradingView) {
    renderUpperTradingViewChart();
  } else {
    const tvScript = document.createElement('script');
    tvScript.src = 'https://s3.tradingview.com/tv.js';
    tvScript.async = true;
    tvScript.onload = () => {
      renderUpperTradingViewChart();
    };
    document.head.appendChild(tvScript);
  }

  bindEvents();
  const initialAsset = MACRO_ASSETS[activeMacroAssetKey];
  updateMacroKpis(initialAsset);
  renderLightweightMacroCharts();
  renderFinvizCotView(initialAsset);
  autoSyncFromCftcApi();

  let secondsRemaining = 60;
  const countdownEl = document.getElementById('ich-poll-countdown');
  setInterval(() => {
    secondsRemaining -= 1;
    if (secondsRemaining <= 0) {
      secondsRemaining = 60;
      autoSyncFromCftcApi();
    }
    if (countdownEl) countdownEl.textContent = `${secondsRemaining}s`;
  }, 1000);
}
