/**
 * Member dashboard — per-user shell.
 *
 * One signed-in member → one dashboard. Identity comes from the login
 * console (`localStorage['vaelor_active_session_v1']`), the plan from
 * `localStorage['vaelor_sub:<username>']`, notifications from
 * `localStorage['vaelor_notif:<username>']`.
 *
 * Screens: Overview · Capabilities · AI Copilot · Notifications · Account.
 * The copilot is an MCP client: every answer is a real tool call against the
 * macro worker, never generated text pretending to be market data.
 */
import {
  FEATURES,
  can,
  getCurrentUser,
  getNotifications,
  getSubscription,
  getSubscriptionRemainingSeconds,
  getTier,
  markNotificationsRead,
  pushNotification,
  setSubscription,
  type FeatureKey,
  type MemberUser,
  type SubscriptionState,
} from './membership';

const WORKER = 'https://trading-llc-mcp.mahdi-t8256.workers.dev';
const REQ_KEY = 'vaelor_subreq';

interface Plan {
  id: 'trial' | 'monthly' | 'annual';
  name: string;
  price: string;
  cadence: string;
  days: number;
  note: string;
}

const PLANS: Plan[] = [
  { id: 'monthly', name: 'Operator Monthly', price: '$149', cadence: '/ month', days: 30, note: 'Full toolkit, one bridge instance.' },
  { id: 'annual', name: 'Operator Annual', price: '$1,290', cadence: '/ year', days: 365, note: 'Two months free, priority provisioning.' },
];

