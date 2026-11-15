/**
 * Vaelor member dashboard — design system v2 behaviour.
 *
 * Implements the old-money/lux single-file design language adopted in the
 * operator preview: tabbed shell (Overview / Execution Desk / Live Terminal /
 * Guide), high-visibility crimson buttons, accordion drawers, toasts, kill
 * switch, order ticket, live positions blotter and sign-in modal.
 *
 * Member identity / plan logic is inherited from `./membership`.
 */
import {
  getCurrentUser,
  type MemberUser,
} from './membership';

/* ------------------------------------------------------------------ */
/* Design state                                                        */
/* ------------------------------------------------------------------ */
interface DesignState {
  activeTab: string;
  orderSide: 'BUY' | 'SELL';
  executionMode: 'SIMULATION' | 'LIVE BROKER';
  safetyArmed: boolean;
  bridgeConnected: boolean;
  signedIn: boolean;
  selectedTimeframe: string;
  operatorHandle: string;
  symbols: Record<string, { bid: number; ask: number; spread: string; day: string; sl: number; tp: number }>;
  positions: Array<{
    id: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    lots: number;
    entry: number;
    sl: number;
    tp: number;
    strategy: string;
    pnl: number;
  }>;
}

let state: DesignState = {
  activeTab: 'overview',
  orderSide: 'BUY',
  executionMode: 'SIMULATION',
  safetyArmed: true,
  bridgeConnected: true,
  signedIn: true,
  selectedTimeframe: '1H',
  operatorHandle: '@arthur.vance',
  symbols: {
    ESZ6: { bid: 5892.25, ask: 5892.5, spread: '0.25', day: '+0.84%', sl: 5880, tp: 5915 },
    NQZ6: { bid: 20845.5, ask: 20846, spread: '0.5', day: '+1.12%', sl: 20790, tp: 20950 },
    XAUUSD: { bid: 2742.1, ask: 2742.45, spread: '0.35', day: '+0.62%', sl: 2730, tp: 2765 },
    CLZ6: { bid: 71.42, ask: 71.45, spread: '0.03', day: '-0.45%', sl: 70.8, tp: 72.8 },
    BTCUSD: { bid: 89420, ask: 89435, spread: '15', day: '+2.4%', sl: 88500, tp: 91200 },
  },
  positions: [
    { id: 'MT5-90412', symbol: 'ESZ6', side: 'BUY', lots: 0.25, entry: 5884.5, sl: 5875, tp: 5910, strategy: 'VWAP Mean Reversion v2', pnl: 968.75 },
    { id: 'MT5-90419', symbol: 'XAUUSD', side: 'BUY', lots: 0.1, entry: 2737.6, sl: 2728, tp: 2760, strategy: 'manual trade', pnl: 451.75 },
  ],
};

