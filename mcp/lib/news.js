/**
 * News module — weekly macroeconomic calendar + pre-release USD/XAU prediction engine.
 *
 * Data sources
 *  - Primary: ForexFactory weekly JSON (https://nfs.faireconomy.media/ff_calendar_thisweek.json),
 *    cached in KV ("news:calendar") and refreshed at most every NEWS_TTL_MS.
 *  - Historical series: rolling ledger in KV ("news:hist:<eventKey>"). Every sync, each event's
 *    "previous" value (which ForexFactory updates to the prior release's actual, revisions
 *    included) is appended with its as-of week. Optional enrichment: when FMP_API_KEY is bound,
 *    released actuals are pulled from the FinancialModelingPrep economic calendar.
 *
 * Prediction engine: deterministic, rule-based and explainable. It never invents numbers —
 * every Beat/Inline/Miss call cites the trend, forecast gap and confidence inputs it used.
 */

const NEWS_TTL_MS = 3 * 60 * 60 * 1000; // refresh at most every 3 h (weekly cadence + freshness)
const HISTORY_CAP = 24; // keep up to 24 past releases per event
const FMP_URL = "https://financialmodelingprep.com/stable/economic-calendar";

export const WATCH_CURRENCIES = new Set(["USD", "EUR", "GBP"]);
const HIGH_IMPACT = new Set(["high"]);
const MEDIUM_IMPACT = new Set(["medium"]);

/* ------------------------------------------------------------------ */
/* Event families: regex → {family, usdBullishOnBeat}                  */
/* usdBullishOnBeat: true  → stronger-than-forecast print is USD-bullish  */
/*                   false → stronger-than-forecast print is USD-bearish  */
/*                   null  → non-numeric / event risk (no direction)      */
/* ------------------------------------------------------------------ */

const EVENT_RULES = [
  { re: /non-farm employment change|nonfarm payrolls|nfp/i, family: "NFP", usdBullishOnBeat: true },
  { re: /unemployment claims|jobless claims/i, family: "Claims", usdBullishOnBeat: false }, // fewer claims = USD bullish
  { re: /unemployment rate/i, family: "UnemploymentRate", usdBullishOnBeat: false }, // lower = USD bullish
  { re: /cpi/i, family: "CPI", usdBullishOnBeat: true },
  { re: /ppi/i, family: "PPI", usdBullishOnBeat: true },
  { re: /\bgdp\b|gdp /i, family: "GDP", usdBullishOnBeat: true },
  { re: /retail sales/i, family: "RetailSales", usdBullishOnBeat: true },
  { re: /ism|pmi/i, family: "PMI", usdBullishOnBeat: true },
  { re: /interest rate decision|federal funds rate|bank rate/i, family: "RateDecision", usdBullishOnBeat: true },
  { re: /fomc|monetary policy statement|press conference|testifies|testimony/i, family: "CentralBankSpeech", usdBullishOnBeat: null },
  { re: /durable goods|core durable goods/i, family: "DurableGoods", usdBullishOnBeat: true },
  { re: /industrial production|factory orders/i, family: "Industrial", usdBullishOnBeat: true },
  { re: /consumer confidence|sentiment index|michigan/i, family: "Sentiment", usdBullishOnBeat: true },
  { re: /building permits|housing starts|new home sales/i, family: "Housing", usdBullishOnBeat: true },
  { re: /trade balance|current account/i, family: "TradeBalance", usdBullishOnBeat: true },
  { re: /crude oil inventories/i, family: "Inventories", usdBullishOnBeat: null },
  { re: /adv|challenger|adiru|average hourly earnings|employment cost/i, family: "LaborOther", usdBullishOnBeat: true },
];

/** High-impact events that directly drive XAUUSD liquidity and volatility. */
const GOLD_DRIVERS =
  /cpi|non-farm|payrolls|fomc|interest rate|retail sales|gdp|ism|ppi|unemployment claims|jobless|fed chair|powell/i;

/* ------------------------------------------------------------------ */
/* ISO week helpers + weekly ledger (KV)                               */
/* ------------------------------------------------------------------ */

/** Monday (UTC) of the ISO week containing the given ISO instant, YYYY-MM-DD. */
export function isoWeekStartUTC(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return start.toISOString().slice(0, 10);
}

export function isoWeekEndUTC(weekStart) {
  const start = new Date(`${weekStart}T00:00:00Z`);
  if (!Number.isFinite(start.getTime())) return null;
  const end = new Date(start.getTime() + 6 * 86400e3);
  return end.toISOString().slice(0, 10);
}

const WEEKS_INDEX_KEY = "news:weeks";
const WEEK_LEDGER_TTL_DAYS = 84; // ~3 months of rolling coverage

