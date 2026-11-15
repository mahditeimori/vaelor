/**
 * Vaelor member dashboard — execution desk behaviour.
 *
 * Implements the design language adopted in the operator preview: tabbed shell
 * (Overview / Execution Desk / Live Terminal / Playbook), high-visibility
 * crimson buttons, accordion drawers, toasts, kill switch, order ticket, live
 * positions blotter and the bridge pairing modal.
 *
 * Data honesty rules:
 *   - Nothing is rendered as a broker fill unless the bridge confirmed it.
 *   - With no paired bridge the page runs in PREVIEW mode: sample quotes and
 *     sample blotter rows, both clearly labelled, and LIVE BROKER routing is
 *     refused instead of being faked.
 *   - Live figures are polled from the member's own bridge instance
 *     (`vaelor.bridge.pairing` → { url, token }).
 */
import { getCurrentUser, type MemberUser } from './membership';

const PAIRING_KEY = 'vaelor.bridge.pairing';
const PROFILE_KEY = 'vaelor.desk.profile';

const TF_TO_BRIDGE: Record<string, string> = {
  '1m': 'M1',
  '5m': 'M5',
  '15m': 'M15',
  '1H': 'H1',
  '4H': 'H4',
  '1D': 'D1',
};

/* ------------------------------------------------------------------ */
/* Bridge payload types                                                */
/* ------------------------------------------------------------------ */
interface Pairing {
  url: string;
  token: string;
}

interface BridgePosition {
  ticket: number;
  symbol: string;
  side: string;
  volume: number;
  openPrice: number;
  currentPrice: number;
  sl: number | null;
  tp: number | null;
  profit: number;
  comment?: string;
  strategyId?: string | null;
}

interface BridgeRisk {
  riskPerTradePct?: number;
  maxLotPerTrade?: number;
  maxOpenPositions?: number;
  maxDailyLossPct?: number;
  maxDrawdownPct?: number;
  symbolWhitelist?: string[];
  killSwitch?: boolean;
}

interface BridgeLiveConfig {
  timeframe?: string;
  symbols?: string[];
  strategyId?: string | null;
}

interface BridgeStatus {
  mode?: string;
  tradingEnabled?: boolean;
  account?: { balance?: number; equity?: number; profit?: number } | null;
  risk?: BridgeRisk;
  live?: BridgeLiveConfig;
  safety?: { killSwitch?: boolean; propSafe?: boolean };
}

interface BridgeQuote {
  bid: number;
  ask: number;
  changePct?: number;
}

interface BridgeSymbol {
  symbol: string;
  description?: string;
  marketOpen?: boolean;
  tradable?: boolean;
  price?: number;
}

/* ------------------------------------------------------------------ */
/* Design state                                                        */
/* ------------------------------------------------------------------ */
interface DeskRow {
  id: string;
  ticket: number | null;
  symbol: string;
  side: 'BUY' | 'SELL';
  lots: number;
  entry: number;
  sl: number | null;
  tp: number | null;
  strategy: string;
  pnl: number;
  simulated: boolean;
}

interface SampleQuote {
  bid: number;
  ask: number;
  spread: string;
  day: string;
  sl: number;
  tp: number;
}

interface DesignState {
  activeTab: string;
  orderSide: 'BUY' | 'SELL';
  executionMode: 'SIMULATION' | 'LIVE BROKER';
  safetyArmed: boolean;
  paired: boolean;
  linked: boolean;
  busy: boolean;
  quoteOk: boolean;
  bridgeHost: string;
  selectedTimeframe: string;
  symbols: Record<string, SampleQuote>;
  positions: DeskRow[];
}

const state: DesignState = {
  activeTab: 'overview',
  orderSide: 'BUY',
  executionMode: 'SIMULATION',
  safetyArmed: true,
  paired: false,
  linked: false,
  busy: false,
  quoteOk: false,
  bridgeHost: '',
  selectedTimeframe: '1H',
  symbols: {
    ESZ6: { bid: 5892.25, ask: 5892.5, spread: '0.25', day: '+0.84%', sl: 5880, tp: 5915 },
    NQZ6: { bid: 20845.5, ask: 20846, spread: '0.5', day: '+1.12%', sl: 20790, tp: 20950 },
    XAUUSD: { bid: 2742.1, ask: 2742.45, spread: '0.35', day: '+0.62%', sl: 2730, tp: 2765 },
    CLZ6: { bid: 71.42, ask: 71.45, spread: '0.03', day: '-0.45%', sl: 70.8, tp: 72.8 },
    BTCUSD: { bid: 89420, ask: 89435, spread: '15', day: '+2.4%', sl: 88500, tp: 91200 },
  },
  positions: [
    { id: 'DEMO-90412', ticket: null, symbol: 'ESZ6', side: 'BUY', lots: 0.25, entry: 5884.5, sl: 5875, tp: 5910, strategy: 'sample · VWAP Mean Reversion v2', pnl: 968.75, simulated: true },
    { id: 'DEMO-90419', ticket: null, symbol: 'XAUUSD', side: 'BUY', lots: 0.1, entry: 2737.6, sl: 2728, tp: 2760, strategy: 'sample · manual trade', pnl: 451.75, simulated: true },
  ],
};

