/**
 * Execution desk — browser client for the local MT5 bridge.
 *
 * The bridge is a loopback HTTP service the visitor runs on their own PC
 * (127.0.0.1:8899). This module pairs with it using a token the visitor pastes,
 * then polls it. Nothing here talks to the broker directly, and the token never
 * leaves this browser except to that loopback address.
 *
 * Polling is automatic (no refresh button): fast cadence for the book and the
 * account, slower for the registry and diagnostics.
 */

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

type Json = Record<string, any>;

interface Pairing {
  url: string;
  token: string;
}

interface StatusPayload {
  ok: boolean;
  service: string;
  version: string;
  startedAt: string;
  lastError: string | null;
  mode: 'live' | 'simulation';
  tradingEnabled: boolean;
  provider: Json;
  account: Json | null;
  accountError: string | null;
  risk: Json;
  safety: Json;
  cloud: Json;
  counts: Json;
  server: Json;
}

interface Terminal {
  path: string;
  installDir: string;
  name: string;
  dataDir: string | null;
  portable: boolean;
  running: boolean;
  lastUsed: number | null;
  installed: boolean;
}

interface Diagnostics {
  package: { installed: boolean; version: string | null; platform: string; terminals: number };
  terminals: Terminal[];
  suggestedPath: string | null;
  active: Json | null;
  mode: string;
  connected: boolean;
  allowLiveTrades: boolean;
}

interface SymbolRow {
  symbol: string;
  description: string;
  digits: number;
  pip: number;
  contract: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
  spreadPips: number;
  price: number;
  tradable: boolean;
  marketOpen: boolean;
  strategySymbol: string | null;
}

interface Position {
  ticket: number;
  symbol: string;
  side: 'buy' | 'sell';
  volume: number;
  openPrice: number;
  currentPrice: number;
  sl: number | null;
  tp: number | null;
  profit: number;
  strategyId: string | null;
  comment: string;
  opened: string;
}

interface StrategyRow {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  autoExecute: boolean;
  performance: Json;
}

interface PerfRow {
  id: string;
  name: string;
  successRate: number;
  profitFactor: number | null;
  score: number;
  confidence: string;
  sample: number;
  expectancyR: number | null;
  maxDrawdownPct: number | null;
  evidence: string;
}

interface SignalRow {
  id: string;
  strategyId: string;
  strategyName?: string;
  symbol: string;
  side: 'buy' | 'sell';
  entry: number | null;
  sl: number | null;
  tp: number | null;
  confidence: number | null;
  note: string;
  status: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

const API_BASE = (document.querySelector('main.ex')?.getAttribute('data-api') ?? '').replace(/\/+$/, '');
const LS_KEY = 'vaelor.bridge.pairing';
const DEFAULT_URL = 'http://127.0.0.1:8899';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const el = (id: string): HTMLElement | null => document.getElementById(id);

let pairing: Pairing = { url: DEFAULT_URL, token: '' };
let status: StatusPayload | null = null;
let diagnostics: Diagnostics | null = null;
let symbols: SymbolRow[] = [];
let positions: Position[] = [];
let orders: Json[] = [];
let strategies: StrategyRow[] = [];
let performance: Json | null = null;
let signals: SignalRow[] = [];
let quote: Json | null = null;
let audit: Json[] = [];
let orderSide: 'buy' | 'sell' = 'buy';
let selectedSymbol = 'XAUUSD';
let pollTimer: number | null = null;
let diagTimer: number | null = null;
let pollBusy = false;
let lastPollAt = 0;
let authFailed = false;
let lastBacktest: Json | null = null;
let backtestBusy = false;
const editorOpen = new Set<number>();

/* ------------------------------------------------------------------ */
/* Pairing + HTTP                                                     */
/* ------------------------------------------------------------------ */

function loadPairing(): void {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<Pairing>;
    if (typeof parsed.url === 'string' && parsed.url.trim()) pairing.url = parsed.url.trim();
    if (typeof parsed.token === 'string') pairing.token = parsed.token;
  } catch {
    /* corrupt storage is not fatal */
  }
}

function savePairing(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(pairing));
  } catch {
    /* private mode */
  }
}

class ApiError extends Error {
  status: number;
  retcode?: number | null;
  hint?: string | null;

  constructor(message: string, status = 0, retcode?: number | null, hint?: string | null) {
    super(message);
    this.status = status;
    this.retcode = retcode;
    this.hint = hint;
  }
}

async function api<T = any>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const { method = 'GET', body } = options;
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-bridge-token': pairing.token,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${pairing.url.replace(/\/+$/, '')}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
    });
  } catch (err) {
    throw new ApiError(
      'Cannot reach the bridge. Is it running, and is the URL exactly http://127.0.0.1:8899?',
    );
  }

  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const detail = payload?.detail ?? payload;
    if (typeof detail === 'string') {
      throw new ApiError(detail, response.status);
    }
    if (detail && typeof detail === 'object') {
      throw new ApiError(
        String(detail.error ?? detail.message ?? `HTTP ${response.status}`),
        response.status,
        detail.retcode ?? null,
        detail.hint ?? null,
      );
    }
    throw new ApiError(`HTTP ${response.status}`, response.status);
  }
  return payload as T;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                         */
/* ------------------------------------------------------------------ */

const num = (value: unknown, digits = 2): string => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

const money = (value: unknown, currency = 'USD'): string => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  try {
    return n.toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 2 });
  } catch {
    return `${num(n, 2)} ${currency}`;
  }
};