async function readWeeksIndex(env) {
  if (!env?.AI_STATE) return [];
  const raw = await env.AI_STATE.get(WEEKS_INDEX_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function writeWeeksIndex(env, index) {
  await env.AI_STATE.put(WEEKS_INDEX_KEY, JSON.stringify(index));
}

function mergeEvents(existing, fresh) {
  const byId = new Map();
  for (const ev of existing) byId.set(ev.id, ev);
  for (const ev of fresh) {
    // Prefer fresh rows (release actuals land as the week progresses), keep older otherwise.
    const prev = byId.get(ev.id);
    byId.set(ev.id, prev ? { ...prev, ...ev, actual: ev.actual ?? prev.actual ?? null } : ev);
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.timeIso) - Date.parse(b.timeIso));
}

/** Write/refresh one week in the ledger and return its stored object. */
export async function upsertWeek(env, weekStart, events) {
  if (!env?.AI_STATE || !weekStart) return null;
  const key = `news:week:${weekStart}`;
  const raw = await env.AI_STATE.get(key);
  const existing = raw ? JSON.parse(raw) : { weekStart, fetchedAt: null, events: [] };
  const merged = mergeEvents(existing.events ?? [], events);
  const weekEnd = isoWeekEndUTC(weekStart);
  const record = {
    weekStart,
    weekEnd,
    fetchedAt: new Date().toISOString(),
    count: merged.length,
    events: merged,
  };
  await env.AI_STATE.put(key, JSON.stringify(record));
  // index maintenance
  const index = await readWeeksIndex(env);
  const without = index.filter((w) => w.weekStart !== weekStart);
  without.push({ weekStart, weekEnd, fetchedAt: record.fetchedAt, count: record.count });
  // prune beyond the retention window
  const cutoff = new Date(Date.now() - WEEK_LEDGER_TTL_DAYS * 86400e3).getTime();
  const kept = [];
  for (const w of without) {
    if (Date.parse(`${w.weekStart}T00:00:00Z`) >= cutoff) {
      kept.push(w);
    } else {
      await env.AI_STATE.delete(`news:week:${w.weekStart}`).catch(() => {});
      await env.AI_STATE.delete(`news:hist:` + w.weekStart).catch(() => {});
    }
  }
  kept.sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
  await writeWeeksIndex(env, kept);
  return record;
}

/** All weeks currently stored, oldest first. */
export async function listWeeks(env) {
  return readWeeksIndex(env);
}

/** Events for the ISO week containing `dateIso` — empty when the ledger lacks it. */
export async function getWeekEvents(env, dateIso) {
  if (!env?.AI_STATE) return { weekStart: null, events: [], availableWeeks: [] };
  const weekStart = isoWeekStartUTC(dateIso);
  if (!weekStart) throw new Error(`bad date: ${dateIso}`);
  const weekEnd = isoWeekEndUTC(weekStart);
  const raw = await env.AI_STATE.get(`news:week:${weekStart}`);
  const availableWeeks = await readWeeksIndex(env);
  if (raw) {
    const rec = JSON.parse(raw);
    return { weekStart, weekEnd, fetchedAt: rec.fetchedAt, events: rec.events ?? [], source: "ledger", availableWeeks };
  }
  // Never "lose" the live feed — but only re-fetch it when the requested week
  // could plausibly be the one the feed serves (thisweek / its immediate neighbour).
  // Otherwise return the ledger state immediately: paging backwards must stay fast
  // even when the feed is rate-limiting.
  const todayWeek = isoWeekStartUTC(new Date().toISOString());
  const newestStored = availableWeeks.reduce((max, w) => (w.weekStart > max ? w.weekStart : max), "");
  const nextWeekFromStored = newestStored
    ? new Date(Date.parse(`${newestStored}T00:00:00Z`) + 7 * 86400e3).toISOString().slice(0, 10)
    : null;
  const feedEligible = weekStart === todayWeek || weekStart === newestStored || weekStart === nextWeekFromStored;
  if (feedEligible) {
    try {
      const feedEvents = filterCalendar(await fetchFeed({ quick: true }));
      const todayPack = drainEventsIntoWeeks(feedEvents);
      if (todayPack[weekStart]?.length) {
        const rec = await upsertWeek(env, weekStart, todayPack[weekStart]);
        return { weekStart, weekEnd, fetchedAt: rec?.fetchedAt ?? null, events: rec?.events ?? [], source: "forexfactory/faireconomy thisweek", availableWeeks: await readWeeksIndex(env) };
      }
    } catch {
      /* feed unavailable — honest empty state */
    }
  }
  return { weekStart, weekEnd, events: [], source: null, availableWeeks };
}

function drainEventsIntoWeeks(events) {
  const byWeek = {};
  for (const ev of events) {
    const ws = isoWeekStartUTC(ev.timeIso);
    if (!ws) continue;
    (byWeek[ws] ??= []).push(ev);
  }
  return byWeek;
}

/* ------------------------------------------------------------------ */
/* Month backfill via FinancialModelingPrep (optional FMP_API_KEY)      */
/* ------------------------------------------------------------------ */

const FMP_ECON_CAL = "https://financialmodelingprep.com/stable/economic-calendar";

// FMP uses ISO country codes; map to the currencies we show.
const FMP_COUNTRY_MAP = {
  US: "USD",
  UNITED_STATES: "USD",
  USA: "USD",
  GB: "GBP",
  UNITED_KINGDOM: "GBP",
  UK: "GBP",
  EU: "EUR",
  EUR: "EUR",
  EUROZONE: "EUR",
  DE: "EUR",
  FR: "EUR",
  IT: "EUR",
  ES: "EUR",
  NL: "EUR",
  AT: "EUR",
  BE: "EUR",
  PT: "EUR",
  GR: "EUR",
  IE: "EUR",
  FI: "EUR",
};

function normalizeFmpRow(row) {
  const rawCountry = String(row.country ?? row.currency ?? row.countryCode ?? "").toUpperCase().replace(/\s+/g, "_");
  const currency = FMP_COUNTRY_MAP[rawCountry];
  if (!currency) return null;
  const title = String(row.event ?? row.name ?? row.title ?? "").trim();
  if (!title) return null;
  const impactRaw = String(row.impact ?? row.importance ?? row.priority ?? "").toLowerCase();
  const impact = impactRaw.includes("high") ? "high" : impactRaw.includes("medium") ? "medium" : null;
  if (!impact) return null; // exclude low/noise from the backfill entirely
  const ts = Date.parse(row.date ?? row.time ?? "");
  if (!Number.isFinite(ts)) return null;
  const rule = classifyEvent(title);
  const actualRaw = row.actual ?? null;
  const forecastRaw = row.estimate ?? row.forecast ?? row.consensus ?? null;
  const previousRaw = row.previous ?? null;
  const fmtNum = (v) => (v === null || v === undefined || v === "" ? null : String(v));
  const goldRelevance = currency === "USD"
    ? GOLD_DRIVERS.test(title)
      ? "direct"
      : impact === "high"
        ? "indirect"
        : "indirect"
    : currency === "EUR" || currency === "GBP"
      ? "cross"
      : "none";
  return {
    id: eventKey(title, currency, ts),
    title,
    currency,
    impact,
    impactLabel: impact === "high" ? "High · Red" : "Medium · Orange",
    timeIso: new Date(ts).toISOString(),
    forecast: fmtNum(forecastRaw),
    previous: fmtNum(previousRaw),
    actual: fmtNum(actualRaw),
    family: rule.family,
    goldRelevance,
  };
}

/** Backfill the ledger with FMP economic-calendar rows (requires FMP_API_KEY). */
export async function backfillFromFmp(env) {
  const key = env?.FMP_API_KEY;
  if (!key || !env?.AI_STATE) return { ok: false, reason: "FMP_API_KEY not bound" };
  try {
    const to = new Date(Date.now() + 21 * 86400e3).toISOString().slice(0, 10);
    const from = new Date(Date.now() - 70 * 86400e3).toISOString().slice(0, 10);
    const res = await fetch(`${FMP_ECON_CAL}?from=${from}&to=${to}&apikey=${encodeURIComponent(key)}`);
    if (!res.ok) return { ok: false, reason: `FMP HTTP ${res.status}` };
    const rows = await res.json();
    if (!Array.isArray(rows)) return { ok: false, reason: "FMP non-array payload" };
    const events = rows.map(normalizeFmpRow).filter(Boolean);
    const byWeek = drainEventsIntoWeeks(events);
    for (const [weekStart, weekEvents] of Object.entries(byWeek)) {
      await upsertWeek(env, weekStart, weekEvents);
    }
    return { ok: true, rows: rows.length, events: events.length, weeksUpserted: Object.keys(byWeek).length };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

export function classifyEvent(title) {
  for (const rule of EVENT_RULES) {
    if (rule.re.test(title)) return rule;
  }
  return { re: null, family: "Other", usdBullishOnBeat: null };
}

/* ------------------------------------------------------------------ */
/* Number parsing                                                      */
/* ------------------------------------------------------------------ */

/**
 * Parse "0.3%", "57.5", "1.2B", "-42K", "5.25%" → number, or null.
 * K/M/B/T suffixes are scaled so percent-vs-billions comparisons stay
 * within the same unit family (we never compare across suffix kinds).
 */
export function parseNum(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s || s === "—" || s === "-") return null;
  const m = s.match(/^(-?)\+?([\d,.]+)\s*(%|K|M|B|T)?$/i);
  if (!m) return null;
  const base = Number(`${m[1]}${m[2].replace(/,/g, "")}`);
  if (!Number.isFinite(base)) return null;
  const suffix = (m[3] ?? "").toUpperCase();
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, "%": 1 }[suffix] ?? 1;
  return base * mult;
}

export function numKind(raw) {
  const m = String(raw ?? "").match(/(K|M|B|T|%)$/i);
  return m ? m[1].toUpperCase() : "";
}

/* ------------------------------------------------------------------ */
/* Calendar fetch + normalise                                          */
/* ------------------------------------------------------------------ */

function isWatched(country) {
  return WATCH_CURRENCIES.has(String(country ?? "").toUpperCase());
}

/** Normalise one ForexFactory row into our canonical event shape. */
export function normaliseEvent(row) {
  const country = String(row.country ?? "").toUpperCase();
  const impactRaw = String(row.impact ?? "").toLowerCase();
  const impact = HIGH_IMPACT.has(impactRaw) ? "high" : MEDIUM_IMPACT.has(impactRaw) ? "medium" : "low";
  const ts = Date.parse(row.date);
  if (!Number.isFinite(ts)) return null;
  const rule = classifyEvent(row.title);
  const currency = country;
  const goldRelevance = GOLD_DRIVERS.test(row.title) && country === "USD"
    ? "direct"
    : country === "USD" && impact === "high"
      ? "indirect"
      : country === "EUR" || country === "GBP"
        ? "cross"
        : "none";
  return {
    id: eventKey(row.title, country, ts),
    title: String(row.title ?? "").trim(),
    currency,
    impact, // high | medium | low
    impactLabel: impact === "high" ? "High · Red" : impact === "medium" ? "Medium · Orange" : "Low · excluded by default",
    timeIso: new Date(ts).toISOString(),
    forecast: String(row.forecast ?? "").trim() || null,
    previous: String(row.previous ?? "").trim() || null,
    actual: row.actual != null && String(row.actual).trim() ? String(row.actual).trim() : null,
    family: rule.family,
    goldRelevance, // direct | indirect | cross | none
  };
}

function eventKey(title, country, ts) {
  // Stable id: currency + slug(title) + Tehran calendar date.
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  const day = new Date(ts + 3.5 * 3600 * 1000).toISOString().slice(0, 10); // Tehran = UTC+3:30
  return `${country.toLowerCase()}-${slug}-${day}`;
}

export function filterCalendar(rows) {
  const out = [];
  for (const row of rows ?? []) {
    if (!isWatched(row.country)) continue;
    const ev = normaliseEvent(row);
    if (ev && ev.impact !== "low") out.push(ev);
  }
  out.sort((a, b) => Date.parse(a.timeIso) - Date.parse(b.timeIso));
  return out;
}

/* ------------------------------------------------------------------ */
/* Timezone / Jalali formatting (worker-side, full ICU)                 */
/* ------------------------------------------------------------------ */

const TZ_TEHRAN = "Asia/Tehran";
const TZ_NY = "America/New_York";

function tzTime(iso, timeZone) {
  const d = new Date(iso);
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", hour12: false, minute: "2-digit",
  }).format(d);
  return hhmm;
}

