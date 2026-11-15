/**
 * News page — weekly macro calendar + pre-release USD/DXY prediction engine.
 * Data comes from the same Cloudflare Worker that powers the terminal:
 *   GET  /api/news/week?date=YYYY-MM-DD  events for the ISO week containing date
 *   GET  /api/news/weeks                 index of stored weeks (ledger window)
 *   GET  /api/news/day?date=YYYY-MM-DD   prediction engine for one Tehran day
 *   POST /api/news/analyze               custom analysis workspace
 *
 * View preferences (calendar system + timezone) are mutually exclusive,
 * persisted in localStorage and applied to every date rendering on the page.
 */
const WORKER = 'https://trading-llc-mcp.mahdi-t8256.workers.dev';
const PREFS_KEY = 'vaelor.news.prefs';

/* ------------------------------------------------------------------ */
/* Types (mirror of the Worker payloads)                               */
/* ------------------------------------------------------------------ */

type Impact = 'high' | 'medium';

interface NewsEvent {
  id: string;
  title: string;
  currency: string;
  impact: Impact;
  family: string;
  goldRelevance: 'direct' | 'indirect' | 'cross' | 'none';
  timeIso: string;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
}

interface AvailableWeek {
  weekStart: string;
  weekEnd: string;
  count: number;
  fetchedAt: string;
}

interface WeekPayload {
  weekStart: string;
  weekEnd: string;
  fetchedAt: string | null;
  source: string | null;
  count: number;
  events: NewsEvent[];
  availableWeeks: AvailableWeek[];
}

interface DayPrediction {
  eventId: string;
  title: string;
  currency: string;
  impact: Impact;
  timeIso: string;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  family: string;
  predictedOutcome: 'Beat' | 'Inline' | 'Miss' | null;
  predictedDirection: string | null;
  usdBias: string;
  xauImpact: string;
  confidence: number;
  rationale: string;
  historyPoints: number;
  history: { date: string; value: string }[];
}

interface CrossAsset {
  xauusd: string;
  eurusd: string;
  gbpusd: string;
  dxy?: string;
}

interface DayAnalysis {
  day: string;
  tehran: { jalaliEn?: string; tehranTime?: string };
  eventsScheduled: number;
  importantEvents: number;
  predictions: DayPrediction[];
  alignment: {
    dominantUsdBias: 'bullish' | 'bearish' | 'neutral';
    bullScore: number;
    bearScore: number;
    aligned: string[];
    conflicts: { eventId: string; title: string; bias: string; note: string }[];
    neutralEvents: { eventId: string; title: string; note: string }[];
  };
  summary: string;
  confidence: number;
  crossAsset: CrossAsset;
  disclaimer: string;
}

interface CustomAnalysis extends DayAnalysis {
  baseAnalysis: { predictions: DayPrediction[] };
  scenario: {
    applied: boolean;
    title: string;
    hypotheticalActual: string;
    predictedOutcome: string;
    usdBias: string;
    note: string;
  } | null;
  customPrompt: string | null;
  tradingBiasRules: string | null;
  note: string;
}

/* ------------------------------------------------------------------ */
/* View preferences: calendar + timezone (mutually exclusive)          */
/* ------------------------------------------------------------------ */

type CalendarKind = 'gregorian' | 'jalali';
type TimeZoneKind = 'Asia/Tehran' | 'America/New_York';

interface ViewPrefs {
  calendar: CalendarKind;
  tz: TimeZoneKind;
}

const DEFAULT_PREFS: ViewPrefs = { calendar: 'gregorian', tz: 'Asia/Tehran' };
let viewPrefs: ViewPrefs = loadPrefs();

function loadPrefs(): ViewPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<ViewPrefs>;
    return {
      calendar: parsed.calendar === 'jalali' ? 'jalali' : 'gregorian',
      tz: parsed.tz === 'America/New_York' ? 'America/New_York' : 'Asia/Tehran',
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(viewPrefs));
  } catch {
    /* private mode — prefs stay in memory */
  }
}

