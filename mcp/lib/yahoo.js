/**
 * Yahoo Finance futures volume / open-interest ingestion (Worker runtime).
 *
 * Primary: v8 chart API (daily OHLCV series).
 * Best effort: v7 quote API behind the cookie+crumb flow; when it fails, open
 * interest falls back to the CFTC series, which is authoritative for futures OI.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function fetchYahooChart(ticker, range = '3mo', interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker,
  )}?range=${range}&interval=${interval}&includePrePost=false`;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const r = json.chart?.result?.[0];
    if (!r?.timestamp) return null;
    const q = r.indicators?.quote?.[0] ?? {};
    const bars = [];
    for (let i = 0; i < r.timestamp.length; i++) {
      const date = new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10);
      const close = typeof q.close?.[i] === 'number' ? q.close[i] : null;
      const volume = typeof q.volume?.[i] === 'number' ? q.volume[i] : null;
      if (!date) continue;
      bars.push({ date, close, volume });
    }
    return bars.length ? bars : null;
  } catch {
    return null;
  }
}

/**
 * Full OHLCV bars for the on-site price chart (TradingView fallback).
 * Returns `{ symbol, interval, bars: [{ time, open, high, low, close, volume }] }`
 * with `time` as a Unix timestamp in seconds (Lightweight Charts format).
 */
export async function fetchYahooOhlc(ticker, range = '5d', interval = '15m') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker,
  )}?range=${range}&interval=${interval}&includePrePost=false`;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const r = json.chart?.result?.[0];
    if (!r?.timestamp) return null;
    const q = r.indicators?.quote?.[0] ?? {};
    const bars = [];
    for (let i = 0; i < r.timestamp.length; i++) {
      const open = q.open?.[i];
      const high = q.high?.[i];
      const low = q.low?.[i];
      const close = q.close?.[i];
      if (typeof open !== 'number' || typeof high !== 'number' || typeof low !== 'number' || typeof close !== 'number') {
        continue;
      }
      bars.push({
        time: r.timestamp[i],
        open,
        high,
        low,
        close,
        volume: typeof q.volume?.[i] === 'number' ? q.volume[i] : 0,
      });
    }
    return bars.length ? { symbol: r.meta?.symbol ?? ticker, interval, bars } : null;
  } catch {
    return null;
  }
}

/** Best-effort v7 quote behind the cookie+crumb flow; null on any failure. */
export async function fetchYahooQuote(ticker) {
  try {
    const fc = await fetch('https://fc.yahoo.com', {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(12_000),
    });
    const setCookie = fc.headers.get('set-cookie') ?? '';
    await fc.text();

    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'user-agent': UA, cookie: setCookie },
      signal: AbortSignal.timeout(12_000),
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumb) return null;

    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(
      ticker,
    )}&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json', cookie: setCookie },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const q = json.quoteResponse?.result?.[0];
    if (!q) return null;
    return {
      price: typeof q.regularMarketPrice === 'number' ? q.regularMarketPrice : null,
      volume: typeof q.regularMarketVolume === 'number' ? q.regularMarketVolume : null,
      openInterest: typeof q.openInterest === 'number' ? q.openInterest : null,
    };
  } catch {
    return null;
  }
}