export function formatEventTimes(iso) {
  const d = new Date(iso);
  const jalaliEn = new Intl.DateTimeFormat("en-US-u-ca-persian", {
    timeZone: TZ_TEHRAN, day: "numeric", month: "long", year: "numeric",
  }).format(d).replace(/ AP/g, "");
  const jalaliFa = new Intl.DateTimeFormat("fa-IR", {
    timeZone: TZ_TEHRAN, day: "numeric", month: "long", year: "numeric",
  }).format(d);
  const weekdayEn = new Intl.DateTimeFormat("en-US", { timeZone: TZ_TEHRAN, weekday: "long" }).format(d);
  const weekdayFa = new Intl.DateTimeFormat("fa-IR", { timeZone: TZ_TEHRAN, weekday: "long" }).format(d);
  // Tehran calendar date (Gregorian) used for grouping / day keys.
  const tehranDay = new Intl.DateTimeFormat("en-CA", { timeZone: TZ_TEHRAN }).format(d);
  const nyDay = new Intl.DateTimeFormat("en-CA", { timeZone: TZ_NY }).format(d);
  return {
    tehran: `${tzTime(iso, TZ_TEHRAN)} IRST`,
    newYork: `${tzTime(iso, TZ_NY)} ${tzAbbr(iso, TZ_NY)}`,
    tehranTime: tzTime(iso, TZ_TEHRAN),
    nyTime: tzTime(iso, TZ_NY),
    jalali: `${weekdayEn}, ${jalaliEn}`,
    jalaliEn,
    jalaliFa: `${weekdayFa} ${jalaliFa}`,
    weekdayEn,
    weekdayFa,
    tehranDay,
    nyDay,
  };
}