/** Locale used for human-facing labels under the active calendar. */
function prefLocale(): string {
  return viewPrefs.calendar === 'jalali'
    ? 'fa-IR-u-ca-persian'
    : viewPrefs.tz === 'America/New_York'
      ? 'en-US'
      : 'en-GB';
}

/** Sortable calendar-day key in the selected timezone/calendar. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '9999-99-99';
  if (viewPrefs.calendar === 'jalali') {
    const parts = new Intl.DateTimeFormat('en-US-u-ca-persian', {
      timeZone: viewPrefs.tz,
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value.padStart(2, '0') ?? '00';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: viewPrefs.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Weekday label under the active calendar/timezone. */
function weekdayLabel(iso: string): string {
  return new Intl.DateTimeFormat(prefLocale(), { timeZone: viewPrefs.tz, weekday: 'long' }).format(new Date(iso));
}

/** Full date label under the active calendar/timezone. */
function dateLabel(iso: string): string {
  return new Intl.DateTimeFormat(prefLocale(), {
    timeZone: viewPrefs.tz,
    day: 'numeric',
    month: 'long',
    year: viewPrefs.calendar === 'jalali' ? 'numeric' : 'numeric',
  }).format(new Date(iso));
}

/** Short week label pieces for pager + table headers. */
function shortDateLabel(iso: string): string {
  const locale = viewPrefs.calendar === 'jalali' ? 'fa-IR-u-ca-persian' : 'en-GB';
  return new Intl.DateTimeFormat(locale, {
    timeZone: viewPrefs.tz,
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
}

function yearLabel(iso: string): string {
  return new Intl.DateTimeFormat(viewPrefs.calendar === 'jalali' ? 'fa-IR-u-ca-persian' : 'en-GB', {
    timeZone: viewPrefs.tz,
    year: 'numeric',
  }).format(new Date(iso));
}

/** Time in the selected timezone, HH:MM. */
function timeLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: viewPrefs.tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function tzShort(): string {
  return viewPrefs.tz === 'America/New_York'
    ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value ?? 'ET'
    : 'IRST';
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

let events: NewsEvent[] = [];
let availableWeeks: AvailableWeek[] = [];
let weekOffset = 0;
let loadingWeek = false;
let customBusy = false;
let selectedDay: string | null = null;
const filterState = { asset: 'all', impact: 'all', day: 'all' };

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Monday (UTC) of the ISO week containing `date`. */
function isoWeekMonday(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d;
}

function weekDateForOffset(offset: number): string {
  const monday = isoWeekMonday(new Date());
  monday.setUTCDate(monday.getUTCDate() + offset * 7);
  return monday.toISOString().slice(0, 10);
}

function weekRangeLabel(weekStart: string, weekEnd: string): string {
  const start = `${weekStart}T12:00:00Z`;
  const end = `${weekEnd}T12:00:00Z`;
  const startShort = shortDateLabel(start);
  const endShort = shortDateLabel(end);
  const sameYear = yearLabel(start) === yearLabel(end);
  const sameMonth = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short' }).format(new Date(start))
    === new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short' }).format(new Date(end));
  const locale = viewPrefs.calendar === 'jalali' ? 'fa-IR-u-ca-persian' : 'en-GB';
  const startDay = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric' }).format(new Date(start));
  const endDayOnly = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric' }).format(new Date(end));
  const startMonth = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'short' }).format(new Date(start));
  const range = sameYear && sameMonth
    ? `${startDay} – ${endDayOnly} ${startMonth} ${yearLabel(end)}`
    : `${startShort} – ${endShort} ${yearLabel(end)}`;
  return range;
}

function isTodayWeek(offset: number): boolean {
  return offset === 0;
}

/* ------------------------------------------------------------------ */
/* Clocks (Tehran + New York, live)                                    */
/* ------------------------------------------------------------------ */

function tickClocks(): void {
  const now = new Date();
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(now);
  const t = el('tehranClock');
  const n = el('nyClock');
  if (t) t.textContent = fmt('Asia/Tehran');
  if (n) n.textContent = fmt('America/New_York');
}

/* ------------------------------------------------------------------ */
/* Calendar rendering                                                  */
/* ------------------------------------------------------------------ */

function visibleEvents(): NewsEvent[] {
  return events.filter((e) => {
    if (filterState.asset === 'USD' || filterState.asset === 'DXY') {
      if (e.currency !== 'USD') return false;
    } else if (filterState.asset === 'XAU') {
      if (e.goldRelevance === 'none') return false;
    } else if (filterState.asset !== 'all') {
      if (e.currency !== filterState.asset) return false;
    }
    if (filterState.impact !== 'all' && e.impact !== filterState.impact) return false;
    if (filterState.day !== 'all' && dayKey(e.timeIso) !== filterState.day) return false;
    return true;
  });
}

function eventRow(e: NewsEvent): string {
  const goldTag =
    e.goldRelevance === 'direct'
      ? '<span class="nw-goldtag" title="Directly drives XAUUSD liquidity and volatility">XAU driver</span>'
      : e.goldRelevance === 'indirect' && e.currency === 'USD'
        ? '<span class="nw-goldtag nw-goldtag-soft" title="High-impact USD event — indirect gold pressure">XAU·indirect</span>'
        : '';
  const actual = e.actual ? `<span class="nw-actual">act ${esc(e.actual)}</span>` : '';
  return `
  <tr>
    <td class="nw-time">
      <span class="nw-t-main">${esc(timeLabel(e.timeIso))} <small>${esc(tzShort())}</small></span>
    </td>
    <td class="nw-event">
      <div class="nw-event-line">
        <span class="nw-impact nw-impact-${esc(e.impact)}" title="${
          e.impact === 'high' ? 'High impact · Red folder' : 'Medium impact · Orange folder'
        }" role="img" aria-label="${e.impact === 'high' ? 'High impact' : 'Medium impact'}"></span>
        <strong>${esc(e.title)}</strong>${goldTag}
      </div>
      <div class="nw-sub">${esc(weekdayLabel(e.timeIso))} · ${esc(dateLabel(e.timeIso))}</div>
    </td>
    <td><span class="nw-cur nw-cur-${esc(e.currency.toLowerCase())}">${esc(e.currency)}</span></td>
    <td><span class="nw-badge nw-badge-${esc(e.impact)}">${e.impact === 'high' ? 'High · Red' : 'Medium · Orange'}</span></td>
    <td class="nw-num">${esc(e.previous ?? '—')}</td>
    <td class="nw-num">${esc(e.forecast ?? '—')}</td>
    <td class="nw-num">${e.actual ? esc(e.actual) : '—'}</td>
  </tr>`;
}

function groupedEntries(): { day: string; rows: NewsEvent[] }[] {
  const rows = visibleEvents();
  const days = [...new Set(rows.map((e) => dayKey(e.timeIso)))].sort();
  return days.map((day) => ({ day, rows: rows.filter((e) => dayKey(e.timeIso) === day) }));
}

function renderCalendar(): void {
  const wrap = el('newsTableBody');
  if (!wrap) return;
  const groups = groupedEntries();
  const shown = groups.reduce((acc, g) => acc + g.rows.length, 0);
  const html: string[] = [];
  for (const { day, rows } of groups) {
    const first = rows[0];
    html.push(
      `<tr class="nw-dayrow"><td colspan="7">` +
        `<span class="nw-day-jalali">${esc(weekdayLabel(first.timeIso))}, ${esc(dateLabel(first.timeIso))}</span>` +
        `<span class="nw-day-en">${esc(day)}</span>` +
        `<span class="nw-day-count">${rows.length} event${rows.length === 1 ? '' : 's'}</span>` +
      `</td></tr>`,
    );
    html.push(...rows.map(eventRow));
  }
  wrap.innerHTML = html.length
    ? html.join('')
    : '<tr><td colspan="7" class="nw-empty">No stored releases for this week yet — the ledger fills as releases sync; future weeks appear once they enter the weekly sync.</td></tr>';

  const counts = el('filterCounts');
  if (counts) counts.textContent = `${shown} of ${events.length} events shown`;
}

/* ------------------------------------------------------------------ */
/* Week navigation                                                     */
/* ------------------------------------------------------------------ */

function renderWeekPager(): void {
  const mono = el('weekBig');
  const range = el('weekRange');
  const back = el('thisWeekBtn');
  const weekDate = weekDateForOffset(weekOffset);
  // Monday of the target week → Sunday; fetch range or reuse Monday label.
  const start = new Date(`${weekDate}T00:00:00Z`);
  const end = new Date(start.getTime() + 6 * 86400e3);
  const weekStart = start.toISOString().slice(0, 10);
  const weekEnd = end.toISOString().slice(0, 10);
  if (mono) {
    mono.textContent = weekOffset === 0 ? 'This Week' : weekOffset === 1 ? 'Next Week' : weekOffset === -1 ? 'Last Week' : 'Future Week';
  }
  if (range) range.textContent = weekRangeLabel(weekStart, weekEnd);
  if (back) back.hidden = weekOffset === 0;
}

async function loadWeek(offset: number): Promise<void> {
  if (loadingWeek) return;
  loadingWeek = true;
  const date = weekDateForOffset(offset);
  const status = el('connectionStatus');
  if (status) status.textContent = 'LOADING WEEK…';
  try {
    const payload = await getJson<WeekPayload>(`${WORKER}/api/news/week?date=${encodeURIComponent(date)}`);
    events = payload.events ?? [];
    availableWeeks = payload.availableWeeks ?? availableWeeks;
    weekOffset = offset;
    renderWeekPager();
    renderDayFilterOptions();
    renderCalendar();
    renderStats(payload);
    if (status) status.textContent = 'LIVE · WORKER CONNECTED';
    const dot = el('statusDot');
    if (dot) dot.classList.add('on');
    const gen = el('weekLabel');
    if (gen) {
      gen.textContent = payload.fetchedAt
        ? `Source: ${payload.source ?? 'weekly ledger'} · synced ${new Intl.DateTimeFormat(prefLocale(), {
            timeZone: viewPrefs.tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
          }).format(new Date(payload.fetchedAt))}`
        : 'Ledger has no data for this week yet.';
    }
  } catch (e) {
    events = [];
    weekOffset = offset;
    renderWeekPager();
    renderDayFilterOptions();
    renderCalendar();
    if (status) status.textContent = `OFFLINE · ${(e as Error).message}`;
    const dot = el('statusDot');
    if (dot) dot.classList.remove('on');
  } finally {
    loadingWeek = false;
  }
}

function renderStats(payload: WeekPayload): void {
  const high = events.filter((e) => e.impact === 'high').length;
  const medium = events.filter((e) => e.impact === 'medium').length;
  const now = Date.now();
  const next = events
    .filter((e) => Date.parse(e.timeIso) > now)
    .sort((a, b) => Date.parse(a.timeIso) - Date.parse(b.timeIso))[0];
  const set = (id: string, v: string) => {
    const n = el(id);
    if (n) n.textContent = v;
  };
  set('highCount', String(high));
  set('mediumCount', String(medium));
  set('storedWeeks', String(availableWeeks.length || 1));
  if (next) {
    set('nextEvent', `${next.currency} ${timeLabel(next.timeIso)}`);
    set('nextEventTime', `${next.title} · ${dateLabel(next.timeIso)}`);
  } else {
    set('nextEvent', '—');
    set('nextEventTime', 'No upcoming watched events in this week');
  }
  // ledger window hint
  const hint = el('ledgerHint');
  if (hint && availableWeeks.length) {
    const oldest = availableWeeks[0];
    const newest = availableWeeks[availableWeeks.length - 1];
    hint.textContent = `${availableWeeks.length} stored week(s): ${oldest.weekStart} → ${newest.weekStart} · rolling ~3-month retention`;
  } else if (hint) {
    hint.textContent = 'Ledger started 2026-11-15 and gains one week per sync; binding a free FinancialModelingPrep API key (FMP_API_KEY worker secret) backfills ~3 months instantly.';
  }
}

/* ------------------------------------------------------------------ */
/* Day-of-week filter (rebuilt under active prefs + week)              */
/* ------------------------------------------------------------------ */

function renderDayFilterOptions(): void {
  const sel = el('filterDay') as HTMLSelectElement | null;
  if (!sel) return;
  const previous = sel.value;
  const days = [...new Set(events.map((e) => dayKey(e.timeIso)))].sort();
  sel.innerHTML =
    '<option value="all">All days</option>' +
    days
      .map((k) => {
        const sample = events.find((e) => dayKey(e.timeIso) === k);
        return `<option value="${esc(k)}">${esc(weekdayLabel(sample!.timeIso))} · ${esc(dateLabel(sample!.timeIso))}</option>`;
      })
      .join('');
  sel.value = days.includes(previous) ? previous : 'all';
  filterState.day = sel.value;
}

/* ------------------------------------------------------------------ */
/* Prediction engine panel                                             */
/* ------------------------------------------------------------------ */

function engineDayOptions(): string[] {
  const fromWeek = [...new Set(events.map((e) => e.timeIso.slice(0, 10)))];
  const base = fromWeek.length ? fromWeek : [];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date());
  return [...new Set([...base, today])].sort();
}

