/**
 * Yahoo Finance futures volume / open-interest ingestion.
 *
 * Primary: v8 chart API (daily OHLCV series — verified working).
 * Best effort: v7 quote API behind the cookie+crumb flow (blocked from some
 * networks); when it fails, open interest falls back to the CFTC series,
 * which is the authoritative futures OI anyway.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface YahooBar {
  date: string;
  close: number | null;
  volume: number | null;
}

export interface YahooQuote {
  price: number | null;
  volume: number | null;
  openInterest: number | null;
}

export async function fetchYahooChart(
  ticker: string,
  range = '3mo',
  interval = '1d',
): Promise<YahooBar[] | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker,
  )}?range=${range}&interval=${interval}&includePrePost=false`;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      chart?: { result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{ close?: (number | null)[]; volume?: (number | null)[] }> };
      }> };
    };
    const r = json.chart?.result?.[0];
    if (!r?.timestamp) return null;
    const q = r.indicators?.quote?.[0] ?? {};
    const bars: YahooBar[] = [];
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

/** Best-effort v7 quote behind the cookie+crumb flow; null on any failure. */
export async function fetchYahooQuote(ticker: string): Promise<YahooQuote | null> {
  try {
    const fc = await fetch('https://fc.yahoo.com', {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(15_000),
    });
    const setCookie = fc.headers.get('set-cookie') ?? '';
    await fc.text();

    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'user-agent': UA, cookie: setCookie },
      signal: AbortSignal.timeout(15_000),
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumb) return null;

    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(
      ticker,
    )}&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json', cookie: setCookie },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      quoteResponse?: { result?: Array<{
        regularMarketPrice?: number;
        regularMarketVolume?: number;
        openInterest?: number;
      }> };
    };
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