function tzAbbr(iso, timeZone) {
  // EST / EDT via the offset-shape of the short format.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(new Date(iso));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "ET";
}

/* ------------------------------------------------------------------ */
/* KV layer                                                            */
/* ------------------------------------------------------------------ */

export async function readCalendar(env) {
  if (!env?.AI_STATE) return null;
  const raw = await env.AI_STATE.get("news:calendar");
  return raw ? JSON.parse(raw) : null;
}

async function writeCalendar(env, payload) {
  await env.AI_STATE?.put("news:calendar", JSON.stringify(payload));
}

function histKey(eventKeyStr) {
  return `news:hist:${eventKeyStr}`;
}

/** Append the previous-value ledger point for an event (dedupe by asOf week). */
export async function recordHistoryPoint(env, event) {
  if (!env?.AI_STATE || !event?.previous) return;
  const parsed = parseNum(event.previous);
  if (parsed === null) return;
  const key = histKey(event.id);
  const raw = await env.AI_STATE.get(key);
  const series = raw ? JSON.parse(raw) : { eventKey: event.id, title: event.title, currency: event.currency, points: [] };
  const asOf = event.timeIso;
  if (series.points.some((p) => p.asOf === asOf)) return;
  series.points.push({ asOf, value: parsed, raw: event.previous, kind: numKind(event.previous), forecastAtRelease: parseNum(event.forecast) });
  series.points.sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  if (series.points.length > HISTORY_CAP) series.points = series.points.slice(-HISTORY_CAP);
  await env.AI_STATE.put(key, JSON.stringify(series));
}

export async function readHistory(env, id) {
  if (!env?.AI_STATE) return null;
  const raw = await env.AI_STATE.get(histKey(id));
  return raw ? JSON.parse(raw) : null;
}

export async function listHistoryKeys(env) {
  if (!env?.AI_STATE) return [];
  const list = await env.AI_STATE.list({ prefix: "news:hist:" });
  return list.keys.map((k) => k.name);
}

/**
 * Optional secondary source: FinancialModelingPrep economic calendar actuals.
 * Only active when FMP_API_KEY is bound; failures degrade silently — the
 * ForexFactory ledger stays the source of truth.
 */