/* ------------------------------------------------------------------ */
/* Member identity                                                     */
/* ------------------------------------------------------------------ */
let user: MemberUser | null = null;

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */
function showToast(message: string, type: 'info' | 'success' | 'error' = 'info'): void {
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
  toast.innerHTML = `<div class="mt-0.5 text-sm">${icon}</div><div class="flex-1 leading-relaxed">${message}</div>`;
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
function switchTab(tabId: string): void {
  state.activeTab = tabId;
  for (const v of ['overview', 'execution', 'terminal', 'guide']) {
    const el = document.getElementById(`view-${v}`);
    if (el) el.classList.toggle('hidden', v !== tabId);
  }
  const set = (id: string, active: boolean, classes: string) => {
    const b = document.getElementById(id);
    if (!b) return;
    b.className = classes;
  };
  const map: Record<string, string> = {
    overview: 'nav-pill-btn px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 bg-rose-600/25 border border-rose-500 text-white shadow-[0_0_12px_rgba(225,29,72,0.35)]',
    execution: 'nav-pill-btn px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 bg-rose-600/25 border border-rose-500 text-white shadow-[0_0_12px_rgba(225,29,72,0.35)]',
    terminal: 'nav-pill-btn px-3.5 py-1.5 rounded-full text-xs font-medium transition-all flex items-center gap-1.5 text-slate-300 hover:text-white hover:bg-white/5 border border-transparent',
    guide: 'nav-pill-btn px-3.5 py-1.5 rounded-full text-xs font-medium transition-all flex items-center gap-1.5 text-slate-300 hover:text-white hover:bg-white/5 border border-transparent',
  };
  set('nav-overview', tabId === 'overview', map.overview);
  set('nav-execution', tabId === 'execution', map.execution);
  set('nav-terminal', tabId === 'terminal', map.terminal);
  set('nav-guide', tabId === 'guide', map.guide);
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
  const isOpen = content.classList.contains('open');
  if (isOpen) {
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
/* Order ticket                                                        */
/* ------------------------------------------------------------------ */
function updateOrderButtonLabel(): void {
  const sym = (document.getElementById('ticket-symbol') as HTMLSelectElement | null)?.value ?? 'ESZ6';
  const vol = (document.getElementById('ticket-volume') as HTMLInputElement | null)?.value ?? '0.10';
  const label = document.getElementById('place-order-label');
  if (label) label.textContent = `Place ${state.orderSide} Order (${vol} Lots ${sym})`;
}

function selectOrderSide(side: 'BUY' | 'SELL'): void {
  state.orderSide = side;
  const buy = document.getElementById('btn-side-buy') as HTMLButtonElement | null;
  const sell = document.getElementById('btn-side-sell') as HTMLButtonElement | null;
  if (side === 'BUY') {
    if (buy) buy.className = 'btn-buy-active py-3.5 px-4 rounded-xl font-mono font-bold text-sm tracking-wider uppercase transition-all flex items-center justify-center gap-2';
    if (sell) sell.className = 'btn-sell-inactive py-3.5 px-4 rounded-xl font-mono font-bold text-sm tracking-wider uppercase transition-all flex items-center justify-center gap-2';
  } else {
    if (buy) buy.className = 'btn-buy-inactive py-3.5 px-4 rounded-xl font-mono font-bold text-sm tracking-wider uppercase transition-all flex items-center justify-center gap-2';
    if (sell) sell.className = 'btn-sell-active py-3.5 px-4 rounded-xl font-mono font-bold text-sm tracking-wider uppercase transition-all flex items-center justify-center gap-2';
  }
  updateOrderButtonLabel();
}

function updateSymbolQuotes(): void {
  const sym = (document.getElementById('ticket-symbol') as HTMLSelectElement | null)?.value ?? 'ESZ6';
  const data = state.symbols[sym];
  if (!data) return;
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
  const sl = document.getElementById('ticket-sl') as HTMLInputElement | null;
  const tp = document.getElementById('ticket-tp') as HTMLInputElement | null;
  if (sl) sl.value = data.sl.toFixed(2);
  if (tp) tp.value = data.tp.toFixed(2);
  updateOrderButtonLabel();
}

function adjustVolume(delta: number): void {
  const input = document.getElementById('ticket-volume') as HTMLInputElement | null;
  if (!input) return;
  const cur = parseFloat(input.value) || 0.1;
  const val = Math.max(0.01, Math.round((cur + delta) * 100) / 100);
  input.value = val.toFixed(2);
  updateOrderButtonLabel();
}

function submitOrderTicket(): void {
  if (!state.safetyArmed) {
    showToast('ORDER BLOCKED: Kill Switch is engaged (Safety Disarmed). Re-arm safety gates first.', 'error');
    return;
  }
  const confirmed = document.getElementById('confirm-broker-checkbox') as HTMLInputElement | null;
  if (!confirmed?.checked) {
    showToast('Please tick the confirmation checkbox before routing order to your broker.', 'error');
    return;
  }
  const sym = (document.getElementById('ticket-symbol') as HTMLSelectElement | null)?.value ?? 'ESZ6';
  const lots = parseFloat((document.getElementById('ticket-volume') as HTMLInputElement | null)?.value ?? '0.10') || 0.1;
  const sl = parseFloat((document.getElementById('ticket-sl') as HTMLInputElement | null)?.value ?? '0') || 0;
  const tp = parseFloat((document.getElementById('ticket-tp') as HTMLInputElement | null)?.value ?? '0') || 0;
  const strategy = (document.getElementById('ticket-strategy') as HTMLSelectElement | null)?.value ?? 'manual trade';
  const quote = state.symbols[sym];
  const fillPrice = state.orderSide === 'BUY' ? quote.ask : quote.bid;

  state.positions.unshift({
    id: 'MT5-' + Math.floor(10000 + Math.random() * 90000),
    symbol: sym,
    side: state.orderSide,
    lots,
    entry: fillPrice,
    sl,
    tp,
    strategy,
    pnl: 0,
  });
  renderPositionsTable();
  showToast(`EXECUTED: ${state.orderSide} ${lots.toFixed(2)} ${sym} @ ${fillPrice.toLocaleString()} (${state.executionMode})`, 'success');
}

/* ------------------------------------------------------------------ */
/* Positions / safety                                                  */
/* ------------------------------------------------------------------ */
function renderPositionsTable(): void {
  const tbody = document.getElementById('positions-table-body');
  const badge = document.getElementById('nav-pos-count');
  if (badge) badge.textContent = String(state.positions.length);
  const pnlBadge = document.getElementById('total-pnl-badge');
  const emptyRow = `<tr><td colspan="9" class="py-8 text-center text-slate-400 font-mono">No open positions. Use the Execution Desk to route a new order.</td></tr>`;
  if (state.positions.length === 0) {
    if (tbody) tbody.innerHTML = emptyRow;
    if (pnlBadge) pnlBadge.textContent = '$0.00';
    return;
  }
  let totalPnl = 0;
  if (tbody) tbody.innerHTML = state.positions
    .map((pos, idx) => {
      totalPnl += pos.pnl;
      const sideCls = pos.side === 'BUY' ? 'bg-emerald-950/80 text-emerald-300 border-emerald-500/40' : 'bg-rose-950/80 text-rose-300 border-rose-500/40';
      const pnlCls = pos.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400';
      const pnlPrefix = pos.pnl >= 0 ? '+$' : '-$';
      return `
        <tr class="hover:bg-white/[0.02] transition">
          <td class="py-3.5 px-4 text-slate-300">${pos.id}</td>
          <td class="py-3.5 px-4 font-bold text-white">${pos.symbol}</td>
          <td class="py-3.5 px-4"><span class="px-2.5 py-0.5 rounded border text-xs ${sideCls}">${pos.side}</span></td>
          <td class="py-3.5 px-4 text-white">${pos.lots.toFixed(2)}</td>
          <td class="py-3.5 px-4 text-slate-200">${pos.entry.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
          <td class="py-3.5 px-4 text-slate-400 text-xs">${pos.sl} / ${pos.tp}</td>
          <td class="py-3.5 px-4 text-slate-300 text-xs">${pos.strategy}</td>
          <td class="py-3.5 px-4 font-bold ${pnlCls}">${pnlPrefix}${Math.abs(pos.pnl).toFixed(2)}</td>
          <td class="py-3.5 px-4 text-right"><button onclick="closePosition(${idx})" class="px-3 py-1 rounded-lg bg-rose-950 hover:bg-rose-700 border border-rose-500/50 text-rose-200 text-xs transition">Close</button></td>
        </tr>`;
    })
    .join('');
  if (pnlBadge) {
    pnlBadge.textContent = (totalPnl >= 0 ? '+$' : '-$') + Math.abs(totalPnl).toFixed(2);
    pnlBadge.className = 'font-bold text-sm ' + (totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400');
  }
}

function closePosition(index: number): void {
  const removed = state.positions.splice(index, 1)[0];
  renderPositionsTable();
  if (removed) showToast(`Closed position ${removed.id} (${removed.symbol})`, 'info');
}

function flattenAllPositions(): void {
  if (state.positions.length === 0) {
    showToast('No open positions to flatten.', 'info');
    return;
  }
  const count = state.positions.length;
  state.positions = [];
  renderPositionsTable();
  showToast(`EMERGENCY FLATTEN: Closed all ${count} open positions across MT5 bridge.`, 'error');
}

/* ------------------------------------------------------------------ */
/* Kill switch / mode / bridge / risk                                  */
/* ------------------------------------------------------------------ */
function toggleKillSwitch(): void {
  state.safetyArmed = !state.safetyArmed;
  const btn = document.getElementById('kill-switch-btn');
  const label = document.getElementById('kill-switch-label');
  const pill = document.getElementById('safety-pill-badge');
  if (state.safetyArmed) {
    if (btn) btn.className = 'px-4 py-2 rounded-xl text-xs font-mono font-bold uppercase tracking-wider border-2 border-emerald-400 bg-emerald-950/80 text-emerald-200 shadow-[0_0_15px_rgba(16,185,129,0.3)] hover:bg-emerald-900 transition flex items-center gap-2';
    if (label) label.textContent = 'SAFETY GATES: ARMED';
    if (pill) {
      pill.textContent = 'armed';
      pill.className = 'px-3.5 py-1 rounded-full text-xs font-mono font-semibold bg-emerald-950/90 border border-emerald-400/60 text-emerald-300';
    }
    showToast('Risk Gates ARMED. Order routing enabled.', 'success');
  } else {
    if (btn) btn.className = 'px-4 py-2 rounded-xl text-xs font-mono font-bold uppercase tracking-wider border-2 border-rose-500 bg-rose-950/90 text-rose-200 shadow-[0_0_20px_rgba(244,63,94,0.5)] hover:bg-rose-900 transition flex items-center gap-2';
    if (label) label.textContent = 'KILL SWITCH ENGAGED (LOCKED)';
    if (pill) {
      pill.textContent = 'kill-switch locked';
      pill.className = 'px-3.5 py-1 rounded-full text-xs font-mono font-semibold bg-rose-950/90 border border-rose-400/60 text-rose-300';
    }
    showToast('KILL SWITCH ENGAGED: All outbound order routing is halted.', 'error');
  }
}

function toggleExecutionMode(): void {
  state.executionMode = state.executionMode === 'SIMULATION' ? 'LIVE BROKER' : 'SIMULATION';
  const badge = document.getElementById('exec-mode-badge');
  const text = document.getElementById('exec-mode-text');
  if (badge) {
    badge.className = state.executionMode === 'LIVE BROKER'
      ? 'px-3.5 py-1.5 rounded-full text-xs font-mono font-semibold bg-rose-950/90 border border-rose-400 text-rose-200 shadow-[0_0_12px_rgba(244,63,94,0.35)] transition flex items-center gap-1.5'
      : 'px-3.5 py-1.5 rounded-full text-xs font-mono font-semibold bg-amber-950/80 border border-amber-400/60 text-amber-200 transition flex items-center gap-1.5';
  }
  if (text) text.textContent = state.executionMode === 'LIVE BROKER' ? 'MODE: LIVE BROKER' : 'MODE: SIMULATION';
  showToast(`Switched routing mode to ${state.executionMode}`, 'info');
}

function toggleBridgeState(): void {
  state.bridgeConnected = !state.bridgeConnected;
  const pill = document.getElementById('bridge-status-pill');
  const dot = document.getElementById('bridge-dot');
  const text = document.getElementById('bridge-text');
  if (state.bridgeConnected) {
    if (pill) pill.className = 'hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-950/60 border border-emerald-500/50 text-emerald-300 text-xs font-mono hover:bg-emerald-900/70 transition cursor-pointer';
    if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]';
    if (text) text.textContent = 'BRIDGE: 127.0.0.1:8899';
    showToast('Connected to local MetaTrader 5 bridge (127.0.0.1:8899)', 'success');
  } else {
    if (pill) pill.className = 'hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-rose-950/70 border border-rose-500/60 text-rose-300 text-xs font-mono hover:bg-rose-900/70 transition cursor-pointer';
    if (dot) dot.className = 'w-2 h-2 rounded-full bg-rose-400';
    if (text) text.textContent = 'BRIDGE OFFLINE (RUN.CMD)';
    showToast('Local MT5 Bridge disconnected. Expand Section 01 for PowerShell command.', 'error');
  }
}

function saveRiskGates(): void {
  const rpt = (document.getElementById('risk-per-trade') as HTMLInputElement | null)?.value ?? '0';
  const dl = (document.getElementById('risk-daily-loss') as HTMLInputElement | null)?.value ?? '0';
  showToast(`Synced Risk Gates: ${rpt}% per trade / ${dl}% max daily loss.`, 'success');
}

function selectTimeframe(tf: string): void {
  state.selectedTimeframe = tf;
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.tf-btn'))) {
    const id = btn.getAttribute('data-tf') ?? '';
    const isActive = id === tf;
    btn.className = isActive
      ? 'tf-btn px-3.5 py-1.5 rounded-lg text-xs font-mono border-2 border-amber-400 bg-amber-950/70 text-amber-200 font-bold shadow-[0_0_10px_rgba(245,158,11,0.3)] transition'
      : 'tf-btn px-3.5 py-1.5 rounded-lg text-xs font-mono border border-[#331d27] bg-[#160c12] text-slate-300 hover:border-rose-400 transition';
  }
  showToast(`Live trading timeframe updated to ${tf}`, 'info');
}

/* ------------------------------------------------------------------ */
/* Sign-in modal                                                      */
/* ------------------------------------------------------------------ */
function openSignInModal(): void {
  const modal = document.getElementById('signin-modal');
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

function saveOperatorAuth(): void {
  const handle = (document.getElementById('modal-handle-input') as HTMLInputElement | null)?.value?.trim() || '@operator';
  state.signedIn = true;
  state.operatorHandle = handle;
  const memberHandle = document.getElementById('member-handle');
  if (memberHandle) memberHandle.textContent = `MEMBER · ${handle}`;
  const indicator = document.getElementById('auth-indicator');
  if (indicator) {
    indicator.className = 'w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]';
  }
  const signinBtn = document.getElementById('signin-btn-label');
  if (signinBtn) signinBtn.textContent = 'Account / Auth';
  closeSignInModal();
  showToast(`Signed in as ${handle} & authenticated local MT5 bridge token.`, 'success');
}

function signOutOperator(): void {
  state.signedIn = false;
  const memberHandle = document.getElementById('member-handle');
  if (memberHandle) memberHandle.textContent = 'GUEST · UNVERIFIED';
  const indicator = document.getElementById('auth-indicator');
  if (indicator) indicator.className = 'w-2 h-2 rounded-full bg-amber-400';
  const signinBtn = document.getElementById('signin-btn-label');
  if (signinBtn) signinBtn.textContent = 'Sign In Now';
  closeSignInModal();
  showToast('Signed out of operator session.', 'info');
}

function copyCommand(elementId: string): void {
  const text = document.getElementById(elementId)?.innerText ?? '';
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
      btnText.textContent = 'Copy Command';
    }, 2000);
  }
  showToast('Copied PowerShell MT5 bridge command to clipboard.', 'success');
}