function todayTehran(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date());
}

function renderDaySelector(): void {
  const sel = el('daySelect') as HTMLSelectElement | null;
  if (!sel) return;
  const options = engineDayOptions();
  const today = todayTehran();
  const previous = selectedDay ?? (options.includes(today) ? today : (options[0] ?? null));
  selectedDay = previous;
  sel.innerHTML =
    options
      .map((isoDay) => {
        const anchor = `${isoDay}T12:00:00Z`;
        return `<option value="${esc(isoDay)}" ${isoDay === selectedDay ? 'selected' : ''}>${esc(dateLabel(anchor))} · ${esc(weekdayLabel(anchor))}</option>`;
      })
      .join('') || `<option value="">No events stored yet</option>`;
}

function biasChip(bias: string): string {
  if (bias.startsWith('Bullish')) return '<span class="nw-dir nw-bull">Bullish USD</span>';
  if (bias.startsWith('Bearish')) return '<span class="nw-dir nw-bear">Bearish USD</span>';
  if (bias.startsWith('Neutral')) return '<span class="nw-dir nw-neutral">Neutral USD</span>';
  return `<span class="nw-dir nw-risk">${esc(bias)}</span>`;
}

function dxyLabel(cross: CrossAsset): string {
  return cross.dxy ?? 'Neutral DXY';
}