async function enrichWithFmp(env, events) {
  const key = env?.FMP_API_KEY;
  if (!key) return events;
  try {
    const from = new Date(Date.now() - 45 * 86400e3).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 8 * 86400e3).toISOString().slice(0, 10);
    const res = await fetch(`${FMP_URL}?from=${from}&to=${to}&apikey=${encodeURIComponent(key)}`);
    if (!res.ok) return events;
    const rows = await res.json();
    if (!Array.isArray(rows)) return events;
    const byKey = new Map();
    for (const row of rows) {
      if (!row?.date || !row?.actual) continue;
      const country = String(row.country ?? "").toUpperCase();
      if (!WATCH_CURRENCIES.has(country)) continue;
      const k = `${country}|${String(row.event ?? "").toLowerCase().slice(0, 40)}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push({ date: row.date, actual: row.actual, previous: row.previous ?? null, estimate: row.estimate ?? null });
    }
    // Attach the closest past actual to matching events (family + currency).
    for (const ev of events) {
      if (ev.actual) continue;
      const k = `${ev.currency}|${ev.title.toLowerCase().slice(0, 40)}`;
      const candidates = byKey.get(k) ?? [];
      const past = candidates
        .filter((c) => Date.parse(c.date) < Date.parse(ev.timeIso))
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
      if (past) ev.actual = past.actual;
    }
    return events;
  } catch {
    return events; // never fail the calendar on a secondary source
  }
}

const FF_URLS = [
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
  "https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json",
];

/** Fetch the weekly feed with mirror + backoff. `quick` skips retries (paging path). */
async function fetchFeed({ quick = false } = {}) {
  const attempts = quick ? 1 : 3;
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const url of attempt === 0 ? FF_URLS : [FF_URLS[0]]) {
      try {
        const res = await fetch(url, {
          headers: { accept: "application/json, text/plain, */*" },
          cf: attempt === 0 ? { cacheTtl: 900, cacheEverything: true } : undefined,
        });
        if (res.ok) {
          const rows = await res.json();
          if (Array.isArray(rows)) return rows;
          throw new Error("non-array payload");
        }
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
      } catch (e) {
        lastErr = e;
      }
    }
    if (!quick) await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
  }
  throw lastErr ?? new Error("feed fetch failed");
}

/** Fetch + normalise the week, roll history forward, cache. Returns the payload. */
export async function syncNews(env) {
  if (!env?.AI_STATE) {
    return { ok: false, error: "AI_STATE KV namespace not bound" };
  }
  const rows = await fetchFeed();
  const events = await enrichWithFmp(env, filterCalendar(rows));
  const generatedAt = new Date().toISOString();

  // Week window (Tehran-day based, from the events themselves).
  const days = [...new Set(events.map((e) => formatEventTimes(e.timeIso).tehranDay))].sort();

  const payload = {
    version: 1,
    source: "forexfactory/faireconomy thisweek",
    secondarySource: env?.FMP_API_KEY ? "financialmodelingprep" : null,
    generatedAt,
    weekStart: days[0] ?? null,
    weekEnd: days[days.length - 1] ?? null,
    count: events.length,
    events,
  };
  await writeCalendar(env, payload);

  // Roll the previous-value ledger for every watched event (background-safe).
  try {
    await Promise.all(events.map((ev) => recordHistoryPoint(env, ev)));
  } catch {
    /* history roll-up is best-effort */
  }

  // Merge thisweek's events into the rolling weekly ledger, then optionally
  // backfill the surrounding months via FMP when an API key is configured.
  try {
    const byWeek = drainEventsIntoWeeks(events);
    for (const [weekStart, weekEvents] of Object.entries(byWeek)) {
      await upsertWeek(env, weekStart, weekEvents);
    }
  } catch {
    /* ledger roll-up is best-effort — the thisweek payload is still served */
  }
  let backfill = null;
  try {
    backfill = await backfillFromFmp(env);
  } catch {
    backfill = null;
  }

  // Status record.
  await env.AI_STATE.put(
    "news:status",
    JSON.stringify({
      fetchedAt: generatedAt,
      count: events.length,
      source: payload.source,
      lastError: null,
      weeksStored: (await readWeeksIndex(env)).length,
      fmpBackfill: backfill,
    }),
  );
  return { ok: true, weeksStored: (await readWeeksIndex(env)).length, ...payload };
}

/** Ensure the calendar exists and is fresh; refresh in the background when stale. */
export async function ensureNews(env, ctx) {
  const cached = await readCalendar(env);
  const fresh = cached && Date.now() - Date.parse(cached.generatedAt) < NEWS_TTL_MS;
  if (cached && fresh) return cached;
  if (cached && ctx?.waitUntil) {
    ctx.waitUntil(
      syncNews(env).catch(async (e) => {
        await recordNewsError(env, String(e?.message ?? e));
      }),
    );
    return cached;
  }
  try {
    return await syncNews(env);
  } catch (e) {
    await recordNewsError(env, String(e?.message ?? e));
    if (cached) return cached;
    throw e;
  }
}

/** Best-effort status write when a feed sync fails, so /api/news/status shows why. */
export async function recordNewsError(env, message) {
  if (!env?.AI_STATE) return;
  try {
    const raw = await env.AI_STATE.get("news:status");
    const prev = raw ? JSON.parse(raw) : {};
    await env.AI_STATE.put(
      "news:status",
      JSON.stringify({ fetchedAt: prev.fetchedAt ?? null, count: prev.count ?? 0, source: prev.source ?? null, lastError: message, lastErrorAt: new Date().toISOString() }),
    );
  } catch {
    /* status is best-effort */
  }
}

/* ------------------------------------------------------------------ */
/* Prediction engine                                                   */
/* ------------------------------------------------------------------ */

const IMPACT_WEIGHT = { high: 1, medium: 0.6 };

/**
 * Predict one event's outcome vs consensus.
 * Evidence: trend of the historical ledger (momentum) + forecast-vs-previous gap.
 * Returns null direction when the event is non-numeric or evidence is absent.
 */
export async function predictEvent(env, event) {
  const rule = classifyEvent(event.title);
  const forecast = parseNum(event.forecast);
  const previous = parseNum(event.previous);
  const actual = parseNum(event.actual);
  const hist = await readHistory(env, event.id);
  const points = hist?.points?.filter((p) => Number.isFinite(p.value)) ?? [];

  // ---- surprise direction -------------------------------------------------
  let surpriseDir = null; // "above" | "below" | "inline" — where the release likely lands vs forecast
  let rationale = [];
  let confidence = 30; // floor: without evidence we are close to a coin flip

  if (actual !== null && forecast !== null) {
    // Already released — classify the actual print.
    surpriseDir = actual > forecast ? "above" : actual < forecast ? "below" : "inline";
    confidence = 95;
    rationale.push(`Released actual ${event.actual} vs forecast ${event.forecast}.`);
  } else if (forecast === null) {
    // Non-numeric (speeches, meetings): pure event risk.
    rationale.push("No numeric forecast — treated as event risk, not a predictable print.");
    return buildPrediction(event, rule, null, null, 20, rationale, points.length, hist);
  } else {
    // Forecast vs previous gap.
    if (previous !== null && Number.isFinite(previous)) {
      const gapPct = previous !== 0 ? ((forecast - previous) / Math.abs(previous)) * 100 : null;
      if (forecast > previous) {
        rationale.push(`Consensus ${event.forecast} sits above the previous ${event.previous} — the market already prices improvement.`);
      } else if (forecast < previous) {
        rationale.push(`Consensus ${event.forecast} sits below the previous ${event.previous} — the market already prices cooling.`);
      } else {
        rationale.push(`Consensus matches the previous print (${event.previous}) — a flat series.`);
      }
      if (gapPct !== null && Math.abs(gapPct) >= 100) confidence += 5;
    } else {
      rationale.push("No previous value on the feed — trend evidence unavailable.");
    }

    // Momentum from the rolling ledger (each point = prior release's actual).
    if (points.length >= 2) {
      const dirs = [];
      for (let i = 1; i < points.length; i++) {
        const d = points[i].value - points[i - 1].value;
        if (d > 0) dirs.push(1);
        else if (d < 0) dirs.push(-1);
      }
      const up = dirs.filter((d) => d === 1).length;
      const down = dirs.filter((d) => d === -1).length;
      const streak = up > down ? "rising" : down > up ? "falling" : "flat";
      const agree = Math.max(up, down) - Math.min(up, down);
      if (streak !== "flat") {
        rationale.push(`Historical series (last ${points.length} tracked releases) is ${streak} in ${Math.max(up, down)}/${dirs.length} periods.`);
        confidence += Math.min(agree * 5, 20) + Math.min(points.length, 6) * 2;
        // A series trending toward the forecast makes a Beat more plausible.
        if (
          (streak === "rising" && forecast > previous) ||
          (streak === "falling" && forecast < previous)
        ) {
          surpriseDir = "above";
          rationale.push("Momentum and consensus point the same way — lean toward the consensus continuing the trend.");
        } else {
          surpriseDir = "inline";
          rationale.push("Momentum runs against the consensus gap — expect an inline-to-contrarian print.");
        }
      } else {
        surpriseDir = "inline";
        rationale.push("Historical series oscillates with no clear momentum — default to inline.");
      }
    } else if (points.length === 1 || previous !== null) {
      surpriseDir = "inline";
      rationale.push("Limited history — default to an inline release.");
      confidence += previous !== null ? 10 : 0;
    } else {
      surpriseDir = "inline";
      rationale.push("No numeric history at all — inline is the uninformative prior.");
    }
    confidence = Math.min(confidence, 75);
  }

  // ---- directional bias ----------------------------------------------------
  let bias = null;
  if (surpriseDir && rule.usdBullishOnBeat !== null) {
    const bullishOnAbove = rule.usdBullishOnBeat;
    if (surpriseDir === "above") bias = bullishOnAbove ? "bullish" : "bearish";
    else if (surpriseDir === "below") bias = bullishOnAbove ? "bearish" : "bullish";
    else bias = "neutral";
  }
  return buildPrediction(event, rule, surpriseDir, bias, confidence, rationale, points.length, hist);
}

function buildPrediction(event, rule, surpriseDir, bias, confidence, rationale, histLen, hist) {
  const surprise =
    surpriseDir === "above" ? "Beat" : surpriseDir === "below" ? "Miss" : surpriseDir === "inline" ? "Inline" : null;
  const usd =
    bias === "bullish"
      ? "Bullish USD"
      : bias === "bearish"
        ? "Bearish USD"
        : bias === "neutral"
          ? "Neutral USD"
          : event.forecast === null
            ? "Event risk (non-numeric)"
            : "No direct USD rule (watch the pair itself)";
  const pair = event.currency === "USD"
    ? "USD"
    : event.currency === "EUR"
      ? "EUR"
      : event.currency === "GBP"
        ? "GBP"
        : event.currency;
  const xau = bias === "bullish" ? "Bearish XAUUSD" : bias === "bearish" ? "Bullish XAUUSD" : "Neutral / event risk";
  return {
    eventId: event.id,
    title: event.title,
    currency: event.currency,
    impact: event.impact,
    timeIso: event.timeIso,
    forecast: event.forecast,
    previous: event.previous,
    actual: event.actual,
    family: rule.family,
    predictedOutcome: surprise,
    predictedDirection: surpriseDir,
    usdBias: usd,
    pairBias:
      bias === "bullish"
        ? `${pair} bullish`
        : bias === "bearish"
          ? `${pair} bearish`
          : "neutral",
    xauImpact: event.currency === "USD" ? xau : "indirect via USD",
    confidence: Math.round(Math.max(5, Math.min(confidence, 95))),
    rationale: rationale.join(" "),
    historyPoints: histLen,
    history: (hist?.points ?? []).map((p) => ({ date: p.asOf, value: p.raw ?? p.value })),
  };
}

/**
 * Day-level analysis with the non-contradiction alignment filter.
 * Groups all High/Medium events for one Tehran calendar day, weighs each
 * directional call by impact and confidence, flags contradictions.
 */
export async function analyzeDay(env, dateIso /* event time anchor or YYYY-MM-DD Tehran day */) {
  const calendar = await ensureNews(env, {});
  if (!calendar) throw new Error("Calendar unavailable");
  let targetDay;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
    targetDay = dateIso;
  } else {
    targetDay = formatEventTimes(dateIso).tehranDay;
  }
  const dayEvents = calendar.events.filter(
    (e) => formatEventTimes(e.timeIso).tehranDay === targetDay,
  );
  const important = dayEvents.filter((e) => e.impact === "high" || e.impact === "medium");

  const predictions = [];
  for (const ev of important) predictions.push(await predictEvent(env, ev));

  // ---- alignment filter -----------------------------------------------------
  const directional = predictions.filter((p) => p.usdBias.startsWith("Bullish") || p.usdBias.startsWith("Bearish"));
  const neutral = predictions.filter((p) => !directional.includes(p));
  let bullScore = 0;
  let bearScore = 0;
  for (const p of directional) {
    const w = IMPACT_WEIGHT[p.impact] * (p.confidence / 100);
    if (p.usdBias.startsWith("Bullish")) bullScore += w;
    else bearScore += w;
  }
  const total = bullScore + bearScore;
  const dominant = bullScore === bearScore ? "neutral" : bullScore > bearScore ? "bullish" : "bearish";
  const dominance = total > 0 ? Math.abs(bullScore - bearScore) / total : 0;

  const aligned = directional.filter((p) =>
    dominant === "neutral" ? true : p.usdBias.startsWith(dominant === "bullish" ? "Bullish" : "Bearish"),
  );
  const contradicted = directional.filter((p) => !aligned.includes(p) && dominant !== "neutral");
  const conflicts = contradicted.map((p) => ({
    eventId: p.eventId,
    title: p.title,
    bias: p.usdBias,
    note: "Runs against the day's dominant direction — do not stack this with the aggregate call.",
  }));

  const dayConfidence = Math.round(
    Math.max(10, Math.min(85, 25 + dominance * 40 + Math.min(directional.length, 4) * 5 + (dayEvents.some((e) => e.impact === "high") ? 5 : 0))),
  );

  const biasText =
    directional.length === 0
      ? important.length
        ? "Releases are scheduled but no aligned directional edge emerges from the evidence — neutral day; trade the individual releases, not the day."
        : "No numeric directional evidence scheduled for this day — USD bias is event-risk only."
      : dominant === "neutral"
        ? "Conflicting releases of similar weight — the day nets out neutral; trade the individual releases, not the day."
        : dominant === "bullish"
          ? `USD likely to STRENGTHEN on the day's aligned releases (${aligned.length} of ${directional.length} directional events agree).`
          : `USD likely to WEAKEN on the day's aligned releases (${aligned.length} of ${directional.length} directional events agree).`;

  const xauImpact =
    dominant === "bullish"
      ? "Bearish XAUUSD (stronger USD, higher yields pressure gold)"
      : dominant === "bearish"
        ? "Bullish XAUUSD (weaker USD supports gold)"
        : "Neutral — watch the individual releases";

  return {
    version: 1,
    day: targetDay,
    generatedAt: new Date().toISOString(),
    tehran: formatEventTimes(`${targetDay}T12:00:00+03:30`),
    eventsScheduled: dayEvents.length,
    importantEvents: important.length,
    predictions,
    alignment: {
      dominantUsdBias: dominant,
      bullScore: Number(bullScore.toFixed(2)),
      bearScore: Number(bearScore.toFixed(2)),
      dominance: Number(dominance.toFixed(2)),
      aligned: aligned.map((p) => p.eventId),
      conflicts,
      neutralEvents: neutral.map((p) => ({ eventId: p.eventId, title: p.title, note: "Non-numeric or no directional rule — no directional weight." })),
    },
    summary: biasText,
    confidence: directional.length ? dayConfidence : 15,
    crossAsset: {
      xauusd: xauImpact,
      eurusd: dominant === "bullish" ? "Bearish EURUSD" : dominant === "bearish" ? "Bullish EURUSD" : "mixed",
      gbpusd: dominant === "bullish" ? "Bearish GBPUSD" : dominant === "bearish" ? "Bullish GBPUSD" : "mixed",
      dxy: dominant === "bullish" ? "Bullish DXY" : dominant === "bearish" ? "Bearish DXY" : "Neutral DXY",
    },
    disclaimer:
      "Rule-based fundamental heuristic on consensus, previous prints and the tracked release ledger — not investment advice.",
  };
}

/* ------------------------------------------------------------------ */
/* Custom AI analysis tool                                             */
/* ------------------------------------------------------------------ */

/**
 * custom_ai_news_analysis — deterministic wrapper that:
 *  - optionally applies a hypothetical actual print to a matched event,
 *  - filters cross-asset output to the requested target asset,
 *  - surfaces the user's custom prompt and trading bias rules in the output.
 * The connected AI client does its own reasoning ON TOP of this structured base.
 */
export async function customAnalysis(env, args = {}) {
  const date = args.date ?? null;
  const day = await analyzeDay(env, date ?? new Date().toISOString());

  let predictions = day.predictions;
  let hypothetical = null;
  const hypRaw = args.hypothetical_actual ?? args.hypotheticalActual ?? null;
  if (hypRaw) {
    const eventId = args.eventId ?? null;
    const target = eventId
      ? predictions.find((p) => p.eventId === eventId)
      : pickBestMatch(predictions, String(hypRaw.eventTitle ?? args.eventTitle ?? ""));
    if (target) {
      const fc = parseNum(target.forecast);
      const ac = parseNum(String(hypRaw.value ?? hypRaw));
      if (fc !== null && ac !== null) {
        const dir = ac > fc ? "above" : ac < fc ? "below" : "inline";
        const rule = classifyEvent(target.title);
        let bias = null;
        if (rule.usdBullishOnBeat !== null) {
          bias = dir === "above" ? (rule.usdBullishOnBeat ? "bullish" : "bearish") : dir === "below" ? (rule.usdBullishOnBeat ? "bearish" : "bullish") : "neutral";
        }
        hypothetical = {
          applied: true,
          eventId: target.eventId,
          title: target.title,
          hypotheticalActual: String(hypRaw.value ?? hypRaw),
          forecast: target.forecast,
          predictedOutcome: dir === "above" ? "Beat" : dir === "below" ? "Miss" : "Inline",
          usdBias: bias === "bullish" ? "Bullish USD" : bias === "bearish" ? "Bearish USD" : "Neutral USD",
          note: "Scenario override — day aggregate below recomputed with this print.",
        };
        // Recompute the day aggregate with the hypothetical print substituted.
        const adjusted = predictions.map((p) =>
          p.eventId === target.eventId
            ? { ...p, predictedOutcome: hypothetical.predictedOutcome, predictedDirection: dir, usdBias: hypothetical.usdBias, confidence: 90 }
            : p,
        );
        const agg = aggregate(adjusted);
        day.alignment = agg.alignment;
        day.summary = agg.summary;
        day.confidence = agg.confidence;
        day.crossAsset = agg.crossAsset;
        predictions = adjusted;
      }
    }
  }

  const targetAsset = args.target_asset ?? args.targetAsset ?? null;
  const crossAsset = targetAsset
    ? Object.fromEntries(Object.entries(day.crossAsset).filter(([k]) => k.includes(String(targetAsset).toLowerCase())))
    : day.crossAsset;

  return {
    version: 1,
    mode: "custom",
    generatedAt: new Date().toISOString(),
    day: day.day,
    baseAnalysis: {
      eventsScheduled: day.eventsScheduled,
      importantEvents: day.importantEvents,
      predictions,
    },
    scenario: hypothetical,
    alignment: day.alignment,
    summary: day.summary,
    confidence: day.confidence,
    crossAsset,
    customPrompt: args.custom_prompt ?? args.customPrompt ?? null,
    tradingBiasRules: args.trading_bias_rules ?? args.tradingBiasRules ?? null,
    note:
      "Structured base for your own reasoning. customPrompt and tradingBiasRules are echoed here; apply them as constraints on your final call.",
    disclaimer: day.disclaimer,
  };
}

function pickBestMatch(predictions, needle) {
  if (!needle) return predictions[0] ?? null;
  const n = needle.toLowerCase().trim();
  return (
    predictions.find((p) => p.title.toLowerCase() === n) ??
    predictions.find((p) => p.title.toLowerCase().includes(n)) ??
    predictions.find((p) => n.split(/\s+/).some((w) => w.length > 3 && p.title.toLowerCase().includes(w))) ??
    predictions[0] ??
    null
  );
}

function aggregate(predictions) {
  const IMPACT_WEIGHT = { high: 1, medium: 0.6 };
  const directional = predictions.filter((p) => p.usdBias.startsWith("Bullish") || p.usdBias.startsWith("Bearish"));
  let bull = 0;
  let bear = 0;
  for (const p of directional) {
    const w = IMPACT_WEIGHT[p.impact] * (p.confidence / 100);
    if (p.usdBias.startsWith("Bullish")) bull += w;
    else bear += w;
  }
  const total = bull + bear;
  const dominant = bull === bear ? "neutral" : bull > bear ? "bullish" : "bearish";
  const dominance = total > 0 ? Math.abs(bull - bear) / total : 0;
  const aligned = directional.filter((p) => (dominant === "neutral" ? true : p.usdBias.startsWith(dominant === "bullish" ? "Bullish" : "Bearish")));
  const conflicts = directional
    .filter((p) => !aligned.includes(p) && dominant !== "neutral")
    .map((p) => ({ eventId: p.eventId, title: p.title, bias: p.usdBias, note: "Runs against the dominant direction." }));
  return {
    alignment: {
      dominantUsdBias: dominant,
      bullScore: Number(bull.toFixed(2)),
      bearScore: Number(bear.toFixed(2)),
      dominance: Number(dominance.toFixed(2)),
      aligned: aligned.map((p) => p.eventId),
      conflicts,
    },
    summary:
      directional.length === 0
        ? "No numeric directional evidence scheduled — event risk only."
        : dominant === "neutral"
          ? "Conflicting releases of similar weight — day nets out neutral."
          : dominant === "bullish"
            ? `USD likely to STRENGTHEN (${aligned.length}/${directional.length} aligned).`
            : `USD likely to WEAKEN (${aligned.length}/${directional.length} aligned).`,
    confidence: directional.length ? Math.round(Math.max(10, Math.min(85, 25 + dominance * 40 + Math.min(directional.length, 4) * 5))) : 15,
    crossAsset: {
      xauusd: dominant === "bullish" ? "Bearish XAUUSD" : dominant === "bearish" ? "Bullish XAUUSD" : "Neutral",
      eurusd: dominant === "bullish" ? "Bearish EURUSD" : dominant === "bearish" ? "Bullish EURUSD" : "mixed",
      gbpusd: dominant === "bullish" ? "Bearish GBPUSD" : dominant === "bearish" ? "Bullish GBPUSD" : "mixed",
      dxy: dominant === "bullish" ? "Bullish DXY" : dominant === "bearish" ? "Bearish DXY" : "Neutral DXY",
    },
  };
}

/* ------------------------------------------------------------------ */
/* MCP resources & prompts                                             */
/* ------------------------------------------------------------------ */

export const NEWS_RESOURCES = [
  {
    uri: "news://calendar/thisweek",
    name: "Weekly macro calendar",
    description: "High + Medium impact events for USD/EUR/GBP (XAU relevance tagged) with Jalali dates, Tehran and New York times.",
    mimeType: "application/json",
  },
  {
    uri: "news://history/index",
    name: "Historical release ledger index",
    description: "List of every tracked event series with its stored previous-value history.",
    mimeType: "application/json",
  },
];

export async function readNewsResource(env, uri) {
  if (uri === "news://calendar/thisweek") {
    const cal = await ensureNews(env, {});
    return JSON.stringify(
      {
        source: cal?.source,
        generatedAt: cal?.generatedAt,
        weekStart: cal?.weekStart,
        weekEnd: cal?.weekEnd,
        events: (cal?.events ?? []).map((e) => ({ ...formatEventTimes(e.timeIso), ...pickEventFields(e) })),
      },
      null,
      2,
    );
  }
  if (uri === "news://history/index") {
    const keys = await listHistoryKeys(env);
    const out = [];
    for (const key of keys.slice(0, 200)) {
      const raw = await env.AI_STATE.get(key);
      if (!raw) continue;
      const series = JSON.parse(raw);
      out.push({ eventKey: series.eventKey, title: series.title, currency: series.currency, points: series.points });
    }
    return JSON.stringify({ count: out.length, series: out }, null, 2);
  }
  return null;
}

function pickEventFields(e) {
  return {
    id: e.id,
    title: e.title,
    currency: e.currency,
    impact: e.impact,
    family: e.family,
    goldRelevance: e.goldRelevance,
    timeIso: e.timeIso,
    forecast: e.forecast,
    previous: e.previous,
    actual: e.actual,
  };
}

export const NEWS_PROMPTS = [
  {
    name: "premarket_daily_briefing",
    description: "Pre-market daily fundamental briefing: today's High/Medium releases with Tehran/NY times and the USD/XAU directional call.",
    arguments: [
      { name: "date", description: "Optional Tehran calendar day (YYYY-MM-DD); defaults to today.", required: false },
    ],
  },
  {
    name: "weekly_fundamental_briefing",
    description: "Weekly fundamental briefing: the whole week's calendar day by day with the non-contradiction alignment for each day.",
    arguments: [],
  },
];

export async function buildNewsPrompt(env, name, args = {}) {
  const cal = await ensureNews(env, {});
  if (name === "premarket_daily_briefing") {
    const date = args.date ?? new Intl.DateTimeFormat("en-CA", { timeZone: TZ_TEHRAN }).format(new Date());
    const day = await analyzeDay(env, date);
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Produce a pre-market fundamental briefing for ${date} (Tehran calendar day ${day.tehran?.jalaliEn ?? date}).\n` +
              `Use this structured analysis as the factual base — do not invent numbers:\n\n${JSON.stringify(day, null, 2)}\n\n` +
              `Format: 1) Today's releases with Tehran and New York times. 2) Non-contradiction check. ` +
              `3) Predicted outcome per release (Beat/Inline/Miss). 4) Final USD directional call (strengthen/weaken) with confidence, ` +
              `and the XAUUSD / EURUSD / GBPUSD cross-asset impact.`,
          },
        },
      ],
    };
  }
  if (name === "weekly_fundamental_briefing") {
    const cal2 = cal ?? { events: [] };
    const days = [...new Set((cal2.events ?? []).map((e) => formatEventTimes(e.timeIso).tehranDay))].sort();
    const daySummaries = [];
    for (const d of days) {
      try {
        const a = await analyzeDay(env, d);
        daySummaries.push({ day: d, importantEvents: a.importantEvents, dominantUsdBias: a.alignment.dominantUsdBias, confidence: a.confidence, summary: a.summary });
      } catch {
        /* skip day */
      }
    }
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Produce a week-ahead fundamental briefing for USD/EUR/GBP/XAU.\n\n` +
              `Per-day engine output (do not contradict without citing data):\n${JSON.stringify(daySummaries, null, 2)}\n\n` +
              `Full calendar:\n${JSON.stringify((cal2.events ?? []).map((e) => ({ ...formatEventTimes(e.timeIso), title: e.title, currency: e.currency, impact: e.impact, forecast: e.forecast, previous: e.previous })), null, 2)}\n\n` +
              `Format: day-by-day outlook with Jalali (Iran) dates, then a weekly USD bias summary and the key XAUUSD risk windows.`,
          },
        },
      ],
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* MCP tool formatting helpers                                         */
/* ------------------------------------------------------------------ */

export function formatEventLine(e) {
  const t = formatEventTimes(e.timeIso);
  return `${t.tehranDay} (${t.jalaliEn}) | ${t.tehranTime} Tehran / ${t.nyTime} NY | ${e.currency} ${e.impact === "high" ? "[HIGH]" : "[MED]"} | ${e.title} | prev ${e.previous ?? "—"} · fc ${e.forecast ?? "—"}${e.actual ? ` · act ${e.actual}` : ""}`;
}

export async function formatWeeklyNews(env) {
  const cal = await ensureNews(env, {});
  if (!cal || !cal.events?.length) return "No calendar data available yet. Trigger a refresh and retry.";
  const lines = [
    `Weekly macro calendar (High + Medium impact, USD/EUR/GBP; XAU relevance tagged)`,
    `Source: ${cal.source} · generated ${cal.generatedAt} · week ${cal.weekStart} → ${cal.weekEnd}`,
    "",
    ...cal.events.map(formatEventLine),
  ];
  return lines.join("\n");
}
