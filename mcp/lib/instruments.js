/**
 * Institutional Market Structure & Macro Terminal — instrument registry.
 * Single source of truth for every data pipeline (CFTC, Yahoo, TradingView, Finviz).
 */

export const INSTRUMENTS = [
  {
    id: 'gold',
    displayName: 'Gold (XAU/USD)',
    tvLiveSymbol: 'OANDA:XAUUSD',
    tvFuturesSymbol: 'COMEX:GC1!',
    cftcContractCode: '088691',
    cftcReportSource: 'disaggregated',
    yahooFuturesTicker: 'GC=F',
    finvizCode: 'GC',
  },
  {
    id: 'silver',
    displayName: 'Silver (XAG/USD)',
    tvLiveSymbol: 'OANDA:XAGUSD',
    tvFuturesSymbol: 'COMEX:SI1!',
    cftcContractCode: '084691',
    cftcReportSource: 'disaggregated',
    yahooFuturesTicker: 'SI=F',
    finvizCode: 'SI',
  },
  {
    id: 'dxy',
    displayName: 'US Dollar Index (DXY)',
    tvLiveSymbol: 'TVC:DXY',
    tvFuturesSymbol: 'ICEUS:DX1!',
    cftcContractCode: '098662',
    cftcReportSource: 'financial',
    yahooFuturesTicker: 'DX-Y.NYB',
    finvizCode: 'DX',
  },
  {
    id: 'nasdaq_spot',
    displayName: 'Nasdaq Spot CFD (BlackBull)',
    tvLiveSymbol: 'BLACKBULL:USTEC',
    tvFuturesSymbol: 'CME_MINI:NQ1!',
    cftcContractCode: '209742',
    cftcReportSource: 'financial',
    yahooFuturesTicker: 'NQ=F',
    finvizCode: 'NQ',
  },
  {
    id: 'nasdaq_futures',
    displayName: 'Nasdaq 100 Futures (NQ)',
    tvLiveSymbol: 'CME_MINI:NQ1!',
    tvFuturesSymbol: 'CME_MINI:NQ1!',
    cftcContractCode: '209742',
    cftcReportSource: 'financial',
    yahooFuturesTicker: 'NQ=F',
    finvizCode: 'NQ',
  },
  {
    id: 'sp500_futures',
    displayName: 'S&P 500 Futures (ES)',
    tvLiveSymbol: 'CME_MINI:ES1!',
    tvFuturesSymbol: 'CME_MINI:ES1!',
    cftcContractCode: '13874A',
    cftcReportSource: 'financial',
    yahooFuturesTicker: 'ES=F',
    finvizCode: 'ES',
  },
  {
    id: 'dow_futures',
    displayName: 'Dow Jones Futures (YM)',
    tvLiveSymbol: 'CBOT_MINI:YM1!',
    tvFuturesSymbol: 'CBOT_MINI:YM1!',
    cftcContractCode: '124603',
    cftcReportSource: 'financial',
    yahooFuturesTicker: 'YM=F',
    finvizCode: 'YM',
  },
];

export const INSTRUMENT_BY_ID = new Map(INSTRUMENTS.map((i) => [i.id, i]));

/** Distinct CFTC contract codes (Nasdaq spot & futures share the same code). */
export const CFTC_CODES = new Set(INSTRUMENTS.map((i) => i.cftcContractCode));

export const FINVIZ_CODES = new Set(INSTRUMENTS.map((i) => i.finvizCode));