function renderDayAnalysis(a: DayAnalysis): void {
  const wrap = el('dayAnalysis');
  if (!wrap) return;
  const conf = a.confidence;
  const confClass = conf >= 60 ? 'high' : conf >= 35 ? 'mid' : 'low';
  const bias = a.alignment.dominantUsdBias;

  const predictions = a.predictions
    .map((p) => {
      const outcome =
        p.predictedOutcome === 'Beat'
          ? '<span class="nw-outcome nw-out-beat">Beat</span>'
          : p.predictedOutcome === 'Miss'
            ? '<span class="nw-outcome nw-out-miss">Miss</span>'
            : p.predictedOutcome === 'Inline'
              ? '<span class="nw-outcome nw-out-inline">Inline</span>'
              : '<span class="nw-outcome nw-out-none">Event risk</span>';
      const hist = p.history?.length
        ? `<div class="nw-hist">History (${p.historyPoints}): ${p.history
            .slice(-4)
            .map((h) => `<span>${esc(h.date.slice(5, 10))} <b>${esc(String(h.value))}</b></span>`)
            .join('')}</div>`
        : '';
      return `<li class="nw-pred">
        <div class="nw-pred-head">
          <span class="nw-impact nw-impact-${esc(p.impact)}" role="img" aria-label="${p.impact === 'high' ? 'High impact' : 'Medium impact'}"></span>
          <strong>${esc(p.title)}</strong>
          <span class="nw-cur nw-cur-${esc(p.currency.toLowerCase())}">${esc(p.currency)}</span>
          <span class="nw-fc">prev ${esc(p.previous ?? '—')} · fc ${esc(p.forecast ?? '—')}${p.actual ? ` · act ${esc(p.actual)}` : ''}</span>
          ${outcome}
          ${biasChip(p.usdBias)}
          <span class="nw-conf nw-conf-${p.confidence >= 60 ? 'high' : p.confidence >= 35 ? 'mid' : 'low'}">${p.confidence}%</span>
        </div>
        <p class="nw-why">${esc(p.rationale)}</p>
        ${p.currency === 'USD' ? `<p class="nw-xau">${esc(p.xauImpact)}</p>` : ''}
        ${hist}
      </li>`;
    })
    .join('');

  const conflicts = a.alignment.conflicts.length
    ? a.alignment.conflicts.map((c) => `<li><b>${esc(c.title)}</b> — ${esc(c.bias)}. ${esc(c.note)}</li>`).join('')
    : '';

  const dayAnchor = `${a.day}T12:00:00Z`;
  wrap.innerHTML = `
    <div class="nw-dayhead">
      <div>
        <div class="nw-kicker">Pre-release fundamental engine · ${esc(a.day)}</div>
        <h3 class="nw-daytitle">${esc(weekdayLabel(dayAnchor))}, ${esc(dateLabel(dayAnchor))}</h3>
        <p class="nw-daymeta">${a.eventsScheduled} watched events · ${a.importantEvents} High/Medium</p>
      </div>
      <div class="nw-verdict nw-verdict-${esc(bias)}">
        <div class="nw-verdict-label">USD / DXY DAY CALL</div>
        <div class="nw-verdict-value">${bias === 'bullish' ? 'USD STRENGTHENS' : bias === 'bearish' ? 'USD WEAKENS' : 'NEUTRAL / CONFLICTED'}</div>
        <div class="nw-verdict-conf">confidence <b>${conf}%</b> · <b>${esc(dxyLabel(a.crossAsset))}</b></div>
        <div class="nw-confbar"><span class="nw-confbar-fill nw-confbar-${esc(confClass)}" style="width:${conf}%"></span></div>
      </div>
    </div>
    <p class="nw-daysummary">${esc(a.summary)}</p>
    <ul class="nw-preds">${predictions || '<li class="nw-empty">No High/Medium events on this day.</li>'}</ul>
    ${conflicts ? `<div class="nw-conflictbox"><b>Non-contradiction filter — conflicts flagged:</b><ul>${conflicts}</ul></div>` : ''}
    <div class="nw-cross">
      <div><span>XAUUSD</span>${esc(a.crossAsset.xauusd)}</div>
      <div><span>DXY</span>${esc(dxyLabel(a.crossAsset))}</div>
      <div><span>EURUSD</span>${esc(a.crossAsset.eurusd)}</div>
      <div><span>GBPUSD</span>${esc(a.crossAsset.gbpusd)}</div>
    </div>
    <p class="nw-disclaimer">${esc(a.disclaimer)}</p>`;
}

