/**
 * News page — weekly macro calendar + pre-release USD/XAU prediction engine.
 * Data comes from the same Cloudflare Worker that powers the terminal:
 *   GET  /api/news/calendar   weekly High/Medium calendar (Jalali + Tehran + NY)
 *   GET  /api/news/day        deterministic prediction engine for one Tehran day
 *   POST /api/news/analyze    custom analysis (prompt / hypothetical actual / rules)
 */
const WORKER = 'https://trading-llc-mcp.mahdi-t8256.workers.dev';

/* ------------------------------------------------------------------ */
/* Types (mirror of the Worker payloads)                               */
/* ------------------------------------------------------------------ */

interface NewsEvent {
  id: string;
  title: string;
  currency: string;
  impact: 'high' | 'medium';
  family: string;
  goldRelevance: 'direct' | 'indirect' | 'cross' | 'none';
  timeIso: string;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  tehranDay: string;
  jalali: string;
  jalaliFa: string;
  tehranTime: string;
  nyTime: string;
  weekdayEn: string;
}

interface DayPrediction {
  eventId: string;
  title: string;
  currency: string;
  impact: 'high' | 'medium';
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

interface DayAnalysis {
  day: string;
  tehran: { jalaliEn?: string; jalaliFa?: string; tehranTime?: string };
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
  crossAsset: { xauusd: string; eurusd: string; gbpusd: string };
  disclaimer: string;
}

interface CustomAnalysis extends DayAnalysis {
  baseAnalysis: { predictions: DayPrediction[] };
  scenario: { applied: boolean; title: string; hypotheticalActual: string; predictedOutcome: string; usdBias: string; note: string } | null;
  customPrompt: string | null;
  tradingBiasRules: string | null;
  note: string;
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

let events: NewsEvent[] = [];
const filterState = { currency: 'all', impact: 'all', day: 'all' };
let selectedDay: string | null = null;
let customBusy = false;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* Clocks (Tehran + New York, live)                                    */
/* ------------------------------------------------------------------ */

function tickClocks(): void {
  const now = new Date();
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
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
    if (filterState.currency !== 'all') {
      if (filterState.currency === 'XAU') {
        if (e.goldRelevance === 'none') return false;
      } else if (e.currency !== filterState.currency) return false;
    }
    if (filterState.impact !== 'all' && e.impact !== filterState.impact) return false;
    if (filterState.day !== 'all' && e.tehranDay !== filterState.day) return false;
    return true;
  });
}

function eventRow(e: NewsEvent): string {
  const goldTag =
    e.goldRelevance === 'direct'
      ? '<span class="nw-goldtag" title="Directly drives XAUUSD liquidity and volatility">XAU driver</span>'
      : e.currency === 'USD' && e.goldRelevance === 'indirect'
        ? '<span class="nw-goldtag nw-goldtag-soft" title="High-impact USD event — indirect gold pressure">XAU·indirect</span>'
        : '';
  const actual = e.actual
    ? `<span class="nw-actual">act ${esc(e.actual)}</span>`
    : '';
  return `
  <tr data-event-day="${esc(e.tehranDay)}">
    <td class="nw-time">
      <span class="nw-t-main">${esc(e.tehranTime)} <small>Tehran</small></span>
      <span class="nw-t-alt">${esc(e.nyTime)} <small>NY</small></span>
    </td>
    <td class="nw-event">
      <div class="nw-event-line">
        <span class="nw-impact nw-impact-${esc(e.impact)}" title="${e.impact === 'high' ? 'High impact · Red folder' : 'Medium impact · Orange folder'}"></span>
        <strong>${esc(e.title)}</strong>${goldTag}
      </div>
      <div class="nw-sub">${esc(e.jalaliFa)} · ${esc(e.jalali)}</div>
    </td>
    <td><span class="nw-cur nw-cur-${esc(e.currency.toLowerCase())}">${esc(e.currency)}</span></td>
    <td><span class="nw-badge nw-badge-${esc(e.impact)}">${e.impact === 'high' ? 'High · Red' : 'Medium · Orange'}</span></td>
    <td class="nw-num">${esc(e.previous ?? '—')}</td>
    <td class="nw-num">${esc(e.forecast ?? '—')}</td>
    <td class="nw-num">${esc(e.actual ?? '—')}</td>
  </tr>`;
}