const signed = (value: unknown, digits = 2): string => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${num(n, digits)}`;
};

const cls = (value: number | null | undefined): string =>
  value == null || Number(value) === 0 ? 'flat' : Number(value) > 0 ? 'pos' : 'neg';

const stamp = (iso: string | number | null | undefined): string => {
  if (iso == null || iso === '') return '—';
  const date =
    typeof iso === 'number' ? new Date(iso * 1000) : new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', {
    year: '2-digit',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const truncate = (value: unknown, length = 90): string => {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};

/* ------------------------------------------------------------------ */
/* Toast                                                             */
/* ------------------------------------------------------------------ */

let toastTimer: number | null = null;

function toast(message: string, kind: 'ok' | 'bad' | 'info' = 'info'): void {
  const node = $('toast');
  node.textContent = message;
  node.className = `ex-toast ${kind}`;
  node.hidden = false;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node.hidden = true;
  }, kind === 'bad' ? 9000 : 5000);
}

function showError(err: unknown): void {
  if (err instanceof ApiError) {
    const parts = [err.message];
    if (err.hint && !err.message.includes(err.hint)) parts.push(err.hint);
    toast(parts.join(' — '), 'bad');
    if (el('orderHint')) {
      const showHint = err.hint && !err.message.toLowerCase().includes(err.hint.toLowerCase());
      $('orderHint').innerHTML = `${escapeHtml(err.message)}${
        showHint ? ` <span class="ex-mono">${escapeHtml(err.hint)}</span>` : ''
      }${err.retcode ? ` <b>retcode ${err.retcode}</b>` : ''}`;
    }
  } else {
    toast(err instanceof Error ? err.message : String(err), 'bad');
  }
}

/* ------------------------------------------------------------------ */
/* Polling                                                            */
/* ------------------------------------------------------------------ */

function startPolling(): void {
  if (pollTimer) window.clearInterval(pollTimer);
  if (diagTimer) window.clearInterval(diagTimer);
  void poll();
  pollTimer = window.setInterval(() => void poll(), 5000);
  diagTimer = window.setInterval(() => {
    if (!document.hidden) void refreshDiagnostics(true);
  }, 20000);
}

function stopPolling(): void {
  if (pollTimer) window.clearInterval(pollTimer);
  if (diagTimer) window.clearInterval(diagTimer);
  pollTimer = null;
  diagTimer = null;
}

async function poll(): Promise<void> {
  if (pollBusy || authFailed || !pairing.token) return;
  pollBusy = true;
  try {
    const [statusResult, bookResult] = await Promise.allSettled([
      api<StatusPayload>('/api/status'),
      api<{ positions: Position[]; orders: Json[] }>('/api/positions'),
    ]);

    if (statusResult.status === 'rejected' || bookResult.status === 'rejected') {
      const error = (statusResult as PromiseRejectedResult).reason ?? (bookResult as PromiseRejectedResult).reason;
      handlePollFailure(error);
      return;
    }

    status = statusResult.value;
    positions = bookResult.value.positions ?? [];
    orders = bookResult.value.orders ?? [];
    authFailed = false;

    renderStatus();
    renderAccount();
    renderRisk();
    renderPositions();
    renderOrders();

    const tasks: Promise<void>[] = [
      api<{ signals: SignalRow[] }>('/api/signals?status=pending')
        .then((body) => {
          signals = body.signals ?? [];
          renderSignals();
        })
        .catch(() => undefined),
      api<Json>('/api/performance')
        .then((body) => {
          performance = body;
          renderPerformance();
          renderStrategyPerformance();
        })
        .catch(() => undefined),
      api<{ entries: Json[] }>('/api/audit?limit=80')
        .then((body) => {
          audit = body.entries ?? [];
          renderAudit();
        })
        .catch(() => undefined),
      refreshStrategies(true),
      refreshQuote(),
    ];
    await Promise.allSettled(tasks);

    lastPollAt = Date.now();
    $('lastPoll').textContent = `poll: ${new Date(lastPollAt).toLocaleTimeString('en-GB')}`;
  } finally {
    pollBusy = false;
  }
}

function handlePollFailure(error: unknown): void {
  const status404 = error instanceof ApiError ? error.status : 0;
  if (status404 === 401 || status404 === 403) {
    authFailed = true;
    renderOffline('Token rejected by the bridge. Copy the token printed in the bridge console again.');
    return;
  }
  if (status404 === 0) {
    renderOffline('Bridge not reachable. Start it with run.cmd, then check the URL.');
    return;
  }
  renderOffline(error instanceof Error ? error.message : String(error));
}

/* ------------------------------------------------------------------ */
/* Rendering · status / account / risk                                */
/* ------------------------------------------------------------------ */

function setBadge(id: string, text: string, variant: 'live' | 'sim' | 'off' | '' = ''): void {
  const node = el(id);
  if (!node) return;
  node.textContent = text;
  const base = id === 'modeBadge' || id === 'tradeBadge' || id === 'cloudBadge' ? 'badge ex-badge' : 'ex-chip';
  node.className = `${base}${variant ? ` ${variant}` : ''}`;
}

function renderStatus(): void {
  if (!status) return;
  const live = status.mode === 'live';
  const connected = status.provider?.connected !== false;
  const trading = Boolean(status.tradingEnabled);

  $('connDot').className = `ex-pulse ${live ? 'ex-pulse-live' : connected ? 'ex-pulse-on' : 'ex-pulse-warn'}`;
  $('connLabel').textContent = live
    ? 'CONNECTED TO METATRADER 5'
    : connected
      ? 'BRIDGE CONNECTED · SIMULATION'
      : 'BRIDGE CONNECTED · TERMINAL LOST';
  $('connSub').textContent = live
    ? `${status.account?.company ?? 'Live terminal'} · ${status.account?.server ?? ''} · build ${
        status.provider?.terminal?.build ?? '—'
      }`
    : 'Safe simulation broker is active. Connect a terminal below to route real orders.';

  setBadge('modeBadge', live ? 'MODE · LIVE' : 'MODE · SIMULATION', live ? 'live' : 'sim');
  setBadge('tradeBadge', trading ? 'TRADING · ENABLED' : 'TRADING · LOCKED', trading ? 'live' : 'off');

  const cloud = status.cloud ?? {};
  const cloudOk = Boolean(cloud.ok);
  setBadge(
    'cloudBadge',
    cloudOk ? `CLOUD · ${cloud.strategies ?? 0} strategies` : 'CLOUD · idle',
    cloudOk ? 'sim' : 'off',
  );

  setBadge('setupChip', live ? 'terminal connected' : 'paired · simulation', live ? 'ok' : 'warn');
  setBadge('ticketChip', live ? 'live routing' : 'simulation fills', live ? 'warn' : '');
  setBadge('cloudState', cloudOk ? `synced ${stamp(cloud.lastSync)}` : 'cloud idle', cloudOk ? 'ok' : '');
  if (el('forgetBtn')) $('forgetBtn').hidden = false;

  const autotrading = Boolean(status.provider?.autotrading);
  if (el('autotradingNote')) $('autotradingNote').hidden = !live || autotrading;
  if (el('accountNote')) {
    $('accountNote').textContent = live
      ? autotrading
        ? 'AutoTrading is on. Orders still need the bridge interlock and this page’s confirmation.'
        : 'AutoTrading is off in the terminal — orders will be rejected by MetaTrader 5 until you enable it.'
      : 'Simulation fills are virtual and clearly labelled. No broker order is sent.';
  }
}

function renderAccount(): void {
  const panel = el('accountPanel');
  if (!panel || !status) return;
  const account = status.account;
  if (!account) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const currency = String(account.currency ?? 'USD');
  $('acctLogin').textContent = String(account.login ?? '—');
  $('acctServer').textContent = String(account.server ?? '—');
  $('acctCompany').textContent = String(account.company ?? '—');
  $('acctName').textContent = String(account.name ?? '—');
  $('acctBalance').textContent = money(account.balance, currency);
  $('acctEquity').textContent = money(account.equity, currency);
  $('acctFree').textContent = money(account.freeMargin, currency);
  const profit = Number(account.profit ?? 0);
  $('acctProfit').textContent = money(profit, currency);
  $('acctProfit').className = cls(profit);
  $('acctLeverage').textContent = `1:${account.leverage ?? '—'}`;
  $('acctAutotrading').textContent =
    status.mode === 'live' ? (status.provider?.autotrading ? 'ON' : 'OFF') : 'simulated';
  $('acctAutotrading').className = status.mode === 'live' && !status.provider?.autotrading ? 'neg' : 'pos';
  setBadge('acctMode', status.mode === 'live' ? 'MT5 · LIVE' : 'SIMULATED', status.mode === 'live' ? 'live' : 'sim');
}

function renderRisk(): void {
  if (!status?.risk) return;
  const risk = status.risk;
  const set = (id: string, value: unknown) => {
    const input = el(id) as HTMLInputElement | null;
    if (input && document.activeElement !== input) input.value = String(value ?? '');
  };
  set('riskPerTrade', risk.riskPerTradePct);
  set('riskMaxLot', risk.maxLotPerTrade);
  set('riskMaxPositions', risk.maxOpenPositions);
  set('riskMaxDailyLoss', risk.maxDailyLossPct);
  set('riskMaxDD', risk.maxDrawdownPct);
  set('riskWhitelist', (risk.symbolWhitelist ?? []).join(', '));
  const market = el('riskAllowMarket') as HTMLInputElement | null;
  if (market) market.checked = Boolean(risk.allowMarketOrders);

  const kill = Boolean(risk.killSwitch);
  setBadge('killChip', kill ? 'HALTED' : 'armed', kill ? 'bad' : 'ok');
  const killBtn = el('killBtn') as HTMLButtonElement | null;
  const release = el('releaseKillBtn') as HTMLButtonElement | null;
  if (killBtn) killBtn.hidden = kill;
  if (release) release.hidden = !kill;
  if (el('killState')) {
    $('killState').textContent = kill
      ? 'Kill switch is ENGAGED — every new order is blocked.'
      : 'Kill switch is off.';
  }
}

/* ------------------------------------------------------------------ */
/* Diagnostics / connect wizard                                       */
/* ------------------------------------------------------------------ */

async function refreshDiagnostics(silent = false): Promise<void> {
  if (!pairing.token) return;
  try {
    diagnostics = await api<Diagnostics>('/api/mt5/diagnostics');
    renderDiagnostics(silent);
  } catch (err) {
    if (!silent) showError(err);
  }
}

function renderDiagnostics(silent = false): void {
  if (!diagnostics) return;
  const wrap = el('diagWrap');
  if (wrap) wrap.hidden = false;

  const pkg = diagnostics.package;
  const installed = pkg.installed;
  $('diagSummary').textContent = installed
    ? `${diagnostics.terminals.length} terminal${diagnostics.terminals.length === 1 ? '' : 's'} detected · MetaTrader5 package ${pkg.version ?? ''}`
    : 'MetaTrader5 Python package is not installed in the bridge environment';

  const activePath = String(diagnostics.active?.terminalPath ?? status?.provider?.terminalPath ?? '');
  const body = $('terminalList');
  if (!diagnostics.terminals.length) {
    body.innerHTML = `<tr><td colspan="4" class="ex-empty">${
      installed
        ? 'No MetaTrader 5 terminal found. Install one from your broker, open it and log in, then rescan.'
        : 'Install MetaTrader 5, then run the bridge setup again so it can install the MetaTrader5 package.'
    }</td></tr>`;
  } else {
    body.innerHTML = diagnostics.terminals
      .map((terminal) => {
        const active = activePath && terminal.path.toLowerCase() === activePath.toLowerCase();
        const statusTag = terminal.running
          ? '<span class="ex-tag ok">running</span>'
          : terminal.installed
            ? '<span class="ex-tag">installed</span>'
            : '<span class="ex-tag bad">missing</span>';
        return `<tr>
          <td><b>${escapeHtml(terminal.name)}</b><span class="sub">${escapeHtml(terminal.path)}</span></td>
          <td>${statusTag}${terminal.portable ? ' <span class="ex-tag warn">portable</span>' : ''}</td>
          <td class="ex-mono-cell">${escapeHtml(terminal.dataDir ?? '—')}</td>
          <td class="right">${
            active
              ? '<span class="ex-tag ok">connected</span>'
              : `<button type="button" class="ex-btn small" data-terminal="${escapeHtml(
                  terminal.path,
                )}" data-portable="${terminal.portable ? '1' : '0'}">Connect</button>`
          }</td>
        </tr>`;
      })
      .join('');
  }

  if (el('autotradingNote')) {
    $('autotradingNote').hidden = !(diagnostics.connected && !diagnostics.active?.autotrading);
  }
  if (el('disconnectBtn')) $('disconnectBtn').hidden = !diagnostics.connected;
  if (!silent) {
    const key = diagnostics.connected ? 'ok' : 'warn';
    setBadge('setupChip', diagnostics.connected ? 'terminal connected' : 'bridge paired', key);
  }
}

async function connectTerminal(path: string, portable: boolean): Promise<void> {
  const payload: Json = { path, portable };
  const login = (el('loginLogin') as HTMLInputElement | null)?.value.trim();
  const server = (el('loginServer') as HTMLInputElement | null)?.value.trim();
  const password = (el('loginPassword') as HTMLInputElement | null)?.value;
  if (login) payload.login = Number(login);
  if (server) payload.server = server;
  if (password) payload.password = password;

  try {
    toast('Connecting to the terminal…', 'info');
    const result = await api<Json>('/api/mt5/connect', { method: 'POST', body: payload });
    if (el('loginPassword')) (el('loginPassword') as HTMLInputElement).value = '';
    toast(`Connected to ${result.provider?.account?.server ?? 'MetaTrader 5'}.`, 'ok');
    await poll();
    await refreshDiagnostics(true);
  } catch (err) {
    showError(err);
  }
}

/* ------------------------------------------------------------------ */
/* Symbols, quote, order ticket                                       */
/* ------------------------------------------------------------------ */

async function loadSymbols(): Promise<void> {
  try {
    const body = await api<{ symbols: SymbolRow[] }>('/api/symbols');
    symbols = body.symbols ?? [];
    fillSymbolSelects();
  } catch {
    /* the book still works without the full list */
  }
}

function fillSymbolSelects(): void {
  const select = el('orderSymbol') as HTMLSelectElement | null;
  if (!select || !symbols.length) return;
  const previous = selectedSymbol;
  const preferred = ['XAUUSD', 'XAGUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'US30', 'NAS100', 'BTCUSD'];
  const sorted = [...symbols].sort((a, b) => {
    const ai = preferred.indexOf(a.symbol.replace(/[._-].*$/, ''));
    const bi = preferred.indexOf(b.symbol.replace(/[._-].*$/, ''));
    if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return a.symbol.localeCompare(b.symbol);
  });
  select.innerHTML = sorted
    .map(
      (row) =>
        `<option value="${escapeHtml(row.symbol)}">${escapeHtml(row.symbol)} — ${escapeHtml(
          row.description ?? '',
        )}</option>`,
    )
    .join('');
  const match = sorted.find((row) => row.symbol === previous) ?? sorted.find((row) => row.symbol === 'XAUUSD') ?? sorted[0];
  if (match) {
    select.value = match.symbol;
    selectedSymbol = match.symbol;
  }
}

async function refreshQuote(): Promise<void> {
  if (!pairing.token) return;
  try {
    quote = await api<Json>(`/api/quote?symbol=${encodeURIComponent(selectedSymbol)}`);
    renderQuote();
  } catch {
    /* market may be closed */
  }
}

function renderQuote(): void {
  if (!quote) return;
  $('qBid').textContent = num(quote.bid, quote.bid > 1000 ? 2 : 5);
  $('qAsk').textContent = num(quote.ask, quote.ask > 1000 ? 2 : 5);
  $('qSpread').textContent = `${num(quote.spreadPips, 1)} pips`;
  const change = Number(quote.changePct ?? 0);
  $('qChange').textContent = `${signed(change, 2)}%`;
  $('qChange').className = cls(change);
}

function setSide(side: 'buy' | 'sell'): void {
  orderSide = side;
  const buy = el('sideBuy');
  const sell = el('sideSell');
  if (buy) buy.classList.toggle('active', side === 'buy');
  if (sell) sell.classList.toggle('active', side === 'sell');
}

async function placeOrder(): Promise<void> {
  const confirmBox = el('orderConfirm') as HTMLInputElement | null;
  if (!confirmBox?.checked) {
    toast('Tick the confirmation box before placing an order.', 'bad');
    return;
  }
  if (!pairing.token) {
    toast('Pair the bridge first.', 'bad');
    return;
  }

  const volume = Number((el('orderVolume') as HTMLInputElement)?.value ?? 0);
  if (!(volume > 0)) {
    toast('Volume must be greater than zero.', 'bad');
    return;
  }

  const button = el('placeOrderBtn') as HTMLButtonElement;
  button.disabled = true;
  try {
    const price = orderSide === 'buy' ? quote?.ask : quote?.bid;
    const body: Json = {
      symbol: selectedSymbol,
      side: orderSide,
      volume,
      type: 'market',
      comment: (el('orderComment') as HTMLInputElement)?.value.trim() || 'execution desk',
      confirm: true,
    };
    const sl = Number((el('orderSl') as HTMLInputElement)?.value);
    const tp = Number((el('orderTp') as HTMLInputElement)?.value);
    if (Number.isFinite(sl) && sl > 0) body.sl = sl;
    if (Number.isFinite(tp) && tp > 0) body.tp = tp;
    const strategyId = (el('orderStrategy') as HTMLSelectElement)?.value;
    if (strategyId) body.strategyId = strategyId;

    const result = await api<Json>('/api/orders', { method: 'POST', body });
    const fill = result.order ?? {};
    const label = result.mode === 'live' ? 'LIVE order' : 'Simulation fill';
    toast(
      `${label} ${orderSide.toUpperCase()} ${volume} ${selectedSymbol} at ${num(fill.price ?? price, 5)} · ticket ${
        fill.ticket ?? '—'
      }`,
      'ok',
    );
    confirmBox.checked = false;
    await poll();
  } catch (err) {
    showError(err);
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Positions / orders                                                 */
/* ------------------------------------------------------------------ */

function renderPositions(): void {
  const body = el('positionsBody');
  if (!body) return;
  $('posCount').textContent = `${positions.length} position${positions.length === 1 ? '' : 's'}`;
  if (!positions.length) {
    body.innerHTML = `<tr><td colspan="11" class="ex-empty">${
      status?.mode === 'live'
        ? 'No open positions on this account.'
        : 'No simulated positions. Place a simulated order to test the desk.'
    }</td></tr>`;
    return;
  }

  const rows: string[] = [];
  for (const pos of positions) {
    const digits = pos.currentPrice > 1000 ? 2 : 5;
    rows.push(`<tr data-ticket="${pos.ticket}">
      <td class="ex-mono-cell">${pos.ticket}</td>
      <td class="sym">${escapeHtml(pos.symbol)}</td>
      <td><span class="ex-tag ${pos.side === 'buy' ? 'ok' : 'bad'}">${pos.side.toUpperCase()}</span></td>
      <td class="right ex-mono-cell">${num(pos.volume, 2)}</td>
      <td class="right ex-mono-cell">${num(pos.openPrice, digits)}</td>
      <td class="right ex-mono-cell">${num(pos.currentPrice, digits)}</td>
      <td class="right ex-mono-cell">${pos.sl ? num(pos.sl, digits) : '—'}</td>
      <td class="right ex-mono-cell">${pos.tp ? num(pos.tp, digits) : '—'}</td>
      <td class="right ex-mono-cell ${cls(pos.profit)}">${signed(pos.profit, 2)}</td>
      <td class="ex-mono-cell">${escapeHtml(pos.strategyId ?? 'manual')}${
        status?.mode === 'live' ? '' : '<span class="sub">simulated fill</span>'
      }</td>
      <td class="right">
        <button type="button" class="ex-btn small" data-act="edit" data-ticket="${pos.ticket}">SL/TP</button>
        <button type="button" class="ex-btn small" data-act="be" data-ticket="${pos.ticket}">BE</button>
        <button type="button" class="ex-btn small" data-act="trail" data-ticket="${pos.ticket}">Trail</button>
        <button type="button" class="ex-btn small danger" data-act="close" data-ticket="${pos.ticket}">Close</button>
      </td>
    </tr>`);

    if (editorOpen.has(pos.ticket)) {
      rows.push(`<tr class="ex-edit-row" data-editor="${pos.ticket}">
        <td colspan="11">
          <div class="ex-edit-grid">
            <div class="ex-field"><label>Stop loss</label><input type="number" step="any" data-edit="sl" value="${pos.sl ?? ''}" /></div>
            <div class="ex-field"><label>Take profit</label><input type="number" step="any" data-edit="tp" value="${pos.tp ?? ''}" /></div>
            <button type="button" class="ex-btn small primary" data-act="save" data-ticket="${pos.ticket}">Save stops</button>
            <div class="ex-field"><label>Close volume</label><input type="number" step="0.01" min="0.01" max="${pos.volume}" data-edit="volume" value="${pos.volume}" /></div>
            <button type="button" class="ex-btn small danger" data-act="partial" data-ticket="${pos.ticket}">Close volume</button>
            <button type="button" class="ex-btn small ghost" data-act="cancel" data-ticket="${pos.ticket}">Cancel</button>
          </div>
        </td>
      </tr>`);
    }
  }
  body.innerHTML = rows.join('');
}

function renderOrders(): void {
  const body = el('ordersBody');
  if (!body) return;
  const count = el('ordersCount');
  if (count) count.textContent = String(orders.length);
  if (!orders.length) {
    body.innerHTML = '<tr><td colspan="9" class="ex-empty">No pending orders.</td></tr>';
    return;
  }
  body.innerHTML = orders
    .map(
      (order) => `<tr>
        <td class="ex-mono-cell">${escapeHtml(order.ticket)}</td>
        <td class="sym">${escapeHtml(order.symbol)}</td>
        <td><span class="ex-tag ${order.side === 'buy' ? 'ok' : 'bad'}">${escapeHtml(
          String(order.side ?? '').toUpperCase(),
        )}</span></td>
        <td>${escapeHtml(order.type ?? '—')}</td>
        <td class="right ex-mono-cell">${num(order.volume, 2)}</td>
        <td class="right ex-mono-cell">${num(order.price, 5)}</td>
        <td class="right ex-mono-cell">${order.sl ? num(order.sl, 5) : '—'}</td>
        <td class="right ex-mono-cell">${order.tp ? num(order.tp, 5) : '—'}</td>
        <td class="ex-mono-cell">${escapeHtml(order.strategyId ?? 'manual')}</td>
      </tr>`,
    )
    .join('');
}

async function positionAction(ticket: number, action: string, row: HTMLElement): Promise<void> {
  try {
    if (action === 'edit') {
      if (editorOpen.has(ticket)) editorOpen.delete(ticket);
      else editorOpen.add(ticket);
      renderPositions();
      return;
    }
    if (action === 'cancel') {
      editorOpen.delete(ticket);
      renderPositions();
      return;
    }
    if (action === 'be') {
      await api(`/api/positions/${ticket}/breakeven`, { method: 'POST' });
      toast(`Stop moved to break-even on ticket ${ticket}.`, 'ok');
      await poll();
      return;
    }
    if (action === 'trail') {
      const distance = Number((el('trailPips') as HTMLInputElement)?.value ?? 0);
      if (!(distance > 0)) {
        toast('Enter a trail distance in pips.', 'bad');
        return;
      }
      await api(`/api/positions/${ticket}/trail`, { method: 'POST', body: { distancePips: distance } });
      toast(`Stop trailed ${distance} pips on ticket ${ticket}.`, 'ok');
      await poll();
      return;
    }
    if (action === 'close') {
      if (!window.confirm(`Close the full position on ticket ${ticket}?`)) return;
      await api(`/api/positions/${ticket}/close`, { method: 'POST', body: {} });
      editorOpen.delete(ticket);
      toast(`Close sent for ticket ${ticket}.`, 'ok');
      await poll();
      return;
    }
    if (action === 'save') {
      const editor = document.querySelector<HTMLElement>(`tr[data-editor="${ticket}"]`);
      const sl = (editor?.querySelector<HTMLInputElement>('input[data-edit="sl"]')?.value ?? '').trim();
      const tp = (editor?.querySelector<HTMLInputElement>('input[data-edit="tp"]')?.value ?? '').trim();
      const body: Json = {};
      body.sl = sl ? Number(sl) : 0;
      body.tp = tp ? Number(tp) : 0;
      await api(`/api/positions/${ticket}/modify`, { method: 'POST', body });
      editorOpen.delete(ticket);
      toast(`Stops updated on ticket ${ticket}.`, 'ok');
      await poll();
      return;
    }
    if (action === 'partial') {
      const editor = document.querySelector<HTMLElement>(`tr[data-editor="${ticket}"]`);
      const volume = Number(editor?.querySelector<HTMLInputElement>('input[data-edit="volume"]')?.value ?? 0);
      if (!(volume > 0)) {
        toast('Enter a volume to close.', 'bad');
        return;
      }
      const result = await api<Json>(`/api/positions/${ticket}/close`, { method: 'POST', body: { volume } });
      const remaining = result.position?.remainingVolume;
      toast(
        remaining ? `Closed ${volume} lots · ${num(remaining, 2)} remaining.` : `Ticket ${ticket} fully closed.`,
        'ok',
      );
      await poll();
    }
  } catch (err) {
    showError(err);
  }
}

/* ------------------------------------------------------------------ */
/* Strategies                                                         */
/* ------------------------------------------------------------------ */

async function refreshStrategies(silent = false): Promise<void> {
  if (!pairing.token) return;
  try {
    const [list, perf] = await Promise.all([
      api<{ strategies: StrategyRow[] }>('/api/strategies'),
      performance ? Promise.resolve(performance) : api<Json>('/api/performance').catch(() => null),
    ]);
    strategies = list.strategies ?? [];
    if (perf) performance = perf as Json;
    renderStrategies();
    renderStrategyPerformance();
    fillStrategySelects();
    if (!silent) toast('Strategy registry refreshed.', 'ok');
  } catch (err) {
    if (!silent) showError(err);
  }
}

const perfFor = (id: string): PerfRow | undefined =>
  (performance?.strategies ?? []).find((row: PerfRow) => row.id === id) as PerfRow | undefined;

function renderStrategies(): void {
  const body = el('strategiesBody');
  if (!body) return;
  if (!strategies.length) {
    body.innerHTML =
      '<tr><td colspan="9" class="ex-empty">No strategies yet. Publish one through the AI/MCP bridge or register a manifest.</td></tr>';
    return;
  }
  body.innerHTML = strategies
    .map((strategy) => {
      const perf = perfFor(strategy.id);
      return `<tr>
        <td><b>${escapeHtml(strategy.name)}</b><span class="sub">${escapeHtml(strategy.id)}</span></td>
        <td><span class="ex-tag">${escapeHtml(strategy.source ?? 'local')}</span></td>
        <td>${perf ? escapeHtml(perf.evidence) : '—'}</td>
        <td class="right ex-mono-cell">${perf ? num(perf.sample, 0) : '—'}</td>
        <td class="right ex-mono-cell">${perf ? (perf.sample ? `${num(perf.successRate, 1)}%` : '—') : '—'}</td>
        <td class="right ex-mono-cell">${perf ? num(perf.score, 1) : '—'}</td>
        <td class="center"><label class="ex-toggle"><input type="checkbox" data-toggle="enabled" data-id="${escapeHtml(
          strategy.id,
        )}" ${strategy.enabled ? 'checked' : ''} /></label></td>
        <td class="center"><label class="ex-toggle"><input type="checkbox" data-toggle="autoExecute" data-id="${escapeHtml(
          strategy.id,
        )}" ${strategy.autoExecute ? 'checked' : ''} /></label></td>
        <td class="right"><button type="button" class="ex-btn small" data-backtest="${escapeHtml(strategy.id)}">Backtest</button></td>
      </tr>`;
    })
    .join('');
}

function renderStrategyPerformance(): void {
  const perf = performance;
  if (!perf) return;
  const rows: PerfRow[] = perf.strategies ?? [];
  const body = el('perfBody');
  if (!body) return;
  $('perfChip').textContent = `${rows.length} measured · ${perf.mode ?? '—'}`;
  const note = perf.overall;
  if (el('perfNote')) {
    $('perfNote').textContent = note
      ? `Desk-wide realised results: ${note.trades ?? 0} closed trades · win rate ${num(
          note.winRate ?? 0,
          1,
        )}% · profit factor ${note.profitFactor ?? '—'} · expectancy ${note.expectancyR ?? '—'}R. ` +
        'Evidence is labelled backtest or live; live only takes over after 10 closed trades.'
      : 'No closed trades yet.';
  }
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="9" class="ex-empty">No measured results yet — run a backtest.</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map(
      (row) => `<tr>
        <td><b>${escapeHtml(row.name ?? row.id)}</b><span class="sub">${escapeHtml(row.id)}</span></td>
        <td><span class="ex-tag ${row.evidence === 'live' ? 'ok' : row.evidence === 'backtest' ? 'warn' : ''}">${escapeHtml(row.evidence)}</span></td>
        <td class="right ex-mono-cell">${num(row.sample, 0)}</td>
        <td class="right ex-mono-cell">${row.sample ? `${num(row.successRate, 1)}%` : '—'}</td>
        <td class="right ex-mono-cell">${row.profitFactor == null ? '—' : num(row.profitFactor, 2)}</td>
        <td class="right ex-mono-cell ${cls(row.expectancyR)}">${row.expectancyR == null ? '—' : `${signed(row.expectancyR, 2)}R`}</td>
        <td class="right ex-mono-cell">${row.maxDrawdownPct == null ? '—' : `${num(row.maxDrawdownPct, 1)}%`}</td>
        <td class="right ex-mono-cell"><b>${num(row.score, 1)}</b></td>
        <td><span class="ex-tag ${
          row.confidence === 'high' ? 'ok' : row.confidence === 'medium' ? 'warn' : row.confidence === 'low' ? 'warn' : 'bad'
        }">${escapeHtml(row.confidence)}</span></td>
      </tr>`,
    )
    .join('');
}

function fillStrategySelects(): void {
  const backtestSelect = el('btStrategy') as HTMLSelectElement | null;
  const orderSelect = el('orderStrategy') as HTMLSelectElement | null;
  if (backtestSelect) {
    const previous = backtestSelect.value;
    backtestSelect.innerHTML = strategies
      .map((strategy) => `<option value="${escapeHtml(strategy.id)}">${escapeHtml(strategy.name)}</option>`)
      .join('');
    if (previous && strategies.some((strategy) => strategy.id === previous)) backtestSelect.value = previous;
  }
  if (orderSelect) {
    const previous = orderSelect.value;
    orderSelect.innerHTML =
      '<option value="">manual trade</option>' +
      strategies
        .map((strategy) => `<option value="${escapeHtml(strategy.id)}">${escapeHtml(strategy.name)}</option>`)
        .join('');
    if (previous && strategies.some((strategy) => strategy.id === previous)) orderSelect.value = previous;
  }
}

async function toggleStrategy(id: string, field: 'enabled' | 'autoExecute', checked: boolean): Promise<void> {
  const strategy = strategies.find((row) => row.id === id);
  if (!strategy) return;
  const enabled = field === 'enabled' ? checked : checked ? true : strategy.enabled;
  const autoExecute = field === 'autoExecute' ? checked : strategy.autoExecute;
  try {
    await api(`/api/strategies/${encodeURIComponent(id)}/toggle`, {
      method: 'POST',
      body: { enabled, autoExecute },
    });
    toast(
      autoExecute
        ? `${id}: trading enabled with auto-execute. Fresh signals can route unattended.`
        : enabled
          ? `${id}: trading enabled. Signals will wait for your approval.`
          : `${id}: trading disabled.`,
      autoExecute ? 'bad' : 'ok',
    );
    await refreshStrategies(true);
  } catch (err) {
    showError(err);
    await refreshStrategies(true);
  }
}

async function syncStrategies(): Promise<void> {
  try {
    const result = await api<{ cloud: Json }>('/api/strategies/sync', { method: 'POST' });
    const cloud = result.cloud ?? {};
    toast(
      cloud.ok
        ? `Cloud sync complete · ${cloud.strategies ?? 0} strategies · ${cloud.signals ?? 0} signals · ${
            cloud.decisions ?? 0
          } decisions sent.`
        : `Cloud sync failed: ${cloud.lastError ?? 'unknown error'}`,
      cloud.ok ? 'ok' : 'bad',
    );
    await Promise.allSettled([refreshStrategies(true), poll()]);
  } catch (err) {
    showError(err);
  }
}

/* ------------------------------------------------------------------ */
/* Backtest                                                           */
/* ------------------------------------------------------------------ */

async function runBacktest(): Promise<void> {
  if (backtestBusy) return;
  const strategyId = (el('btStrategy') as HTMLSelectElement)?.value;
  if (!strategyId) {
    toast('Pick a strategy to backtest.', 'bad');
    return;
  }
  const numberOr = (id: string, fallback: number | null = null): number | null => {
    const raw = (el(id) as HTMLInputElement | null)?.value.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };

  const body: Json = {
    strategyId,
    symbol: ((el('btSymbol') as HTMLInputElement)?.value ?? '').trim().toUpperCase() || selectedSymbol,
    timeframe: (el('btTimeframe') as HTMLSelectElement)?.value,
    initialBalance: numberOr('btBalance', 10000),
    spreadPips: numberOr('btSpread', 1),
    commissionPerLot: numberOr('btCommission', 0),
    leverage: numberOr('btLeverage', 100),
  };
  const riskPct = numberOr('btRisk');
  if (riskPct != null) body.riskPct = riskPct;

  const button = el('runBacktestBtn') as HTMLButtonElement;
  button.disabled = true;
  backtestBusy = true;
  $('btStatus').textContent = 'running on your broker history…';
  try {
    const result = await api<Json>('/api/backtest', { method: 'POST', body });
    lastBacktest = result;
    renderBacktest(result);
    toast(
      `Backtest complete · ${result.result?.stats?.trades ?? 0} trades · ${
        result.result?.stats?.winRate ?? 0
      }% win rate.`,
      'ok',
    );
    await poll();
  } catch (err) {
    $('btStatus').textContent = 'backtest failed';
    showError(err);
  } finally {
    button.disabled = false;
    backtestBusy = false;
  }
}

function renderBacktest(result: Json): void {
  const stats = result.result?.stats ?? {};
  const trades: Json[] = result.result?.trades ?? [];
  const equity: Json[] = result.result?.equity ?? [];
  $('btResult').hidden = false;
  $('btStatus').textContent = `${result.strategyId} · ${result.symbol} ${result.timeframe} · ${stats.bars ?? 0} bars`;
  $('btMeta').textContent = `${stamp(stats.start)} → ${stamp(stats.end)} · ${num(stats.bars, 0)} bars`;

  const cards: Array<[string, string, string?]> = [
    ['Trades', num(stats.trades, 0)],
    ['Win rate', `${num(stats.winRate, 1)}%`],
    ['Profit factor', stats.profitFactor == null ? '—' : num(stats.profitFactor, 2)],
    ['Expectancy R', stats.expectancyR == null ? '—' : `${signed(stats.expectancyR, 2)}R`],
    ['Max drawdown', stats.maxDrawdownPct == null ? '—' : `${num(stats.maxDrawdownPct, 1)}%`],
    ['Net profit', signed(stats.netProfit, 2)],
    ['Return', `${signed(stats.totalReturnPct, 1)}%`],
    ['Sharpe', num(stats.sharpe, 2)],
    ['Score', num(stats.score, 1)],
    ['Confidence', String(stats.confidence ?? '—')],
    ['Final equity', num(stats.finalEquity, 2)],
    ['Wilson lower', `${num(stats.wilsonLower, 1)}%`],
  ];
  $('btStats').innerHTML = cards
    .map(
      ([key, value]) =>
        `<div class="ex-stat"><span class="k">${escapeHtml(key)}</span><span class="v">${escapeHtml(value)}</span></div>`,
    )
    .join('');

  drawEquity(equity);

  const body = $('btTradesBody');
  const recent = trades.slice(-25).reverse();
  body.innerHTML = recent.length
    ? recent
        .map(
          (trade, offset) => `<tr>
            <td class="ex-mono-cell">${trades.length - offset}</td>
            <td class="ex-mono-cell">${stamp(trade.entryTime ?? trade.opened ?? trade.time)}</td>
            <td><span class="ex-tag ${trade.side === 'buy' ? 'ok' : 'bad'}">${escapeHtml(
              String(trade.side ?? '').toUpperCase(),
            )}</span></td>
            <td class="right ex-mono-cell">${num(trade.entry ?? trade.entryPrice, 5)}</td>
            <td class="right ex-mono-cell">${num(trade.exit ?? trade.exitPrice, 5)}</td>
            <td class="right ex-mono-cell ${cls(trade.pnl)}">${signed(trade.pnl, 2)}</td>
            <td class="right ex-mono-cell ${cls(trade.r)}">${trade.r == null ? '—' : `${signed(trade.r, 2)}R`}</td>
            <td class="right ex-mono-cell">${num(trade.bars, 0)}</td>
            <td>${escapeHtml(trade.reason ?? trade.exitReason ?? '—')}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="9" class="ex-empty">No trades were generated in this window.</td></tr>';
}