async function loadDayAnalysis(): Promise<void> {
  const wrap = el('dayAnalysis');
  if (!wrap || !selectedDay) return;
  wrap.innerHTML = '<p class="nw-loading">Running the fundamental engine…</p>';
  try {
    const a = await getJson<DayAnalysis>(`${WORKER}/api/news/day?date=${encodeURIComponent(selectedDay)}`);
    renderDayAnalysis(a);
  } catch (e) {
    wrap.innerHTML = `<p class="nw-error">Engine unavailable: ${esc((e as Error).message)}. The Worker syncs the calendar every few minutes — retry shortly.</p>`;
  }
}

/* ------------------------------------------------------------------ */
/* Custom AI analysis workspace                                        */
/* ------------------------------------------------------------------ */

function renderCustomResult(c: CustomAnalysis): void {
  const wrap = el('customResult');
  if (!wrap) return;
  const scenario = c.scenario
    ? `<div class="nw-scenario">Scenario applied: <b>${esc(c.scenario.title)}</b> hypothetical actual <b>${esc(c.scenario.hypotheticalActual)}</b> → ${esc(c.scenario.predictedOutcome)} · ${esc(c.scenario.usdBias)}</div>`
    : '';
  const preds = c.baseAnalysis.predictions
    .map(
      (p) =>
        `<li><b>${esc(p.title)}</b> (${esc(p.currency)}) — ${esc(p.predictedOutcome ?? 'event risk')} · ${esc(p.usdBias)} · ${p.confidence}%<br><small>${esc(p.rationale)}</small></li>`,
    )
    .join('');
  const dxy = dxyLabel(c.crossAsset);
  wrap.innerHTML = `
    <div class="nw-verdict nw-verdict-${esc(c.alignment.dominantUsdBias)}" style="max-width:420px">
      <div class="nw-verdict-label">USD / DXY CALL · CUSTOM SCENARIO</div>
      <div class="nw-verdict-value">${c.alignment.dominantUsdBias === 'bullish' ? 'USD STRENGTHENS' : c.alignment.dominantUsdBias === 'bearish' ? 'USD WEAKENS' : 'NEUTRAL / CONFLICTED'}</div>
      <div class="nw-verdict-conf">confidence <b>${c.confidence}%</b> · <b>${esc(dxy)}</b></div>
    </div>
    ${scenario}
    <p class="nw-daysummary">${esc(c.summary)}</p>
    <ul class="nw-preds">${preds}</ul>
    ${c.tradingBiasRules ? `<p class="nw-note">Your rules: <b>${esc(c.tradingBiasRules)}</b></p>` : ''}
    <div class="nw-cross">
      <div><span>XAUUSD</span>${esc(c.crossAsset.xauusd)}</div>
      <div><span>DXY</span>${esc(dxy)}</div>
      <div><span>EURUSD</span>${esc(c.crossAsset.eurusd)}</div>
      <div><span>GBPUSD</span>${esc(c.crossAsset.gbpusd)}</div>
    </div>
    <p class="nw-disclaimer">${esc(c.note)} ${esc(c.disclaimer)}</p>`;
}