function renderCalendar(): void {
  const wrap = el('newsTableBody');
  if (!wrap) return;
  const rows = visibleEvents();
  const days = [...new Set(rows.map((e) => e.tehranDay))].sort();
  const html: string[] = [];
  for (const day of days) {
    const dayEvents = rows.filter((e) => e.tehranDay === day);
    const first = dayEvents[0];
    html.push(
      `<tr class="nw-dayrow"><td colspan="7">` +
        `<span class="nw-day-jalali">${esc(first.jalaliFa)}</span>` +
        `<span class="nw-day-en">${esc(first.weekdayEn)} · ${esc(first.jalali)} · ${esc(day)}</span>` +
        `<span class="nw-day-count">${dayEvents.length} event${dayEvents.length === 1 ? '' : 's'}</span>` +
      `</td></tr>`,
    );
    html.push(...dayEvents.map(eventRow));
  }
  wrap.innerHTML = html.length
    ? html.join('')
    : '<tr><td colspan="7" class="nw-empty">No events match the current filters.</td></tr>';

  const counts = el('filterCounts');
  if (counts) counts.textContent = `${rows.length} of ${events.length} events shown`;
}

/* ------------------------------------------------------------------ */
/* Prediction engine panel                                             */
/* ------------------------------------------------------------------ */

function dayOptions(): string[] {
  return [...new Set(events.map((e) => e.tehranDay))].sort();
}

function todayTehran(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date());
}

function renderDaySelector(): void {
  const sel = el('daySelect') as HTMLSelectElement | null;
  if (!sel) return;
  const days = dayOptions();
  const today = todayTehran();
  const previous = selectedDay ?? (days.includes(today) ? today : (days.find((d) => d >= today) ?? days[0] ?? null));
  selectedDay = previous;
  sel.innerHTML =
    days
      .map((d) => {
        const sample = events.find((e) => e.tehranDay === d);
        return `<option value="${esc(d)}" ${d === selectedDay ? 'selected' : ''}>${esc(sample?.jalaliFa ?? d)} · ${esc(d)}</option>`;
      })
      .join('') || '<option value="">No events this week</option>';
}