function drawEquity(points: Json[]): void {
  const canvas = el('btCanvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const context = canvas.getContext('2d');
  if (!context) return;

  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const cssWidth = canvas.clientWidth || 900;
  const cssHeight = 240;
  canvas.width = Math.max(1, Math.round(cssWidth * ratio));
  canvas.height = Math.round(cssHeight * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);

  const values = points.map((point) => Number(point.equity)).filter((value) => Number.isFinite(value));
  if (values.length < 2) {
    context.fillStyle = '#7c6e6f';
    context.font = '12px "JetBrains Mono", monospace';
    context.fillText('Not enough equity points to draw a curve.', 12, 24);
    return;
  }

  const pad = { left: 54, right: 12, top: 14, bottom: 24 };
  const width = cssWidth - pad.left - pad.right;
  const height = cssHeight - pad.top - pad.bottom;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(1, Math.abs(max) * 0.01);

  const xFor = (index: number): number => pad.left + (index / (values.length - 1)) * width;
  const yFor = (value: number): number => pad.top + height - ((value - min) / span) * height;

  context.strokeStyle = '#21141c';
  context.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (i / 4) * height;
    context.beginPath();
    context.moveTo(pad.left, y);
    context.lineTo(pad.left + width, y);
    context.stroke();
    const value = max - (i / 4) * span;
    context.fillStyle = '#7c6e6f';
    context.font = '10px "JetBrains Mono", monospace';
    context.fillText(value.toLocaleString('en-US', { maximumFractionDigits: 0 }), 4, y + 3);
  }

  const gain = values[values.length - 1] >= values[0];
  const stroke = gain ? '#5bd4a0' : '#e0656b';

  const gradient = context.createLinearGradient(0, pad.top, 0, pad.top + height);
  gradient.addColorStop(0, gain ? 'rgba(91,212,160,0.26)' : 'rgba(224,101,107,0.26)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');

  context.beginPath();
  context.moveTo(xFor(0), yFor(values[0]));
  values.forEach((value, index) => context.lineTo(xFor(index), yFor(value)));
  context.lineTo(xFor(values.length - 1), pad.top + height);
  context.lineTo(xFor(0), pad.top + height);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  context.moveTo(xFor(0), yFor(values[0]));
  values.forEach((value, index) => context.lineTo(xFor(index), yFor(value)));
  context.strokeStyle = stroke;
  context.lineWidth = 1.6;
  context.stroke();

  context.fillStyle = stroke;
  context.beginPath();
  context.arc(xFor(values.length - 1), yFor(values[values.length - 1]), 3, 0, Math.PI * 2);
  context.fill();

  const startTime = points[0]?.time;
  const endTime = points[points.length - 1]?.time;
  if (startTime && endTime) {
    context.fillStyle = '#7c6e6f';
    context.font = '10px "JetBrains Mono", monospace';
    context.fillText(stamp(startTime), pad.left, cssHeight - 6);
    const label = stamp(endTime);
    context.fillText(label, pad.left + width - context.measureText(label).width, cssHeight - 6);
  }
}