const PAGE: Record<FeatureKey, string> = {
  backtest: '/execution#backtest',
  signals: '/execution#signals',
  execution_usage: '/execution#order-ticket',
  pair: '/execution#connect',
  live_trade: '/execution',
  indicator_download: '/execution',
  ai_chat: '#copilot',
  oi_cot: '/dashboard',
  cdtc: '/dashboard',
  upload_strategy: '/execution',
  analytical_chart: '/dashboard',
  terminal_section2: '/terminal#macro-hub',
  news_custom_ai: '/news',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

function toast(message: string): void {
  let el = document.getElementById('memberToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'memberToast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  window.setTimeout(() => el?.classList.remove('show'), 3200);
}

/* ------------------------------------------------------------------ */
/* Identity + plan                                                     */
/* ------------------------------------------------------------------ */

let user: MemberUser | null = null;

function fullName(u: MemberUser): string {
  const n = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim();
  return n || u.username || 'Member';
}

function initials(u: MemberUser): string {
  return fullName(u)
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function formatRemaining(seconds: number | null): string {
  if (seconds === null) return 'No expiry';
  if (seconds <= 0) return 'Expired';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

function renderIdentity(): void {
  if (!user) return;
  const name = $('mName');
  const handle = $('mHandle');
  const avatar = $('mAvatar');
  const greet = $('mGreeting');
  if (name) name.textContent = fullName(user);
  if (handle) handle.textContent = `@${user.username}`;
  if (avatar) avatar.textContent = initials(user);
  if (greet) greet.textContent = `Welcome back, ${fullName(user).split(' ')[0]}.`;
  const name2 = $('mName2');
  const handle2 = $('mHandle2');
  const email2 = $('mEmail2');
  if (name2) name2.textContent = fullName(user);
  if (handle2) handle2.textContent = `@${user.username}`;
  if (email2) email2.textContent = user.email ?? '—';
}

function planWindow(sub: SubscriptionState): { pct: number; label: string } {
  if (!sub.expiresAt || !sub.startedAt) return { pct: 0, label: '—' };
  const total = Math.max(1, sub.expiresAt - sub.startedAt);
  const left = Math.max(0, sub.expiresAt - Date.now());
  return { pct: Math.round((left / total) * 100), label: formatRemaining(Math.floor(left / 1000)) };
}

function renderPlan(): void {
  if (!user) return;
  const sub = getSubscription(user.username);
  const tier = getTier();
  const remaining = getSubscriptionRemainingSeconds();
  const paid = tier === 'subscriber' && sub.status !== 'canceled';

  const badge = $('mTierBadge');
  if (badge) {
    badge.textContent = paid ? (sub.status === 'trialing' ? 'TRIAL' : 'MEMBER') : 'FREE';
    badge.dataset.tier = paid ? 'paid' : 'free';
  }
  const planName = $('mPlanName');
  if (planName) planName.textContent = paid ? (sub.status === 'trialing' ? 'Operator Trial' : 'Operator Subscription') : 'Free tier';
  const planTime = $('mPlanTime');
  if (planTime) planTime.textContent = paid ? formatRemaining(remaining) : 'No expiry';

  const bar = $('mPlanBar');
  const win = planWindow(sub);
  if (bar) bar.style.width = paid ? `${win.pct}%` : '0%';

  const unlocked = (Object.keys(FEATURES) as FeatureKey[]).filter((k) => can(k)).length;
  const count = $('mUnlockedCount');
  if (count) count.textContent = String(unlocked);
  const gateCount = $('mLockedCount');
  if (gateCount) gateCount.textContent = String(Object.keys(FEATURES).length - unlocked);
  const tierStat = $('mTierStat');
  if (tierStat) tierStat.textContent = paid ? 'Subscriber' : 'Free';
  const tierStat2 = $('mTierStat2');
  if (tierStat2) tierStat2.textContent = paid ? (sub.status === 'trialing' ? 'Trial' : 'Subscriber') : 'Free';
  const timeStat = $('mTimeStat');
  if (timeStat) timeStat.textContent = paid ? formatRemaining(remaining) : '—';
  const capTotal = $('mCapTotal');
  if (capTotal) capTotal.textContent = String(Object.keys(FEATURES).length);

  renderUpgradeState(paid);
}

function renderUpgradeState(paid: boolean): void {
  const trialBtn = $<HTMLButtonElement>('mTrialBtn');
  if (trialBtn) trialBtn.hidden = paid;
  const planGrid = $('mPlanGrid');
  if (planGrid) planGrid.hidden = paid;
  const memberNote = $('mMemberNote');
  if (memberNote) memberNote.hidden = !paid;
}

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */
/* ------------------------------------------------------------------ */

function renderCapabilities(): void {
  const host = $('mCapGrid');
  if (!host) return;
  const keys = Object.keys(FEATURES) as FeatureKey[];
  host.innerHTML = keys
    .map((key) => {
      const def = FEATURES[key];
      const open = can(key);
      return `<button type="button" class="m-cap ${open ? 'open' : 'locked'}" data-cap="${key}" data-open="${open}">
        <div class="m-cap-top">
          <span class="m-cap-state">${open ? (def.forTier === 'free' ? 'FREE · INCLUDED' : 'MEMBER · INCLUDED') : 'SUBSCRIPTION'}</span>
          <span class="m-cap-ic" aria-hidden="true">${open ? '✓' : '🔒'}</span>
        </div>
        <h3>${esc(def.label)}</h3>
        <p>${esc(open ? 'Open the workspace from your sidebar.' : def.freeFallback)}</p>
      </button>`;
    })
    .join('');

  host.querySelectorAll<HTMLButtonElement>('[data-cap]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.cap as FeatureKey;
      if (btn.dataset.open === 'true') {
        const target = PAGE[key];
        if (target.startsWith('#')) showView(target.slice(1));
        else location.href = target;
      } else {
        showView('account');
        toast(`${FEATURES[key].label} needs an active subscription.`);
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

function renderNotifications(): void {
  const list = getNotifications();
  const unread = list.filter((n) => !n.read).length;
  for (const badge of Array.from(document.querySelectorAll<HTMLElement>('[data-notif-count]'))) {
    badge.textContent = unread ? String(unread) : '';
    badge.hidden = unread === 0;
  }
  const host = $('mNotifList');
  if (!host) return;
  if (!list.length) {
    host.innerHTML = '<p class="m-empty">No notifications yet. Signal approvals, subscription updates and AI results land here.</p>';
    return;
  }
  host.innerHTML = list
    .map(
      (n) => `<article class="m-notif ${n.read ? '' : 'unread'}">
        <div class="m-notif-k">${esc(n.kind)}</div>
        <div class="m-notif-body">
          <b>${esc(n.title)}</b>
          <p>${esc(n.body)}</p>
          <time>${new Date(n.at).toLocaleString()}</time>
        </div>
      </article>`,
    )
    .join('');

  const preview = $('mNotifPreview');
  if (preview) {
    if (!list.length) {
      preview.innerHTML = '<p class="m-empty">Notifications appear as signals, AI results and plan updates arrive.</p>';
    } else {
      preview.innerHTML = list
        .slice(0, 3)
        .map(
          (n) => `<article class="m-notif ${n.read ? '' : 'unread'}">
            <div class="m-notif-k">${esc(n.kind)}</div>
            <div class="m-notif-body"><b>${esc(n.title)}</b><p>${esc(n.body)}</p></div>
          </article>`,
        )
        .join('');
    }
  }
}

function markRead(): void {
  markNotificationsRead();
  renderNotifications();
}

/* ------------------------------------------------------------------ */
/* MCP copilot                                                         */
/* ------------------------------------------------------------------ */

interface ChatTurn {
  role: 'user' | 'bot';
  text: string;
  meta?: string;
}

const chat: ChatTurn[] = [];

async function mcpTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${WORKER}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
  const data = (await res.json()) as {
    result?: { content?: Array<{ type: string; text?: string }> };
    error?: { message?: string };
  };
  if (data.error) throw new Error(data.error.message ?? 'MCP error');
  const text = data.result?.content?.find((c) => typeof c.text === 'string')?.text;
  if (!text) throw new Error('Empty MCP response');
  return text;
}

function route(message: string): { tool: string; args: Record<string, unknown>; label: string } {
  const q = message.toLowerCase();
  if (/(signal|queue|pending|approve)/.test(q)) {
    return { tool: 'list_signals', args: { limit: 10 }, label: 'Signal queue' };
  }
  if (/(performance|success|win|drawdown|profit factor)/.test(q)) {
    return { tool: 'get_performance', args: {}, label: 'Measured performance' };
  }
  if (/(news|calendar|cpi|nfp|fomc|ppi|macro release)/.test(q)) {
    return { tool: 'get_weekly_macro_news', args: {}, label: 'Weekly macro calendar' };
  }
  if (/(strateg|setup|rule|backtest)/.test(q)) {
    return { tool: 'list_strategies', args: {}, label: 'Strategy registry' };
  }
  if (/(analysis|regime|bias|positioning|cot|open interest)/.test(q)) {
    return { tool: 'get_latest_analysis', args: {}, label: 'Latest published analysis' };
  }
  return { tool: 'get_latest_analysis', args: {}, label: 'Desk snapshot' };
}

function renderChat(): void {
  const host = $('mChatLog');
  if (!host) return;
  host.innerHTML = chat
    .map(
      (t) => `<div class="m-msg ${t.role}">
        <div class="m-msg-k">${t.role === 'user' ? 'YOU' : 'VAELOR COPILOT'}</div>
        <div class="m-msg-text">${t.role === 'bot' ? esc(t.text) : esc(t.text)}</div>
        ${t.meta ? `<div class="m-msg-meta">${esc(t.meta)}</div>` : ''}
      </div>`,
    )
    .join('');
  host.scrollTop = host.scrollHeight;
}

async function ask(message: string): Promise<void> {
  const text = message.trim();
  if (!text) return;
  chat.push({ role: 'user', text });
  renderChat();

  if (!can('ai_chat')) {
    chat.push({
      role: 'bot',
      text: 'The MCP copilot is part of the subscription. The free tier keeps the backtest and the operating manual.',
      meta: 'locked · ai_chat',
    });
    renderChat();
    return;
  }

  chat.push({ role: 'bot', text: 'Reading the macro engine…', meta: 'mcp · working' });
  renderChat();
  const workIndex = chat.length - 1;
  const { tool, args, label } = route(text);
  try {
    const answer = await mcpTool(tool, args);
    chat[workIndex] = { role: 'bot', text: answer, meta: `mcp · ${tool}` };
    pushNotification({ kind: 'ai', title: label, body: text.slice(0, 120) });
    renderNotifications();
  } catch (e) {
    chat[workIndex] = {
      role: 'bot',
      text: `The macro engine did not answer: ${(e as Error).message}. Retry in a moment.`,
      meta: `mcp · ${tool} · error`,
    };
  }
  renderChat();
}

function wireChat(): void {
  const form = $<HTMLFormElement>('mChatForm');
  const input = $<HTMLTextAreaElement>('mChatInput');
  if (form && input) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = input.value;
      input.value = '';
      void ask(value);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
  }
  document.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      showView('copilot');
      void ask(btn.dataset.prompt ?? '');
    });
  });
  const clear = $('mChatClear');
  clear?.addEventListener('click', () => {
    chat.length = 0;
    chat.push({
      role: 'bot',
      text: 'Copilot ready. Ask about signals, COT positioning, this week’s releases or measured performance.',
      meta: 'mcp · idle',
    });
    renderChat();
  });
}

/* ------------------------------------------------------------------ */
/* Subscription actions                                                */
/* ------------------------------------------------------------------ */

function requestPlan(plan: Plan): void {
  if (!user) return;
  const requests = readRequests();
  requests.unshift({
    id: `r_${Date.now()}`,
    username: user.username,
    email: user.email ?? '',
    plan: plan.id,
    planName: plan.name,
    price: plan.price,
    at: Date.now(),
    status: 'pending',
  });
  localStorage.setItem(REQ_KEY, JSON.stringify(requests.slice(0, 200)));
  pushNotification({
    kind: 'subscription',
    title: 'Upgrade requested',
    body: `${plan.name} — awaiting owner activation.`,
  });
  renderNotifications();
  toast(`${plan.name} requested. The desk will activate it shortly.`);
}

function readRequests(): Array<{
  id: string;
  username: string;
  email: string;
  plan: string;
  planName: string;
  price: string;
  at: number;
  status: string;
}> {
  try {
    const raw = localStorage.getItem(REQ_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ReturnType<typeof readRequests>) : [];
  } catch {
    return [];
  }
}

function startTrial(): void {
  if (!user) return;
  const now = Date.now();
  setSubscription(user.username, {
    tier: 'subscriber',
    status: 'trialing',
    startedAt: now,
    expiresAt: now + 7 * 86400_000,
  });
  pushNotification({
    kind: 'subscription',
    title: '7-day trial active',
    body: 'Every subscription feature is unlocked until the trial ends.',
  });
  renderAll();
  toast('Trial active — the full toolkit is unlocked for 7 days.');
}

/* ------------------------------------------------------------------ */
/* Views                                                              */
/* ------------------------------------------------------------------ */

const VIEWS = ['overview', 'capabilities', 'copilot', 'notifications', 'account'] as const;
type View = (typeof VIEWS)[number];

function showView(view: string): void {
  const target = (VIEWS as readonly string[]).includes(view) ? (view as View) : 'overview';
  document.querySelectorAll<HTMLElement>('[data-view-panel]').forEach((p) => {
    p.hidden = p.dataset.viewPanel !== target;
  });
  document.querySelectorAll<HTMLButtonElement>('[data-view-link]').forEach((b) => {
    b.classList.toggle('active', b.dataset.viewLink === target);
    b.setAttribute('aria-current', b.dataset.viewLink === target ? 'page' : 'false');
  });
  const title = $('mViewTitle');
  const label: Record<View, string> = {
    overview: 'Overview',
    capabilities: 'Capabilities',
    copilot: 'AI Copilot',
    notifications: 'Notifications',
    account: 'Account & plan',
  };
  if (title) title.textContent = label[target];
  if (target === 'notifications') markRead();
  document.querySelector('.m-main')?.scrollTo({ top: 0 });
  history.replaceState(null, '', `#${target}`);
}

function wireNav(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-view-link]').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.viewLink ?? 'overview'));
  });
  const hash = location.hash.replace('#', '');
  if (hash === 'copilot') showView('copilot');
  else if (hash === 'account') showView('account');
  else if (hash === 'capabilities') showView('capabilities');
  else showView('overview');
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    if (h) showView(h);
  });
}