function biasChip(bias: string): string {
  if (bias.startsWith('Bullish')) return '<span class="nw-dir nw-bull">Bullish USD</span>';
  if (bias.startsWith('Bearish')) return '<span class="nw-dir nw-bear">Bearish USD</span>';
  if (bias.startsWith('Neutral')) return '<span class="nw-dir nw-neutral">Neutral USD</span>';
  return `<span class="nw-dir nw-risk">${esc(bias)}</span>`;
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
          <span class="nw-impact nw-impact-${esc(p.impact)}"></span>
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

  wrap.innerHTML = `
    <div class="nw-dayhead">
      <div>
        <div class="nw-kicker">Pre-release fundamental engine · ${esc(a.day)}</div>
        <h3 class="nw-daytitle">${esc(a.tehran?.jalaliEn ?? a.day)}</h3>
        <p class="nw-daymeta">${a.eventsScheduled} watched events · ${a.importantEvents} High/Medium · ${esc(a.tehran?.jalaliFa ?? '')}</p>
      </div>
      <div class="nw-verdict nw-verdict-${esc(bias)}">
        <div class="nw-verdict-label">USD DAY CALL</div>
        <div class="nw-verdict-value">${bias === 'bullish' ? 'USD STRENGTHENS' : bias === 'bearish' ? 'USD WEAKENS' : 'NEUTRAL / CONFLICTED'}</div>
        <div class="nw-verdict-conf">confidence <b>${conf}%</b></div>
        <div class="nw-confbar"><span class="nw-confbar-fill nw-confbar-${esc(confClass)}" style="width:${conf}%"></span></div>
      </div>
    </div>
    <p class="nw-daysummary">${esc(a.summary)}</p>
    <ul class="nw-preds">${predictions || '<li class="nw-empty">No High/Medium events on this day.</li>'}</ul>
    ${conflicts ? `<div class="nw-conflictbox"><b>Non-contradiction filter — conflicts flagged:</b><ul>${conflicts}</ul></div>` : ''}
    <div class="nw-cross">
      <div><span>XAUUSD</span>${esc(a.crossAsset.xauusd)}</div>
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
  wrap.innerHTML = `
    <div class="nw-verdict nw-verdict-${esc(c.alignment.dominantUsdBias)}" style="max-width:420px">
      <div class="nw-verdict-label">USD CALL · CUSTOM SCENARIO</div>
      <div class="nw-verdict-value">${c.alignment.dominantUsdBias === 'bullish' ? 'USD STRENGTHENS' : c.alignment.dominantUsdBias === 'bearish' ? 'USD WEAKENS' : 'NEUTRAL / CONFLICTED'}</div>
      <div class="nw-verdict-conf">confidence <b>${c.confidence}%</b></div>
    </div>
    ${scenario}
    <p class="nw-daysummary">${esc(c.summary)}</p>
    <ul class="nw-preds">${preds}</ul>
    ${c.tradingBiasRules ? `<p class="nw-note">Your rules: <b>${esc(c.tradingBiasRules)}</b></p>` : ''}
    <div class="nw-cross">
      <div><span>XAUUSD</span>${esc(c.crossAsset.xauusd)}</div>
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
/* Stats + filters wiring                                              */
/* ------------------------------------------------------------------ */

function renderDayFilterOptions(): void {
  const sel = el('filterDay') as HTMLSelectElement | null;
  if (!sel) return;
  const days = dayOptions();
  const previous = sel.value;
  sel.innerHTML =
    '<option value="all">All days</option>' +
    days
      .map((d) => {
        const sample = events.find((e) => e.tehranDay === d);
        return `<option value="${esc(d)}">${esc(sample?.jalaliFa ?? d)} · ${esc(sample?.weekdayEn ?? d)}</option>`;
      })
      .join('');
  if (previous && days.includes(previous)) sel.value = previous;
}

function renderStats(): void {
  const high = events.filter((e) => e.impact === 'high').length;
  const medium = events.filter((e) => e.impact === 'medium').length;
  const next = events
    .filter((e) => Date.parse(e.timeIso) > Date.now())
    .sort((a, b) => Date.parse(a.timeIso) - Date.parse(b.timeIso))[0];
  const set = (id: string, v: string) => {
    const n = el(id);
    if (n) n.textContent = v;
  };
  set('highCount', String(high));
  set('mediumCount', String(medium));
  if (next) {
    set('nextEvent', `${next.currency} ${next.tehranTime}`);
    set('nextEventTime', `${next.title} · ${next.jalaliFa}`);
  } else {
    set('nextEvent', '—');
    set('nextEventTime', 'No upcoming watched events this week');
  }
}

function renderCustomDayOptions(): void {
  const sel = el('customDay') as HTMLSelectElement | null;
  if (!sel) return;
  const days = dayOptions();
  sel.innerHTML = days
    .map((d) => {
      const sample = events.find((e) => e.tehranDay === d);
      return `<option value="${esc(d)}">${esc(sample?.jalaliFa ?? d)} · ${esc(d)}</option>`;
    })
    .join('');
  if (selectedDay && days.includes(selectedDay)) sel.value = selectedDay;
}

function wireFilters(): void {
  for (const [id, key] of [
    ['filterCurrency', 'currency'],
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
    const customDaySel = el('customDay') as HTMLSelectElement | null;
    if (customDaySel && selectedDay && Array.from(customDaySel.options).some((o) => o.value === selectedDay)) {
      customDaySel.value = selectedDay;
    }
    void loadDayAnalysis();
  });
  el('runCustomBtn')?.addEventListener('click', () => void runCustomAnalysis());
  el('refreshBtn')?.addEventListener('click', () => void loadAll(true));
}

async function loadAll(force = false): Promise<void> {
  const status = el('connectionStatus');
  if (status) status.textContent = force ? 'Refreshing…' : status.textContent;
  try {
    const payload = await getJson<{ events: NewsEvent[]; generatedAt: string | null; source: string | null }>(
      `${WORKER}/api/news/calendar`,
    );
    events = payload.events ?? [];
    const gen = el('weekLabel');
    if (gen) {
      gen.textContent = payload.generatedAt
        ? `Source: ${payload.source ?? 'weekly feed'} · synced ${new Date(payload.generatedAt).toLocaleString('en-GB', { timeZone: 'Asia/Tehran' })} Tehran time.`
        : 'Calendar not synced yet.';
    }
    const dot = el('statusDot');
    if (dot) dot.classList.add('on');
    if (status) status.textContent = 'LIVE · WORKER CONNECTED';
    renderStats();
    renderDayFilterOptions();
    renderCustomDayOptions();
    renderDaySelector();
    renderCalendar();
    await loadDayAnalysis();
  } catch (e) {
    if (status) status.textContent = `OFFLINE · ${(e as Error).message}`;
    const dot = el('statusDot');
    if (dot) dot.classList.remove('on');
  }
}

export function mountNews(): void {
  if (!el('newsPage')) return;
  tickClocks();
  window.setInterval(tickClocks, 1000);
  wireFilters();
  void loadAll();
}