/* ------------------------------------------------------------------ */
/* Signals                                                            */
/* ------------------------------------------------------------------ */

function renderSignals(): void {
  const body = el('signalsBody');
  if (!body) return;
  $('signalCount').textContent = `${signals.length} pending`;
  if (!signals.length) {
    body.innerHTML = '<tr><td colspan="10" class="ex-empty">No pending signals. AI-authored signals will appear here.</td></tr>';
    return;
  }
  body.innerHTML = signals
    .map(
      (signal) => `<tr>
        <td class="ex-mono-cell">${stamp(signal.createdAt)}</td>
        <td><b>${escapeHtml(signal.strategyName ?? signal.strategyId)}</b><span class="sub">${escapeHtml(
          signal.strategyId,
        )}</span></td>
        <td class="sym">${escapeHtml(signal.symbol)}</td>
        <td><span class="ex-tag ${signal.side === 'buy' ? 'ok' : 'bad'}">${escapeHtml(
          signal.side.toUpperCase(),
        )}</span></td>
        <td class="right ex-mono-cell">${signal.entry ? num(signal.entry, 5) : 'market'}</td>
        <td class="right ex-mono-cell">${signal.sl ? num(signal.sl, 5) : '—'}</td>
        <td class="right ex-mono-cell">${signal.tp ? num(signal.tp, 5) : '—'}</td>
        <td class="right ex-mono-cell">${signal.confidence == null ? '—' : `${num(signal.confidence * 100, 0)}%`}</td>
        <td title="${escapeHtml(signal.note)}">${escapeHtml(truncate(signal.note, 40))}</td>
        <td class="right">
          <button type="button" class="ex-btn small primary" data-signal="approve" data-id="${escapeHtml(
            signal.id,
          )}">Approve</button>
          <button type="button" class="ex-btn small danger" data-signal="reject" data-id="${escapeHtml(
            signal.id,
          )}">Reject</button>
        </td>
      </tr>`,
    )
    .join('');
}