/* ------------------------------------------------------------------ */
/* Live quote ticker                                                    */
/* ------------------------------------------------------------------ */
setInterval(() => {
  const sym = (document.getElementById('ticket-symbol') as HTMLSelectElement | null)?.value ?? 'ESZ6';
  const data = state.symbols[sym];
  if (!data) return;
  const tick = (Math.random() - 0.48) * 0.5;
  data.bid = Math.round((data.bid + tick) * 100) / 100;
  data.ask = Math.round((data.bid + parseFloat(data.spread)) * 100) / 100;
  const bidEl = document.getElementById('quote-bid');
  const askEl = document.getElementById('quote-ask');
  if (bidEl && askEl) {
    bidEl.textContent = data.bid.toLocaleString('en-US', { minimumFractionDigits: 2 });
    askEl.textContent = data.ask.toLocaleString('en-US', { minimumFractionDigits: 2 });
  }
}, 2400);

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
g.toggleBridgeState = toggleBridgeState;
g.copyCommand = copyCommand;
g.selectOrderSide = selectOrderSide;
g.updateSymbolQuotes = updateSymbolQuotes;
g.adjustVolume = adjustVolume;
g.updateOrderButtonLabel = updateOrderButtonLabel;
g.submitOrderTicket = submitOrderTicket;
g.saveRiskGates = saveRiskGates;
g.flattenAllPositions = flattenAllPositions;
g.selectTimeframe = selectTimeframe;
g.openSignInModal = openSignInModal;
g.closeSignInModal = closeSignInModal;
g.saveOperatorAuth = saveOperatorAuth;
g.signOutOperator = signOutOperator;
g.closePosition = closePosition;
g.showToast = showToast;

/* ------------------------------------------------------------------ */
/* Mount                                                               */
/* ------------------------------------------------------------------ */
function mountDesign(): void {
  user = getCurrentUser();
  if (!user?.username) {
    location.replace('/login.html');
    return;
  }
  const memberHandle = document.getElementById('member-handle');
  if (memberHandle) memberHandle.textContent = `MEMBER · @${user.username}`;
  const indicator = document.getElementById('auth-indicator');
  if (indicator) {
    indicator.className = 'w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]';
  }

  const bridgePill = document.getElementById('bridge-status-pill');
  if (bridgePill) bridgePill.className = 'hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-950/60 border border-emerald-500/50 text-emerald-300 text-xs font-mono hover:bg-emerald-900/70 transition cursor-pointer';

  document.getElementById('ticket-volume')?.addEventListener('input', updateOrderButtonLabel);
  document.getElementById('ticket-symbol')?.addEventListener('change', updateSymbolQuotes);
  switchTab('overview');
  renderPositionsTable();
}

export function mountMember(): void {
  if (typeof document === 'undefined') return;
  mountDesign();
}