async function runCustomAnalysis(): Promise<void> {
  if (customBusy) return;
  const btn = el('runCustomBtn') as HTMLButtonElement | null;
  customBusy = true;
  if (btn) btn.disabled = true;
  try {
    const prompt = (el('customPrompt') as HTMLTextAreaElement | null)?.value.trim() || null;
    const hypValue = (el('hypotheticalActual') as HTMLInputElement | null)?.value.trim() || null;
    const hypTitle = (el('hypotheticalEvent') as HTMLInputElement | null)?.value.trim() || null;
    const rules = (el('biasRules') as HTMLTextAreaElement | null)?.value.trim() || null;
    const targetAsset = (el('targetAsset') as HTMLSelectElement | null)?.value || null;
    const daySel = el('customDay') as HTMLSelectElement | null;
    const day = daySel?.value || selectedDay || todayTehran();
    const body: Record<string, unknown> = { date: day };
    if (prompt) body.custom_prompt = prompt;
    if (rules) body.trading_bias_rules = rules;
    if (targetAsset && targetAsset !== 'all') body.target_asset = targetAsset;
    if (hypValue) body.hypothetical_actual = hypTitle ? { eventTitle: hypTitle, value: hypValue } : hypValue;
    const res = await fetch(`${WORKER}/api/news/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderCustomResult((await res.json()) as CustomAnalysis);
  } catch (e) {
    const wrap = el('customResult');
    if (wrap) wrap.innerHTML = `<p class="nw-error">Custom analysis failed: ${esc((e as Error).message)}</p>`;
  } finally {
    customBusy = false;
    if (btn) btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Toggles (mutually exclusive radio groups)                           */
/* ------------------------------------------------------------------ */

function renderToggles(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-calendar]').forEach((btn) => {
    const on = btn.dataset.calendar === viewPrefs.calendar;
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.classList.toggle('is-active', on);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-tz]').forEach((btn) => {
    const on = btn.dataset.tz === viewPrefs.tz;
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.classList.toggle('is-active', on);
  });
}

function wireToggles(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-calendar]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (viewPrefs.calendar === btn.dataset.calendar) return;
      viewPrefs = { ...viewPrefs, calendar: btn.dataset.calendar === 'jalali' ? 'jalali' : 'gregorian' };
      savePrefs();
      renderToggles();
      refreshPrefsView();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-tz]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (viewPrefs.tz === btn.dataset.tz) return;
      viewPrefs = { ...viewPrefs, tz: btn.dataset.tz === 'America/New_York' ? 'America/New_York' : 'Asia/Tehran' };
      savePrefs();
      renderToggles();
      refreshPrefsView();
    });
  });
}

/** Re-render every prefs-dependent region without refetching. */
function refreshPrefsView(): void {
  renderDayFilterOptions();
  renderWeekPager();
  renderCalendar();
  renderDaySelector();
  void loadDayAnalysis();
}

/* ------------------------------------------------------------------ */
/* Tabs (quick-action buttons, ARIA tablist)                           */
/* ------------------------------------------------------------------ */

function wireTabs(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"][data-tab]'));
  if (!tabs.length) return;
  const activate = (tab: HTMLButtonElement, focus = true) => {
    const target = tab.dataset.tab;
    for (const t of Array.from(tabs)) {
      const on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.classList.toggle('is-active', on);
      t.tabIndex = on ? 0 : -1;
    }
    document.querySelectorAll<HTMLElement>('[role="tabpanel"]').forEach((panel) => {
      panel.hidden = panel.id !== `nw-panel-${target}`;
    });
    if (focus) tab.focus();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => activate(tab, false));
    tab.addEventListener('keydown', (event: KeyboardEvent) => {
      let next: number | null = null;
      if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      if (next === null) return;
      event.preventDefault();
      activate(tabs[next], true);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Filter wiring                                                       */
/* ------------------------------------------------------------------ */

function wireFilters(): void {
  for (const [id, key] of [
    ['filterCurrency', 'asset'],
    ['filterImpact', 'impact'],
    ['filterDay', 'day'],
  ] as const) {
    const sel = el(id) as HTMLSelectElement | null;
    if (!sel) continue;
    sel.addEventListener('change', () => {
      filterState[key] = sel.value;
      renderCalendar();
    });
  }
  const daySel = el('daySelect') as HTMLSelectElement | null;
  daySel?.addEventListener('change', () => {
    selectedDay = daySel.value || null;
    void loadDayAnalysis();
  });
  el('runCustomBtn')?.addEventListener('click', () => void runCustomAnalysis());
  el('refreshBtn')?.addEventListener('click', () => {
    void (async () => {
      try {
        const res = await fetch(`${WORKER}/api/news/refresh`, { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch {
        /* fall through to local reload either way */
      }
      await loadWeek(weekOffset);
    })();
  });
  el('prevWeekBtn')?.addEventListener('click', () => void loadWeek(weekOffset - 1));
  el('nextWeekBtn')?.addEventListener('click', () => void loadWeek(weekOffset + 1));
  el('thisWeekBtn')?.addEventListener('click', () => void loadWeek(0));
}

/* ------------------------------------------------------------------ */
/* Mount                                                               */
/* ------------------------------------------------------------------ */

export function mountNews(): void {
  if (!el('newsPage')) return;
  tickClocks();
  window.setInterval(tickClocks, 1000);
  renderToggles();
  wireToggles();
  wireTabs();
  wireFilters();
  renderDaySelector();
  void loadWeek(0).then(() => {
    renderDaySelector();
    renderCustomDayOptions();
    void loadDayAnalysis();
  });
}

function renderCustomDayOptions(): void {
  const sel = el('customDay') as HTMLSelectElement | null;
  if (!sel) return;
  const options = engineDayOptions();
  sel.innerHTML = options
    .map((isoDay) => {
      const anchor = `${isoDay}T12:00:00Z`;
      return `<option value="${esc(isoDay)}">${esc(dateLabel(anchor))} · ${esc(weekdayLabel(anchor))}</option>`;
    })
    .join('');
  const today = todayTehran();
  if (options.includes(today)) sel.value = today;
}