async function signalAction(id: string, action: 'approve' | 'reject'): Promise<void> {
  try {
    if (action === 'approve') {
      const result = await api<Json>(`/api/signals/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        body: { note: 'approved in the execution desk' },
      });
      toast(`Signal executed · ticket ${result.order?.ticket ?? '—'}.`, 'ok');
    } else {
      await api(`/api/signals/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        body: { note: 'rejected in the execution desk' },
      });
      toast('Signal rejected; the decision is queued back to the cloud.', 'ok');
    }
    await poll();
  } catch (err) {
    showError(err);
  }
}

/* ------------------------------------------------------------------ */
/* Audit                                                              */
/* ------------------------------------------------------------------ */

function renderAudit(): void {
  const body = el('auditBody');
  if (!body) return;
  $('auditCount').textContent = `${audit.length} entries`;
  if (!audit.length) {
    body.innerHTML = '<tr><td colspan="5" class="ex-empty">Nothing logged yet.</td></tr>';
    return;
  }
  body.innerHTML = audit
    .map((entry) => {
      const detail = typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail ?? {});
      const action = String(entry.action ?? '');
      const bad = entry.ok === false || /failed|rejected|locked/.test(action);
      return `<tr>
        <td class="ex-mono-cell">${stamp(entry.ts)}</td>
        <td class="ex-mono-cell">${escapeHtml(entry.actor ?? 'bridge')}</td>
        <td><b>${escapeHtml(action)}</b></td>
        <td class="ex-mono-cell" title="${escapeHtml(detail)}">${escapeHtml(truncate(detail, 110))}</td>
        <td><span class="ex-tag ${bad ? 'bad' : 'ok'}">${bad ? 'rejected' : 'ok'}</span></td>
      </tr>`;
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/* Connection actions                                                 */
/* ------------------------------------------------------------------ */

function renderOffline(reason: string): void {
  const dot = el('connDot');
  if (dot) dot.className = 'ex-pulse ex-pulse-off';
  if (el('connLabel')) $('connLabel').textContent = 'BRIDGE OFFLINE';
  if (el('connSub')) $('connSub').textContent = reason;
  setBadge('modeBadge', 'MODE —', 'off');
  setBadge('tradeBadge', 'TRADING —', 'off');
  setBadge('cloudBadge', 'CLOUD —', 'off');
  setBadge('setupChip', 'not paired', 'bad');
  if (el('diagWrap')) $('diagWrap').hidden = true;
  if (el('disconnectBtn')) $('disconnectBtn').hidden = true;
}

async function pairBridge(): Promise<void> {
  const url = ((el('bridgeUrl') as HTMLInputElement)?.value ?? '').trim().replace(/\/+$/, '');
  const token = ((el('bridgeToken') as HTMLInputElement)?.value ?? '').trim();
  if (!token) {
    toast('Paste the token printed by the bridge.', 'bad');
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    toast('The bridge URL must start with http:// (for example http://127.0.0.1:8899).', 'bad');
    return;
  }

  pairing = { url, token };
  authFailed = false;
  savePairing();

  try {
    await api<Json>('/api/status');
  } catch (err) {
    showError(err);
    renderOffline('Bridge did not accept the pairing. Check the URL and token.');
    return;
  }

  toast('Bridge paired. Detecting MetaTrader 5 terminals…', 'ok');
  await Promise.allSettled([poll(), loadSymbols(), refreshDiagnostics()]);
  startPolling();
}

async function testBridge(): Promise<void> {
  const url = ((el('bridgeUrl') as HTMLInputElement)?.value ?? '').trim().replace(/\/+$/, '');
  const token = ((el('bridgeToken') as HTMLInputElement)?.value ?? '').trim();
  if (!url) {
    toast('Enter the bridge URL first.', 'bad');
    return;
  }
  try {
    const health = await fetch(`${url}/health`, { cache: 'no-store' }).then((res) => res.json());
    let authenticated = false;
    if (token) {
      try {
        await fetch(`${url}/api/status`, {
          headers: { accept: 'application/json', 'x-bridge-token': token },
          cache: 'no-store',
        }).then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          authenticated = true;
        });
      } catch {
        authenticated = false;
      }
    }
    toast(
      `${health.service ?? 'bridge'} v${health.version ?? '?'} is reachable · mode ${health.mode ?? '—'} · ${
        authenticated ? 'token accepted' : token ? 'token rejected' : 'token missing'
      }.`,
      authenticated ? 'ok' : 'bad',
    );
  } catch {
    toast(`Nothing answered at ${url}. Start the bridge and check the port.`, 'bad');
  }
}

