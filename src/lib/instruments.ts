/**
 * Institutional Market Structure & Macro Terminal — instrument registry.
 * Single source of truth for every data pipeline (CFTC, Yahoo, TradingView, Finviz).
 * English-only labels; comments in English.
 */
export interface Instrument {
  /** Stable id used across the API payload and the frontend state. */
  id: string;
  /** Human-readable display name shown in the asset switcher pills. */
  displayName: string;
  /** TradingView symbol for the live price panel (sub-second WebSocket stream). */
  tvLiveSymbol: string;
  /** TradingView symbol for the COT & OI interactive tab. */
  tvFuturesSymbol: string;
  /** CFTC contract market code used to match rows in legacy / disagg / TFF files. */
  cftcContractCode: string;
  /**
   * Which CFTC category snapshot file covers this instrument:
   *  - 'disaggregated' -> f_disagg.txt (Prod/Merc, Swap, Managed Money)
   *  - 'financial'      -> FinFutWk.txt (Dealer, Asset Manager, Leveraged Money)
   */
  cftcReportSource: 'disaggregated' | 'financial';
  /** Yahoo Finance futures ticker for daily volume / open interest sync. */
  yahooFuturesTicker: string;
  /** Finviz futures chart code used by the proxy endpoint. */
  finvizCode: string;
}

export const INSTRUMENTS: Instrument[] = [
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
    yahooFuturesTicker: 'DX=F',
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

export const INSTRUMENT_BY_ID: ReadonlyMap<string, Instrument> = new Map(
  INSTRUMENTS.map((i) => [i.id, i]),
);

/** Distinct CFTC contract codes (Nasdaq spot & futures share the same code). */
export const CFTC_CODES: ReadonlySet<string> = new Set(
  INSTRUMENTS.map((i) => i.cftcContractCode),
);

export const FINVIZ_CODES: ReadonlySet<string> = new Set(
  INSTRUMENTS.map((i) => i.finvizCode),
);