let user: MemberUser | null = null;
let liveConfig: BridgeLiveConfig = { timeframe: 'H1', symbols: [], strategyId: null };
let curatedOptions = '';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readPairing(): Pairing | null {
  try {
    const raw = localStorage.getItem(PAIRING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Pairing> | null;
    const url = typeof parsed?.url === 'string' ? parsed.url.trim() : '';
    const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
    if (!url || !token) return null;
    return { url: url.replace(/\/+$/, ''), token };
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function bridgeRequest<T>(pairing: Pairing, path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-bridge-token': pairing.token };
  if (init.body) headers['content-type'] = 'application/json';
  const res = await fetch(pairing.url + path, { ...init, headers });
  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!res.ok) {
    let detail = `bridge returned HTTP ${res.status}`;
    if (payload && typeof payload === 'object' && 'detail' in payload) {
      const raw = (payload as { detail?: unknown }).detail;
      detail = typeof raw === 'string' ? raw : JSON.stringify(raw);
    }
    throw new Error(detail);
  }
  return payload as T;
}

function showToast(msg: string, type: 'info' | 'success' | 'error' = 'info'): void {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  let borderColor = 'border-rose-500/60';
  let icon = '<i class="fa-solid fa-circle-info text-rose-400"></i>';
  if (type === 'success') {
    borderColor = 'border-emerald-400/70';
    icon = '<i class="fa-solid fa-circle-check text-emerald-400"></i>';
  } else if (type === 'error') {
    borderColor = 'border-rose-500';
    icon = '<i class="fa-solid fa-triangle-exclamation text-rose-400"></i>';
  }
  toast.className = `pointer-events-auto flex items-start gap-3 p-4 rounded-xl bg-[#160b11]/95 backdrop-blur-md border-2 ${borderColor} text-xs font-mono text-white shadow-2xl transition-all duration-300`;
  toast.innerHTML = `<div class="mt-0.5 text-sm">${icon}</div><div class="flex-1 leading-relaxed">${msg}</div>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 300);
  }, 3600);
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */
type TabId = 'overview' | 'execution' | 'terminal' | 'playbook';

const TABS: TabId[] = ['overview', 'execution', 'terminal', 'playbook'];

function switchTab(tabId: string): void {
  state.activeTab = tabId;
  for (const view of TABS) {
    const el = document.getElementById(`view-${view}`);
    if (el) el.classList.toggle('hidden', view !== tabId);
  }
  const active = 'nav-pill-btn px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 bg-rose-600/25 border border-rose-500 text-white shadow-[0_0_12px_rgba(225,29,72,0.35)]';
  const idle = 'nav-pill-btn px-3.5 py-1.5 rounded-full text-xs font-medium transition-all flex items-center gap-1.5 text-slate-300 hover:text-white hover:bg-white/5 border border-transparent';
  for (const view of TABS) {
    const btn = document.getElementById(`nav-${view}`);
    if (btn) btn.className = view === tabId ? active : idle;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ------------------------------------------------------------------ */
/* Accordions                                                          */
/* ------------------------------------------------------------------ */
function toggleAccordion(contentId: string): void {
  const content = document.getElementById(contentId);
  const icon = document.getElementById(`icon-${contentId}`);
  const label = document.getElementById(`label-${contentId}`);
  if (!content) return;
  if (content.classList.contains('open')) {
    content.classList.remove('open');
    if (icon) icon.classList.remove('rotate-180');
    if (label) label.textContent = 'Show Setup & Notes';
  } else {
    content.classList.add('open');
    if (icon) icon.classList.add('rotate-180');
    if (label) label.textContent = 'Hide Setup & Notes';
  }
}

function toggleAllExecutionAccordions(): void {
  toggleAccordion('acc-bridge-setup');
}

/* ------------------------------------------------------------------ */
/* Data mode (preview vs paired bridge)                                */
/* ------------------------------------------------------------------ */
function applyDataMode(): void {
  const banner = document.getElementById('data-mode-banner');
  if (banner) banner.classList.toggle('hidden', state.linked);

  const pnlLabel = document.getElementById('pnl-label');
  if (pnlLabel) pnlLabel.textContent = state.linked ? 'OPEN P&L:' : 'SAMPLE OPEN P&L:';

  const chip = document.getElementById('bridge-chip');
  if (chip) {
    chip.textContent = state.linked ? 'BRIDGE LIVE' : state.paired ? 'BRIDGE UNREACHABLE' : 'BRIDGE NOT PAIRED';
    chip.className = state.linked
      ? 'px-2 py-0.5 text-[10px] font-mono rounded bg-emerald-950 text-emerald-300 border border-emerald-500/40'
      : 'px-2 py-0.5 text-[10px] font-mono rounded bg-amber-950 text-amber-300 border border-amber-500/40';
  }

  const endpoint = document.getElementById('bridge-endpoint');
  if (endpoint) {
    endpoint.textContent = state.paired
      ? state.bridgeHost || 'paired'
      : 'not paired — open Account / Auth and paste your bridge token';
  }

  if (!state.linked && state.executionMode === 'LIVE BROKER') {
    state.executionMode = 'SIMULATION';
    paintMode();
  }
}

function setBridgePill(kind: 'online' | 'offline' | 'unpaired', text: string): void {
  const pill = document.getElementById('bridge-status-pill');
  const dot = document.getElementById('bridge-dot');
  const label = document.getElementById('bridge-text');
  const styles: Record<'online' | 'offline' | 'unpaired', string> = {
    online: 'hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-950/60 border border-emerald-500/50 text-emerald-300 text-xs font-mono hover:bg-emerald-900/70 transition cursor-pointer',
    offline: 'hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-rose-950/70 border border-rose-500/60 text-rose-300 text-xs font-mono hover:bg-rose-900/70 transition cursor-pointer',
    unpaired: 'hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-950/60 border border-amber-500/50 text-amber-200 text-xs font-mono hover:bg-amber-900/70 transition cursor-pointer',
  };
  const dots: Record<'online' | 'offline' | 'unpaired', string> = {
    online: 'w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]',
    offline: 'w-2 h-2 rounded-full bg-rose-400',
    unpaired: 'w-2 h-2 rounded-full bg-amber-400',
  };
  if (pill) pill.className = styles[kind];
  if (dot) dot.className = dots[kind];
  if (label) label.textContent = text;
}

/** Put the shipped watchlist back when there is no broker to ask. */
function restoreCuratedSymbols(): void {
  const select = document.getElementById('ticket-symbol') as HTMLSelectElement | null;
  if (!select || !curatedOptions) return;
  select.innerHTML = curatedOptions;
  updateSymbolQuotes();
}

async function connectBridge(announce: boolean): Promise<void> {
  const pairing = readPairing();
  state.paired = Boolean(pairing);

  if (!pairing) {
    state.linked = false;
    state.bridgeHost = '';
    setBridgePill('unpaired', 'BRIDGE: NOT PAIRED');
    applyDataMode();
    restoreCuratedSymbols();
    if (announce) showToast('No bridge paired yet. Open Account / Pairing and paste your instance token.', 'error');
    return;
  }

  state.bridgeHost = hostOf(pairing.url);
  try {
    const status = await bridgeRequest<BridgeStatus>(pairing, '/api/status');
    state.linked = true;
    setBridgePill('online', `BRIDGE: ${state.bridgeHost}`);
    applyDataMode();
    applyStatus(status);
    await refreshSymbols(pairing);
    await refreshBook();
    await refreshQuote();
    if (announce) {
      showToast(`Paired with ${state.bridgeHost} · ${status.mode ?? 'unknown'} mode${status.tradingEnabled ? ' · trading enabled' : ''}.`, 'success');
    }
  } catch (err) {
    state.linked = false;
    setBridgePill('offline', `BRIDGE: ${state.bridgeHost} UNREACHABLE`);
    applyDataMode();
    restoreCuratedSymbols();
    if (announce) showToast(`Could not reach ${state.bridgeHost} — ${message(err)}`, 'error');
  }
}

function applyStatus(status: BridgeStatus): void {
  const risk = status.risk;
  if (risk) {
    setInputValue('risk-per-trade', risk.riskPerTradePct);
    setInputValue('risk-max-lots', risk.maxLotPerTrade);
    setInputValue('risk-max-pos', risk.maxOpenPositions);
    setInputValue('risk-daily-loss', risk.maxDailyLossPct);
    setInputValue('risk-max-dd', risk.maxDrawdownPct);
    if (Array.isArray(risk.symbolWhitelist) && risk.symbolWhitelist.length > 0) {
      renderDeskSymbolChips(risk.symbolWhitelist);
      applySymbolSelection(risk.symbolWhitelist);
    }
    setSafety(!risk.killSwitch);
  }
  if (status.live) {
    liveConfig = {
      timeframe: status.live.timeframe ?? liveConfig.timeframe,
      symbols: status.live.symbols ?? liveConfig.symbols,
      strategyId: status.live.strategyId ?? null,
    };
  }
  state.executionMode = status.mode === 'live' ? 'LIVE BROKER' : 'SIMULATION';
  paintMode();
}

function setInputValue(id: string, value: number | undefined): void {
  if (typeof value !== 'number') return;
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (input) input.value = String(value);
}

/* ------------------------------------------------------------------ */
/* Quotes                                                              */
/* ------------------------------------------------------------------ */
function paintQuote(symbol: string): void {
  const data = state.symbols[symbol];
  if (!data) return;
  state.quoteOk = true;
  const bidEl = document.getElementById('quote-bid');
  const askEl = document.getElementById('quote-ask');
  const spreadEl = document.getElementById('quote-spread');
  const dayEl = document.getElementById('quote-day');
  if (bidEl) bidEl.textContent = data.bid.toLocaleString('en-US', { minimumFractionDigits: 2 });
  if (askEl) askEl.textContent = data.ask.toLocaleString('en-US', { minimumFractionDigits: 2 });
  if (spreadEl) spreadEl.textContent = data.spread;
  if (dayEl) {
    dayEl.textContent = data.day;
    dayEl.className = 'text-base sm:text-lg font-mono font-bold mt-0.5 ' + (data.day.startsWith('+') ? 'text-emerald-400' : 'text-rose-400');
  }
}

/** The bridge answered but has no quote for this symbol — say so, never invent one. */
function paintUnavailable(): void {
  state.quoteOk = false;
  const bidEl = document.getElementById('quote-bid');
  const askEl = document.getElementById('quote-ask');
  const spreadEl = document.getElementById('quote-spread');
  const dayEl = document.getElementById('quote-day');
  if (bidEl) bidEl.textContent = '—';
  if (askEl) askEl.textContent = '—';
  if (spreadEl) spreadEl.textContent = '—';
  if (dayEl) {
    dayEl.textContent = '—';
    dayEl.className = 'text-base sm:text-lg font-mono font-bold mt-0.5 text-slate-400';
  }
}

function selectedSymbol(): string {
  return (document.getElementById('ticket-symbol') as HTMLSelectElement | null)?.value ?? 'ESZ6';
}

function updateSymbolQuotes(): void {
  const symbol = selectedSymbol();
  const data = state.symbols[symbol];
  if (!data) return;
  paintQuote(symbol);
  const sl = document.getElementById('ticket-sl') as HTMLInputElement | null;
  const tp = document.getElementById('ticket-tp') as HTMLInputElement | null;
  if (sl) sl.value = data.sl > 0 ? data.sl.toFixed(2) : '';
  if (tp) tp.value = data.tp > 0 ? data.tp.toFixed(2) : '';
  updateOrderButtonLabel();
  void refreshQuote();
}

async function refreshQuote(): Promise<void> {
  const symbol = selectedSymbol();
  const pairing = readPairing();
  if (pairing && state.linked) {
    try {
      const quote = await bridgeRequest<BridgeQuote>(pairing, `/api/quote?symbol=${encodeURIComponent(symbol)}`);
      const cache = state.symbols[symbol];
      if (cache && typeof quote.bid === 'number' && typeof quote.ask === 'number') {
        cache.bid = quote.bid;
        cache.ask = quote.ask;
        cache.spread = Math.abs(quote.ask - quote.bid).toFixed(2);
        const pct = typeof quote.changePct === 'number' ? quote.changePct : null;
        cache.day = pct === null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
        paintQuote(symbol);
        return;
      }
      paintUnavailable();
      return;
    } catch {
      paintUnavailable();
      return;
    }
  }
  paintQuote(symbol);
}

/**
 * Replace the curated watchlist with the symbols the member's own terminal
 * actually offers. Market-open symbols first, capped so the picker stays usable.
 */
async function refreshSymbols(pairing: Pairing): Promise<void> {
  try {
    const data = await bridgeRequest<{ symbols?: BridgeSymbol[] }>(pairing, '/api/symbols');
    const all = (data.symbols ?? []).filter((s) => s.tradable !== false && typeof s.symbol === 'string');
    const open = all.filter((s) => s.marketOpen);
    const list = (open.length >= 4 ? open : all).slice(0, 60);
    const select = document.getElementById('ticket-symbol') as HTMLSelectElement | null;
    if (!select || list.length === 0) return;

    const previous = select.value;
    select.replaceChildren(
      ...list.map((row) => {
        const option = document.createElement('option');
        option.value = row.symbol;
        option.textContent = row.description ? `${row.symbol} — ${row.description}` : row.symbol;
        return option;
      }),
    );
    select.value = list.some((row) => row.symbol === previous) ? previous : list[0].symbol;

    for (const row of list) {
      if (!state.symbols[row.symbol]) {
        const price = typeof row.price === 'number' ? row.price : 0;
        state.symbols[row.symbol] = { bid: price, ask: price, spread: '—', day: '—', sl: 0, tp: 0 };
      }
    }
    updateSymbolQuotes();
  } catch {
    // Keep the curated watchlist when /api/symbols is unavailable.
  }
}

/* ------------------------------------------------------------------ */
/* Order ticket                                                        */
/* ------------------------------------------------------------------ */
function updateOrderButtonLabel(): void {
  const symbol = selectedSymbol();
  const volume = (document.getElementById('ticket-volume') as HTMLInputElement | null)?.value ?? '0.10';
  const label = document.getElementById('place-order-label');
  const prefix = state.linked ? '' : 'Preview ';
  if (label) label.textContent = `${prefix}${state.orderSide} Order (${volume} Lots ${symbol})`;
}

function selectOrderSide(side: 'BUY' | 'SELL'): void {
  state.orderSide = side;
  const buy = document.getElementById('btn-side-buy');
  const sell = document.getElementById('btn-side-sell');
  const active = 'py-3.5 px-4 rounded-xl font-mono font-bold text-sm tracking-wider uppercase transition-all flex items-center justify-center gap-2';
  if (side === 'BUY') {
    if (buy) buy.className = `btn-buy-active ${active}`;
    if (sell) sell.className = `btn-sell-inactive ${active}`;
  } else {
    if (buy) buy.className = `btn-buy-inactive ${active}`;
    if (sell) sell.className = `btn-sell-active ${active}`;
  }
  updateOrderButtonLabel();
}

function adjustVolume(delta: number): void {
  const input = document.getElementById('ticket-volume') as HTMLInputElement | null;
  if (!input) return;
  const current = parseFloat(input.value) || 0.1;
  input.value = Math.max(0.01, Math.round((current + delta) * 100) / 100).toFixed(2);
  updateOrderButtonLabel();
}

interface TicketValues {
  symbol: string;
  lots: number;
  sl: number;
  tp: number;
  strategy: string;
  comment: string;
}

function readTicket(): TicketValues {
  const num = (id: string, fallback: number): number => {
    const raw = (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    symbol: selectedSymbol(),
    lots: num('ticket-volume', 0.1),
    sl: num('ticket-sl', 0),
    tp: num('ticket-tp', 0),
    strategy: (document.getElementById('ticket-strategy') as HTMLSelectElement | null)?.value ?? 'manual trade',
    comment: ((document.getElementById('ticket-comment') as HTMLInputElement | null)?.value ?? 'execution desk').slice(0, 64),
  };
}

async function submitOrderTicket(): Promise<void> {
  if (!state.safetyArmed) {
    showToast('ORDER BLOCKED: Kill Switch is engaged. Re-arm the safety gates first.', 'error');
    return;
  }
  const confirmed = document.getElementById('confirm-broker-checkbox') as HTMLInputElement | null;
  if (!confirmed?.checked) {
    showToast('Tick the confirmation checkbox before routing an order.', 'error');
    return;
  }

  const ticket = readTicket();
  const pairing = readPairing();

  if (pairing && state.linked) {
    if (!state.quoteOk) {
      showToast(`Your bridge has no live quote for ${ticket.symbol}. Pick a symbol your broker offers, then try again.`, 'error');
      return;
    }
    if (ticket.sl <= 0) {
      showToast('No stop, no trade: attach a stop loss before routing this order.', 'error');
      return;
    }
    if (state.busy) return;
    state.busy = true;
    try {
      const result = await bridgeRequest<{ ok?: boolean; position?: { ticket?: number }; order?: { ticket?: number } }>(
        pairing,
        '/api/orders',
        {
          method: 'POST',
          body: JSON.stringify({
            symbol: ticket.symbol,
            side: state.orderSide.toLowerCase(),
            volume: ticket.lots,
            type: 'market',
            sl: ticket.sl > 0 ? ticket.sl : null,
            tp: ticket.tp > 0 ? ticket.tp : null,
            comment: ticket.comment,
            strategyId: ticket.strategy === 'manual trade' ? null : ticket.strategy,
            confirm: state.executionMode === 'LIVE BROKER',
          }),
        },
      );
      const filled = result?.position?.ticket ?? result?.order?.ticket;
      const kind = state.executionMode === 'LIVE BROKER' ? 'LIVE ORDER ACCEPTED' : 'BRIDGE PAPER FILL';
      showToast(`${kind}: ${state.orderSide} ${ticket.lots.toFixed(2)} ${ticket.symbol}${filled ? ` · ticket ${filled}` : ''}`, 'success');
      await refreshBook();
      await refreshQuote();
    } catch (err) {
      showToast(`Order rejected by bridge: ${message(err)}`, 'error');
    } finally {
      state.busy = false;
    }
    return;
  }

  if (state.executionMode === 'LIVE BROKER') {
    showToast('LIVE BROKER routing needs a paired bridge. Pair your instance, or switch to SIMULATION.', 'error');
    return;
  }

  const quote = state.symbols[ticket.symbol];
  if (!quote) return;
  const fill = state.orderSide === 'BUY' ? quote.ask : quote.bid;
  state.positions.unshift({
    id: `SIM-${Math.floor(10000 + Math.random() * 90000)}`,
    ticket: null,
    symbol: ticket.symbol,
    side: state.orderSide,
    lots: ticket.lots,
    entry: fill,
    sl: ticket.sl > 0 ? ticket.sl : null,
    tp: ticket.tp > 0 ? ticket.tp : null,
    strategy: `sample · ${ticket.strategy === 'manual trade' ? 'manual trade' : ticket.strategy}`,
    pnl: 0,
    simulated: true,
  });
  renderPositionsTable();
  showToast(`SIMULATED FILL — NOT SENT TO A BROKER: ${state.orderSide} ${ticket.lots.toFixed(2)} ${ticket.symbol} @ ${fill.toLocaleString()}.`, 'info');
}

/* ------------------------------------------------------------------ */
/* Positions                                                           */
/* ------------------------------------------------------------------ */
function toDeskRow(position: BridgePosition): DeskRow {
  return {
    id: String(position.ticket),
    ticket: position.ticket,
    symbol: position.symbol,
    side: String(position.side).toLowerCase() === 'sell' ? 'SELL' : 'BUY',
    lots: Number(position.volume) || 0,
    entry: Number(position.openPrice) || 0,
    sl: position.sl == null ? null : Number(position.sl),
    tp: position.tp == null ? null : Number(position.tp),
    strategy: position.strategyId || position.comment || 'manual trade',
    pnl: Number(position.profit) || 0,
    simulated: false,
  };
}

async function refreshBook(): Promise<void> {
  const pairing = readPairing();
  if (!pairing || !state.linked) {
    renderPositionsTable();
    return;
  }
  try {
    const data = await bridgeRequest<{ positions?: BridgePosition[] }>(pairing, '/api/positions');
    state.positions = (data.positions ?? []).map(toDeskRow);
  } catch {
    // Keep the last known book and let the pill show the connection state.
  }
  renderPositionsTable();
}

function formatLevel(value: number | null): string {
  return value == null ? '—' : String(value);
}

function renderPositionsTable(): void {
  const tbody = document.getElementById('positions-table-body');
  const badge = document.getElementById('nav-pos-count');
  const pnlBadge = document.getElementById('total-pnl-badge');
  if (badge) badge.textContent = String(state.positions.length);

  if (state.positions.length === 0) {
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="9" class="py-8 text-center text-slate-400 font-mono">No open positions. Use the Execution Desk to route a new order.</td></tr>';
    }
    if (pnlBadge) {
      pnlBadge.textContent = '$0.00';
      pnlBadge.className = 'text-emerald-400 font-bold text-sm';
    }
    return;
  }

  let totalPnl = 0;
  if (tbody) {
    tbody.innerHTML = state.positions
      .map((pos, idx) => {
        totalPnl += pos.pnl;
        const sideCls = pos.side === 'BUY'
          ? 'bg-emerald-950/80 text-emerald-300 border-emerald-500/40'
          : 'bg-rose-950/80 text-rose-300 border-rose-500/40';
        const pnlCls = pos.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400';
        const pnlPrefix = pos.pnl >= 0 ? '+$' : '-$';
        const sampleCls = pos.simulated
          ? '<span class="ml-1.5 px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[10px] uppercase">sample</span>'
          : '';
        return `
        <tr class="hover:bg-white/[0.02] transition">
          <td class="py-3.5 px-4 text-slate-300">${pos.id}${sampleCls}</td>
          <td class="py-3.5 px-4 font-bold text-white">${pos.symbol}</td>
          <td class="py-3.5 px-4"><span class="px-2.5 py-0.5 rounded border text-xs ${sideCls}">${pos.side}</span></td>
          <td class="py-3.5 px-4 text-white">${pos.lots.toFixed(2)}</td>
          <td class="py-3.5 px-4 text-slate-200">${pos.entry.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
          <td class="py-3.5 px-4 text-slate-400 text-xs">${formatLevel(pos.sl)} / ${formatLevel(pos.tp)}</td>
          <td class="py-3.5 px-4 text-slate-300 text-xs">${pos.strategy}</td>
          <td class="py-3.5 px-4 font-bold ${pnlCls}">${pnlPrefix}${Math.abs(pos.pnl).toFixed(2)}</td>
          <td class="py-3.5 px-4 text-right"><button onclick="closePosition(${idx})" class="px-3 py-1 rounded-lg bg-rose-950 hover:bg-rose-700 border border-rose-500/50 text-rose-200 text-xs transition">Close</button></td>
        </tr>`;
      })
      .join('');
  }
  if (pnlBadge) {
    pnlBadge.textContent = (totalPnl >= 0 ? '+$' : '-$') + Math.abs(totalPnl).toFixed(2);
    pnlBadge.className = 'font-bold text-sm ' + (totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400');
  }
}

async function closePosition(index: number): Promise<void> {
  const row = state.positions[index];
  if (!row) return;
  const pairing = readPairing();
  if (row.ticket !== null && pairing && state.linked) {
    try {
      await bridgeRequest(pairing, `/api/positions/${row.ticket}/close`, { method: 'POST', body: JSON.stringify({}) });
      showToast(`Close request accepted for ticket ${row.ticket}.`, 'success');
      await refreshBook();
    } catch (err) {
      showToast(`Close rejected by bridge: ${message(err)}`, 'error');
    }
    return;
  }
  state.positions.splice(index, 1);
  renderPositionsTable();
  showToast(`Removed sample row ${row.id} (${row.symbol}). Nothing was sent to a broker.`, 'info');
}

async function flattenAllPositions(): Promise<void> {
  if (state.positions.length === 0) {
    showToast('No open positions to flatten.', 'info');
    return;
  }
  const pairing = readPairing();
  if (pairing && state.linked) {
    try {
      await bridgeRequest(pairing, '/api/positions/close-all', { method: 'POST', body: JSON.stringify({}) });
      showToast('FLATTEN ALL accepted by the bridge. Check the blotter for confirmations.', 'error');
      await refreshBook();
    } catch (err) {
      showToast(`Flatten rejected by bridge: ${message(err)}`, 'error');
    }
    return;
  }
  const count = state.positions.length;
  state.positions = [];
  renderPositionsTable();
  showToast(`Cleared ${count} sample rows. No broker orders were sent.`, 'info');
}

/* ------------------------------------------------------------------ */
/* Kill switch / mode / risk gates                                     */
/* ------------------------------------------------------------------ */
function setSafety(armed: boolean): void {
  state.safetyArmed = armed;
  const btn = document.getElementById('kill-switch-btn');
  const label = document.getElementById('kill-switch-label');
  const pill = document.getElementById('safety-pill-badge');
  if (armed) {
    if (btn) btn.className = 'px-4 py-2 rounded-xl text-xs font-mono font-bold uppercase tracking-wider border-2 border-emerald-400 bg-emerald-950/80 text-emerald-200 shadow-[0_0_15px_rgba(16,185,129,0.3)] hover:bg-emerald-900 transition flex items-center gap-2';
    if (label) label.textContent = 'SAFETY GATES: ARMED';
    if (pill) {
      pill.textContent = 'armed';
      pill.className = 'px-3.5 py-1 rounded-full text-xs font-mono font-semibold bg-emerald-950/90 border border-emerald-400/60 text-emerald-300';
    }
  } else {
    if (btn) btn.className = 'px-4 py-2 rounded-xl text-xs font-mono font-bold uppercase tracking-wider border-2 border-rose-500 bg-rose-950/90 text-rose-200 shadow-[0_0_20px_rgba(244,63,94,0.5)] hover:bg-rose-900 transition flex items-center gap-2';
    if (label) label.textContent = 'KILL SWITCH ENGAGED (LOCKED)';
    if (pill) {
      pill.textContent = 'kill-switch locked';
      pill.className = 'px-3.5 py-1 rounded-full text-xs font-mono font-semibold bg-rose-950/90 border border-rose-400/60 text-rose-300';
    }
  }
}

async function toggleKillSwitch(): Promise<void> {
  const engage = state.safetyArmed;
  const pairing = readPairing();
  if (pairing && state.linked) {
    try {
      await bridgeRequest(pairing, '/api/kill', {
        method: 'POST',
        body: JSON.stringify({ active: engage, closePositions: false, confirm: 'KILL' }),
      });
    } catch (err) {
      showToast(`Kill switch change rejected by bridge: ${message(err)}`, 'error');
      return;
    }
  }
  setSafety(!engage);
  showToast(
    engage
      ? 'KILL SWITCH ENGAGED: new order routing is halted on your bridge. Closes and stop moves still work.'
      : 'Risk gates ARMED. Order routing enabled.',
    engage ? 'error' : 'success',
  );
}

function paintMode(): void {
  const badge = document.getElementById('exec-mode-badge');
  const text = document.getElementById('exec-mode-text');
  if (badge) {
    badge.className = state.executionMode === 'LIVE BROKER'
      ? 'px-3.5 py-1.5 rounded-full text-xs font-mono font-semibold bg-rose-950/90 border border-rose-400 text-rose-200 shadow-[0_0_12px_rgba(244,63,94,0.35)] transition flex items-center gap-1.5'
      : 'px-3.5 py-1.5 rounded-full text-xs font-mono font-semibold bg-amber-950/80 border border-amber-400/60 text-amber-200 hover:border-amber-300 transition flex items-center gap-1.5';
  }
  if (text) text.textContent = state.executionMode === 'LIVE BROKER' ? 'MODE: LIVE BROKER' : 'MODE: SIMULATION';
}

function toggleExecutionMode(): void {
  if (!state.linked && state.executionMode === 'SIMULATION') {
    showToast('LIVE BROKER routing unlocks once your cloud bridge is paired. Staying in SIMULATION.', 'error');
    return;
  }
  state.executionMode = state.executionMode === 'SIMULATION' ? 'LIVE BROKER' : 'SIMULATION';
  paintMode();
  showToast(`Routing mode set to ${state.executionMode}.`, 'info');
}

function checkedSymbols(): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('.desk-symbol'))
    .filter((box) => box.checked)
    .map((box) => box.value.toUpperCase());
}

function applySymbolSelection(symbols: string[]): void {
  const wanted = new Set(symbols.map((s) => s.toUpperCase()));
  for (const box of Array.from(document.querySelectorAll<HTMLInputElement>('.desk-symbol'))) {
    box.checked = wanted.has(box.value.toUpperCase());
  }
}

/** Rebuild the desk-profile chips from the symbols the bridge actually allows. */
function renderDeskSymbolChips(symbols: string[]): void {
  const host = document.getElementById('desk-symbols');
  if (!host || symbols.length === 0) return;
  host.replaceChildren(
    ...symbols.map((symbol) => {
      const label = document.createElement('label');
      label.className = 'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#160c12] border border-[#592e42] text-xs font-mono text-white cursor-pointer hover:border-rose-400';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = symbol;
      box.checked = true;
      box.className = 'desk-symbol accent-rose-500';
      box.addEventListener('change', () => {
        void syncDeskProfile();
      });
      label.append(box, document.createTextNode(` ${symbol}`));
      return label;
    }),
  );
}

function persistProfile(): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ timeframe: state.selectedTimeframe, symbols: checkedSymbols() }));
  } catch {
    // Storage can be unavailable in private mode; the desk still works.
  }
}

function restoreProfile(): void {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { timeframe?: string; symbols?: string[] };
    if (typeof parsed.timeframe === 'string' && parsed.timeframe in TF_TO_BRIDGE) {
      state.selectedTimeframe = parsed.timeframe;
      paintTimeframe(parsed.timeframe);
    }
    if (Array.isArray(parsed.symbols) && parsed.symbols.length > 0) {
      applySymbolSelection(parsed.symbols);
    }
  } catch {
    // Ignore a corrupt profile and fall back to the defaults.
  }
}

async function pushDeskProfile(partial: BridgeLiveConfig): Promise<void> {
  liveConfig = { ...liveConfig, ...partial };
  persistProfile();
  const pairing = readPairing();
  if (!pairing || !state.linked) return;
  try {
    await bridgeRequest(pairing, '/api/live-config', {
      method: 'POST',
      body: JSON.stringify({
        timeframe: liveConfig.timeframe ?? TF_TO_BRIDGE[state.selectedTimeframe] ?? 'H1',
        symbols: liveConfig.symbols ?? [],
        strategyId: liveConfig.strategyId ?? null,
      }),
    });
  } catch (err) {
    showToast(`Desk profile not saved on bridge: ${message(err)}`, 'error');
  }
}

async function syncDeskProfile(): Promise<void> {
  const symbols = checkedSymbols();
  await pushDeskProfile({ symbols });
  showToast(`Live desk symbols: ${symbols.length ? symbols.join(', ') : 'all allowed'}.`, 'info');
}

function paintTimeframe(tf: string): void {
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.tf-btn'))) {
    const isActive = (btn.getAttribute('data-tf') ?? '') === tf;
    btn.className = isActive
      ? 'tf-btn px-3.5 py-1.5 rounded-lg text-xs font-mono border-2 border-amber-400 bg-amber-950/70 text-amber-200 font-bold shadow-[0_0_10px_rgba(245,158,11,0.3)] transition'
      : 'tf-btn px-3.5 py-1.5 rounded-lg text-xs font-mono border border-[#331d27] bg-[#160c12] text-slate-300 hover:border-rose-400 transition';
  }
}

async function selectTimeframe(tf: string): Promise<void> {
  state.selectedTimeframe = tf;
  paintTimeframe(tf);
  await pushDeskProfile({ timeframe: TF_TO_BRIDGE[tf] ?? 'H1' });
  showToast(`Live desk timeframe set to ${tf}.`, 'info');
}

async function saveRiskGates(): Promise<void> {
  const num = (id: string): number => {
    const raw = (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const config = {
    riskPerTradePct: num('risk-per-trade') || 0.5,
    maxLotPerTrade: num('risk-max-lots') || 2.5,
    maxOpenPositions: Math.round(num('risk-max-pos')) || 4,
    maxDailyLossPct: num('risk-daily-loss') || 2,
    maxDrawdownPct: num('risk-max-dd') || 6,
    symbolWhitelist: checkedSymbols(),
    killSwitch: !state.safetyArmed,
  };
  const pairing = readPairing();
  if (pairing && state.linked) {
    try {
      // Read first so fields this page does not own (e.g. allowMarketOrders)
      // are preserved instead of silently reset to their defaults.
      const current = await bridgeRequest<Record<string, unknown>>(pairing, '/api/risk');
      await bridgeRequest(pairing, '/api/risk', {
        method: 'PUT',
        body: JSON.stringify({ ...current, ...config }),
      });
    } catch (err) {
      showToast(`Risk gates rejected by bridge: ${message(err)}`, 'error');
      return;
    }
  }
  showToast(
    `Risk gates saved: ${config.riskPerTradePct}% per trade / ${config.maxDailyLossPct}% daily loss / ${config.symbolWhitelist.length || 'all'} symbols.`,
    'success',
  );
}

/* ------------------------------------------------------------------ */
/* Bridge pairing modal                                                */
/* ------------------------------------------------------------------ */
function openSignInModal(): void {
  const modal = document.getElementById('signin-modal');
  const pairing = readPairing();
  const endpoint = document.getElementById('modal-endpoint-input') as HTMLInputElement | null;
  const token = document.getElementById('modal-token-input') as HTMLInputElement | null;
  if (endpoint) endpoint.value = pairing?.url ?? '';
  if (token) token.value = pairing?.token ?? '';
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
}

function closeSignInModal(): void {
  const modal = document.getElementById('signin-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

async function pairBridge(): Promise<void> {
  const url = ((document.getElementById('modal-endpoint-input') as HTMLInputElement | null)?.value ?? '').trim().replace(/\/+$/, '');
  const token = ((document.getElementById('modal-token-input') as HTMLInputElement | null)?.value ?? '').trim();
  if (!url || !token) {
    showToast('Enter both the bridge endpoint and the instance token.', 'error');
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    showToast('The endpoint must start with https:// (or http:// for a local test instance).', 'error');
    return;
  }
  try {
    localStorage.setItem(PAIRING_KEY, JSON.stringify({ url, token }));
  } catch {
    showToast('This browser blocked local storage, so the token could not be saved.', 'error');
    return;
  }
  closeSignInModal();
  await connectBridge(true);
}

function unpairBridge(): void {
  try {
    localStorage.removeItem(PAIRING_KEY);
  } catch {
    // Nothing to clear.
  }
  state.linked = false;
  state.paired = false;
  state.bridgeHost = '';
  state.positions = [];
  setBridgePill('unpaired', 'BRIDGE: NOT PAIRED');
  applyDataMode();
  restoreCuratedSymbols();
  renderPositionsTable();
  closeSignInModal();
  showToast('Bridge unpaired. The token was removed from this browser.', 'info');
}

async function refreshBridgeConnection(): Promise<void> {
  await connectBridge(true);
}

function copyCommand(elementId: string): void {
  const text = document.getElementById(elementId)?.innerText ?? '';
  if (!text) return;
  const tempInput = document.createElement('textarea');
  tempInput.value = text;
  document.body.appendChild(tempInput);
  tempInput.select();
  document.execCommand('copy');
  document.body.removeChild(tempInput);
  const btnText = document.getElementById('copy-btn-text');
  if (btnText) {
    btnText.textContent = 'Copied!';
    setTimeout(() => {
      btnText.textContent = 'Copy Endpoint';
    }, 2000);
  }
  showToast('Copied the bridge endpoint to the clipboard.', 'success');
}

/* ------------------------------------------------------------------ */
/* Polling                                                             */
/* ------------------------------------------------------------------ */
async function tick(): Promise<void> {
  if (state.linked) {
    await refreshBook();
    await refreshQuote();
    return;
  }
  // Preview mode: nudge the sample quote so the ticket feels alive without
  // ever looking like a broker feed (the page banner and the SIM chips say so).
  const symbol = selectedSymbol();
  const data = state.symbols[symbol];
  if (!data) return;
  const drift = (Math.random() - 0.48) * 0.5;
  data.bid = Math.round((data.bid + drift) * 100) / 100;
  data.ask = Math.round((data.bid + parseFloat(data.spread)) * 100) / 100;
  paintQuote(symbol);
}

/* ------------------------------------------------------------------ */
/* Global exposure (Astro bundles <script> as an ES module — inline   */
/* onclick / onchange handlers need real globals on window)            */
/* ------------------------------------------------------------------ */
const g = window as unknown as Record<string, unknown>;
g.switchTab = switchTab;
g.toggleAccordion = toggleAccordion;
g.toggleAllExecutionAccordions = toggleAllExecutionAccordions;
g.toggleExecutionMode = toggleExecutionMode;
g.toggleKillSwitch = toggleKillSwitch;
g.refreshBridgeConnection = refreshBridgeConnection;
g.copyCommand = copyCommand;
g.selectOrderSide = selectOrderSide;
g.updateSymbolQuotes = updateSymbolQuotes;
g.refreshQuote = refreshQuote;
g.syncDeskProfile = syncDeskProfile;
g.adjustVolume = adjustVolume;
g.updateOrderButtonLabel = updateOrderButtonLabel;
g.submitOrderTicket = submitOrderTicket;
g.saveRiskGates = saveRiskGates;
g.flattenAllPositions = flattenAllPositions;
g.selectTimeframe = selectTimeframe;
g.openSignInModal = openSignInModal;
g.closeSignInModal = closeSignInModal;
g.pairBridge = pairBridge;
g.unpairBridge = unpairBridge;
g.closePosition = closePosition;
g.showToast = showToast;

/* ------------------------------------------------------------------ */
/* Mount                                                               */
/* ------------------------------------------------------------------ */
async function mountDesign(): Promise<void> {
  user = getCurrentUser();
  if (!user?.username) {
    location.replace('/login.html');
    return;
  }

  const memberHandle = document.getElementById('member-handle');
  if (memberHandle) memberHandle.textContent = `MEMBER · @${user.username}`;
  const indicator = document.getElementById('auth-indicator');
  if (indicator) indicator.className = 'w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]';

  restoreProfile();
  setSafety(true);
  paintMode();
  setBridgePill('unpaired', 'BRIDGE: NOT PAIRED');
  applyDataMode();

  const symbolSelect = document.getElementById('ticket-symbol') as HTMLSelectElement | null;
  if (symbolSelect) curatedOptions = symbolSelect.innerHTML;

  document.getElementById('ticket-volume')?.addEventListener('input', updateOrderButtonLabel);
  document.getElementById('ticket-symbol')?.addEventListener('change', updateSymbolQuotes);

  switchTab('overview');
  renderPositionsTable();
  await connectBridge(false);

  setInterval(() => {
    void tick();
  }, 5000);
}

export function mountMember(): void {
  if (typeof document === 'undefined') return;
  void mountDesign();
}