function forgetBridge(): void {
  pairing = { url: pairing.url || DEFAULT_URL, token: '' };
  savePairing();
  stopPolling();
  status = null;
  diagnostics = null;
  positions = [];
  orders = [];
  strategies = [];
  signals = [];
  audit = [];
  renderOffline('Pairing forgotten. Connect again with the token from the bridge console.');
  if (el('accountPanel')) $('accountPanel').hidden = true;
  if (el('forgetBtn')) $('forgetBtn').hidden = true;
  $('terminalList').innerHTML = '<tr><td colspan="4" class="ex-empty">No bridge paired yet.</td></tr>';
  $('positionsBody').innerHTML =
    '<tr><td colspan="11" class="ex-empty">No positions. Connect a terminal to see your live book.</td></tr>';
  $('signalsBody').innerHTML = '<tr><td colspan="10" class="ex-empty">No pending signals.</td></tr>';
  $('strategiesBody').innerHTML = '<tr><td colspan="9" class="ex-empty">No strategies registered yet.</td></tr>';
  $('perfBody').innerHTML = '<tr><td colspan="9" class="ex-empty">No measured results yet — run a backtest.</td></tr>';
  $('auditBody').innerHTML = '<tr><td colspan="5" class="ex-empty">Nothing logged yet.</td></tr>';
  if (el('bridgeToken')) (el('bridgeToken') as HTMLInputElement).value = '';
}