function wireActions(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-plan]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.plan as Plan['id'];
      const plan = PLANS.find((p) => p.id === id);
      if (plan) requestPlan(plan);
    });
  });
  $('mTrialBtn')?.addEventListener('click', startTrial);
  $('mMarkRead')?.addEventListener('click', markRead);
  $('mSignOut')?.addEventListener('click', () => {
    localStorage.removeItem('vaelor_active_session_v1');
    location.href = '/login.html';
  });
  const mcpCopy = $('mMcpCopy');
  mcpCopy?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`${WORKER}/mcp`);
      toast('MCP endpoint copied.');
    } catch {
      toast('Copy blocked by the browser — select the endpoint manually.');
    }
  });
}

/* ------------------------------------------------------------------ */
/* Mount                                                              */
/* ------------------------------------------------------------------ */

function renderAll(): void {
  renderIdentity();
  renderPlan();
  renderCapabilities();
  renderNotifications();
}

export function mountMember(): void {
  const root = document.getElementById('memberPage');
  if (!root) return;
  user = getCurrentUser();
  if (!user?.username) {
    location.replace('/login.html');
    return;
  }
  renderAll();
  wireNav();
  wireActions();
  wireChat();
  chat.push({
    role: 'bot',
    text: 'Copilot ready. Ask about signals, COT positioning, this week’s releases or measured performance.',
    meta: 'mcp · idle',
  });
  renderChat();

  window.setInterval(() => {
    const paid = getTier() === 'subscriber';
    if (paid) {
      const time = $('mPlanTime');
      if (time) time.textContent = formatRemaining(getSubscriptionRemainingSeconds());
      const stat = $('mTimeStat');
      if (stat) stat.textContent = formatRemaining(getSubscriptionRemainingSeconds());
    }
  }, 30_000);
}