/* ------------------------------------------------------------------ */
/* Risk / kill                                                        */
/* ------------------------------------------------------------------ */

async function saveRisk(): Promise<void> {
  const numberFrom = (id: string): number => Number((el(id) as HTMLInputElement)?.value ?? 0);
  const whitelist = ((el('riskWhitelist') as HTMLInputElement)?.value ?? '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  try {
    await api('/api/risk', {
      method: 'PUT',
      body: {
        riskPerTradePct: numberFrom('riskPerTrade'),
        maxLotPerTrade: numberFrom('riskMaxLot'),
        maxOpenPositions: Math.round(numberFrom('riskMaxPositions')),
        maxDailyLossPct: numberFrom('riskMaxDailyLoss'),
        maxDrawdownPct: numberFrom('riskMaxDD'),
        symbolWhitelist: whitelist,
        allowMarketOrders: (el('riskAllowMarket') as HTMLInputElement | null)?.checked ?? true,
        killSwitch: Boolean(status?.risk?.killSwitch),
      },
    });
    toast('Risk gates saved.', 'ok');
    await poll();
  } catch (err) {
    showError(err);
  }
}

async function toggleKill(): Promise<void> {
  const active = Boolean(status?.risk?.killSwitch);
  try {
    if (!active) {
      if (!window.confirm('Engage the kill switch? New orders will be blocked immediately.')) return;
      const closePositions = Boolean((el('killClose') as HTMLInputElement | null)?.checked);
      const result = await api<Json>('/api/kill', {
        method: 'POST',
        body: { active: true, closePositions, confirm: 'KILL' },
      });
      toast(
        `Kill switch engaged${result.closed?.length ? ` · ${result.closed.length} positions closed` : ''}.`,
        'bad',
      );
    } else {
      if (!window.confirm('Release the kill switch and allow orders again?')) return;
      await api('/api/kill', { method: 'POST', body: { active: false } });
      toast('Kill switch released.', 'ok');
    }
    await poll();
  } catch (err) {
    showError(err);
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                             */
/* ------------------------------------------------------------------ */

function wire(): void {
  // Pairing
  $('connectBtn').addEventListener('click', () => void pairBridge());
  $('testBtn').addEventListener('click', () => void testBridge());
  $('forgetBtn').addEventListener('click', forgetBridge);
  $('rescanBtn').addEventListener('click', () => void refreshDiagnostics());
  $('disconnectBtn').addEventListener('click', () => {
    void api('/api/mt5/disconnect', { method: 'POST', body: {} })
      .then(async () => {
        toast('Terminal disconnected — simulation broker is active.', 'ok');
        await Promise.allSettled([poll(), refreshDiagnostics(true)]);
      })
      .catch(showError);
  });
  $('syncStrategiesBtn').addEventListener('click', () => void syncStrategies());

  // Terminal connect (delegated: rows are re-rendered)
  $('terminalList').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-terminal]');
    if (!button) return;
    const path = button.getAttribute('data-terminal');
    if (path) void connectTerminal(path, button.getAttribute('data-portable') === '1');
  });
  $('manualConnectBtn').addEventListener('click', () => {
    const path = diagnostics?.suggestedPath ?? diagnostics?.terminals.find((t) => t.installed)?.path;
    if (!path) {
      toast('No terminal path is known yet. Rescan after installing MetaTrader 5.', 'bad');
      return;
    }
    void connectTerminal(path, false);
  });

  // Ticket
  $('orderSymbol').addEventListener('change', () => {
    selectedSymbol = (el('orderSymbol') as HTMLSelectElement).value;
    void refreshQuote();
  });
  $('sideBuy').addEventListener('click', () => setSide('buy'));
  $('sideSell').addEventListener('click', () => setSide('sell'));
  $('placeOrderBtn').addEventListener('click', () => void placeOrder());

  // Risk
  $('saveRiskBtn').addEventListener('click', () => void saveRisk());
  $('killBtn').addEventListener('click', () => void toggleKill());
  $('releaseKillBtn').addEventListener('click', () => void toggleKill());
  $('closeAllBtn').addEventListener('click', () => {
    if (!window.confirm('Close every open position?')) return;
    void api('/api/positions/close-all', { method: 'POST', body: {} })
      .then(() => {
        toast('Close-all sent.', 'ok');
        return poll();
      })
      .catch(showError);
  });

  // Positions + strategies + signals (delegated)
  $('positionsBody').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    if (!button) return;
    const ticket = Number(button.getAttribute('data-ticket'));
    const action = button.getAttribute('data-act') ?? '';
    const row = button.closest('tr');
    if (Number.isFinite(ticket) && row) void positionAction(ticket, action, row);
  });
  $('strategiesBody').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-backtest]');
    if (!button) return;
    const id = button.getAttribute('data-backtest');
    const select = el('btStrategy') as HTMLSelectElement | null;
    if (id && select) {
      select.value = id;
      const strategy = strategies.find((row) => row.id === id);
      if (strategy) {
        const symbol = (el('btSymbol') as HTMLInputElement)?.value;
        if (!symbol) $('btSymbol').setAttribute('value', selectedSymbol);
      }
    }
    document.getElementById('backtest')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('strategiesBody').addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    const field = input.getAttribute('data-toggle') as 'enabled' | 'autoExecute' | null;
    const id = input.getAttribute('data-id');
    if (field && id) void toggleStrategy(id, field, input.checked);
  });
  $('signalsBody').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-signal]');
    if (!button) return;
    const id = button.getAttribute('data-id');
    const action = button.getAttribute('data-signal') as 'approve' | 'reject' | null;
    if (id && action) void signalAction(id, action);
  });

  // Backtest
  $('runBacktestBtn').addEventListener('click', () => void runBacktest());
  window.addEventListener('resize', () => {
    if (lastBacktest) drawEquity(lastBacktest.result?.equity ?? []);
  });
}

function init(): void {
  loadPairing();
  (el('bridgeUrl') as HTMLInputElement).value = pairing.url || DEFAULT_URL;
  if (pairing.token) (el('bridgeToken') as HTMLInputElement).value = pairing.token;
  wire();
  setSide('buy');

  if (pairing.token && pairing.url) {
    void (async () => {
      try {
        await api<Json>('/api/status');
        await Promise.allSettled([loadSymbols(), poll(), refreshDiagnostics(true)]);
        startPolling();
      } catch (err) {
        showError(err);
        renderOffline('Saved pairing did not answer. Start the bridge, then press Connect.');
      }
    })();
  } else {
    renderOffline('No local bridge paired yet — follow the three steps above.');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
