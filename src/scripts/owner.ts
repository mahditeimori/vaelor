/**
 * Owner console — /owner.
 *
 * Discreet, unlinked surface for monitoring members and the paired MT5 desk.
 * Reads the same browser-local registry the member dashboards write:
 *
 *   vaelor_users_db_v1        registered members
 *   vaelor_sub:<username>     plan per member
 *   vaelor_notif:<username>   activity feed
 *   vaelor_subreq             pending upgrade requests
 *   vaelor.bridge.pairing     MT5 bridge URL + token
 *
 * The bridge snapshot calls the member's own bridge `/api/status`; nothing is
 * invented when the bridge is offline.
 */
import {
  getSubscription,
  getSubscriptionRemainingSeconds,
  getUsers,
  setSubscription,
  type MemberUser,
} from './membership';

const ACCESS_KEY = 'VAELOR-OWNER';
const UNLOCK_KEY = 'vaelor.owner.unlocked';
const REQ_KEY = 'vaelor_subreq';
const BRIDGE_KEY = 'vaelor.bridge.pairing';

const OWNER_NOTIF_KEY = (u: string) => `vaelor_notif:${u}`;

interface UpgradeRequest {
  id: string;
  username: string;
  email: string;
  plan: string;
  planName: string;
  price: string;
  at: number;
  status: string;
}

interface BridgeStatus {
  ok?: boolean;
  version?: string;
  mode?: string;
  connected?: boolean;
  tradingEnabled?: boolean;
  account?: {
    login?: number | string;
    server?: string;
    currency?: string;
    balance?: number;
    equity?: number;
    leverage?: number;
    demo?: boolean;
  } | null;
  safety?: { killSwitch?: boolean; propSafe?: boolean; allowLiveTrades?: boolean };
  cloud?: { configured?: boolean; lastSync?: string; error?: string } | null;
  positions?: { open?: number; pending?: number } | null;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

const money = (v: number | undefined, ccy = 'USD'): string =>
  typeof v === 'number'
    ? `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${ccy}`
    : '—';

function toast(message: string): void {
  let el = document.getElementById('ownerToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ownerToast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  window.setTimeout(() => el?.classList.remove('show'), 3000);
}

function readRequests(): UpgradeRequest[] {
  try {
    const raw = localStorage.getItem(REQ_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as UpgradeRequest[]) : [];
  } catch {
    return [];
  }
}

function writeRequests(list: UpgradeRequest[]): void {
  localStorage.setItem(REQ_KEY, JSON.stringify(list.slice(0, 200)));
}

function notifKeyCount(username: string): number {
  try {
    const raw = localStorage.getItem(OWNER_NOTIF_KEY(username));
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((n) => n && n.read === false).length : 0;
  } catch {
    return 0;
  }
}

function lastActivity(username: string): number | null {
  try {
    const raw = localStorage.getItem(OWNER_NOTIF_KEY(username));
    const list = raw ? (JSON.parse(raw) as Array<{ at?: number }>) : [];
    if (!Array.isArray(list) || !list.length) return null;
    return Math.max(...list.map((n) => Number(n.at ?? 0)));
  } catch {
    return null;
  }
}

/**
 * Entitlements live on the server (`s:<userId>` in KV) so a grant reaches the
 * member from whichever browser the owner uses. The local write below keeps
 * this console responsive and still works in a static preview without Functions.
 */
async function grantOnServer(options: {
  username: string;
  tier: 'operator' | 'desk' | 'free';
  days?: number;
  requestId?: string;
}): Promise<boolean> {
  try {
    const response = await fetch('/api/subscription/grant', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(options),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function grant(
  username: string,
  days: number,
  options: { tier?: 'operator' | 'desk'; requestId?: string } = {},
): Promise<void> {
  const tier = options.tier ?? 'desk';
  const now = Date.now();
  setSubscription(username, {
    tier,
    status: 'active',
    startedAt: now,
    expiresAt: now + days * 86400_000,
  });
  try {
    const raw = localStorage.getItem(OWNER_NOTIF_KEY(username));
    const list: Array<Record<string, unknown>> = raw ? JSON.parse(raw) : [];
    list.unshift({
      id: `n_${Date.now()}`,
      kind: 'subscription',
      title: 'Subscription active',
      body: `${days} days of ${tier} access are now unlocked.`,
      at: now,
      read: false,
    });
    localStorage.setItem(OWNER_NOTIF_KEY(username), JSON.stringify(list.slice(0, 50)));
  } catch {
    /* notification is best-effort */
  }
  renderMembers();
  void renderRequests();
  renderActivity();
  const synced = await grantOnServer({ username, tier, days, requestId: options.requestId });
  toast(
    synced
      ? `${username}: ${tier}, ${days} days granted.`
      : `${username}: saved in this browser only — the server refused or is unreachable.`,
  );
}

async function revoke(username: string): Promise<void> {
  setSubscription(username, { tier: 'free', status: 'canceled', startedAt: null, expiresAt: null });
  renderMembers();
  const synced = await grantOnServer({ username, tier: 'free' });
  toast(synced ? `${username}: plan set to free.` : `${username}: cleared locally only.`);
}

function unlock(): void {
  const form = $<HTMLFormElement>('ownerGateForm');
  const input = $<HTMLInputElement>('ownerKey');
  const gate = $('ownerGate');
  const app = $('ownerApp');
  if (!form || !input || !gate || !app) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (input.value.trim() !== ACCESS_KEY) {
      const err = $('ownerGateError');
      if (err) err.textContent = 'Access key rejected.';
      return;
    }
    sessionStorage.setItem(UNLOCK_KEY, '1');
    gate.hidden = true;
    app.hidden = false;
    mountConsole();
  });
  if (sessionStorage.getItem(UNLOCK_KEY) === '1') {
    gate.hidden = true;
    app.hidden = false;
    mountConsole();
  }
}

/* ------------------------------------------------------------------ */
/* Members                                                            */
/* ------------------------------------------------------------------ */

function renderMembers(): void {
  const body = $('ownerMembers');
  if (!body) return;
  const users = getUsers();
  if (!users.length) {
    body.innerHTML = '<tr><td colspan="6" class="o-empty">No registered members yet. Accounts created on the login console appear here.</td></tr>';
    return;
  }
  body.innerHTML = users
    .map((u: MemberUser) => {
      const sub = getSubscription(u.username);
      const remaining = getSubscriptionRemainingSeconds();
      const paid = sub.tier !== 'free' && sub.status !== 'canceled';
      const left =
        paid && sub.expiresAt
          ? `${Math.max(0, Math.ceil((sub.expiresAt - Date.now()) / 86400_000))} d`
          : '—';
      const activity = lastActivity(u.username);
      return `<tr>
        <td>
          <b>${esc(`${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.username)}</b>
          <span class="o-sub">@${esc(u.username)} · ${esc(u.email ?? 'no email')}</span>
        </td>
        <td><span class="o-tag ${paid ? 'ok' : ''}">${paid ? esc(sub.status) : 'free'}</span></td>
        <td>${left}</td>
        <td>${notifKeyCount(u.username)}</td>
        <td>${activity ? new Date(activity).toLocaleString() : '—'}</td>
        <td class="o-actions">
          <button type="button" data-grant="30" data-user="${esc(u.username)}">+30d</button>
          <button type="button" data-grant="365" data-user="${esc(u.username)}">+365d</button>
          <button type="button" data-revoke data-user="${esc(u.username)}">free</button>
        </td>
      </tr>`;
    })
    .join('');

  body.querySelectorAll<HTMLButtonElement>('[data-grant]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const user = btn.dataset.user ?? '';
      const days = Number(btn.dataset.grant ?? 30);
      if (user) grant(user, days);
    });
  });
  body.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const user = btn.dataset.user ?? '';
      if (user) revoke(user);
    });
  });

  const total = users.length;
  const paidCount = users.filter((u) => {
    const s = getSubscription(u.username);
    return s.tier !== 'free' && s.status !== 'canceled';
  }).length;
  const stat = (id: string, value: string) => {
    const node = $(id);
    if (node) node.textContent = value;
  };
  stat('oMembersTotal', String(total));
  stat('oMembersPaid', String(paidCount));
  stat('oMembersFree', String(total - paidCount));
  stat('oMembersMrr', `$${(paidCount * 149).toLocaleString()}`);
  void remainingUnused;
}

function remainingUnused(): void {
  /* keeps the import bundle honest; remaining time is shown per row */
  void getSubscriptionRemainingSeconds;
}

/* ------------------------------------------------------------------ */
/* Requests                                                           */
/* ------------------------------------------------------------------ */

async function fetchRemoteRequests(): Promise<UpgradeRequest[] | null> {
  try {
    const response = await fetch('/api/subscription/requests', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { requests?: UpgradeRequest[] };
    return Array.isArray(payload.requests) ? payload.requests : [];
  } catch {
    return null;
  }
}

async function renderRequests(): Promise<void> {
  const host = $('ownerRequests');
  if (!host) return;
  const remote = await fetchRemoteRequests();
  const requests = remote ?? readRequests().filter((r) => r.status === 'pending');
  if (!requests.length) {
    host.innerHTML = '<p class="o-empty">No pending upgrade requests.</p>';
    updateRequestBadge(0);
    return;
  }
  host.innerHTML = requests
    .map(
      (r) => `<article class="o-req">
        <div>
          <b>@${esc(r.username)}</b>
          <span>${esc(r.planName)} · ${esc(r.price)} · ${new Date(r.at).toLocaleString()}</span>
        </div>
        <div class="o-actions">
          <button type="button" data-approve="${esc(r.id)}" data-user="${esc(r.username)}" data-plan="${esc(r.plan)}">Approve</button>
          <button type="button" data-deny="${esc(r.id)}">Dismiss</button>
        </div>
      </article>`,
    )
    .join('');

  host.querySelectorAll<HTMLButtonElement>('[data-approve]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.approve ?? '';
      const user = btn.dataset.user ?? '';
      const plan = btn.dataset.plan ?? 'desk';
      // Server records carry the real tier; older local ones carried a period.
      const tier: 'operator' | 'desk' = plan === 'operator' ? 'operator' : 'desk';
      const days = plan === 'annual' ? 365 : 30;
      const list = readRequests().map((r) => (r.id === id ? { ...r, status: 'approved' } : r));
      writeRequests(list);
      if (user) void grant(user, days, { tier, requestId: id });
    });
  });
  host.querySelectorAll<HTMLButtonElement>('[data-deny]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.deny ?? '';
      writeRequests(readRequests().map((r) => (r.id === id ? { ...r, status: 'dismissed' } : r)));
      void renderRequests();
    });
  });

  updateRequestBadge(requests.length);
}

function updateRequestBadge(count: number): void {
  const badge = $('oReqCount');
  if (badge) badge.textContent = String(count);
}

/* ------------------------------------------------------------------ */
/* Activity                                                           */
/* ------------------------------------------------------------------ */

function renderActivity(): void {
  const host = $('ownerActivity');
  if (!host) return;
  const rows: Array<{ username: string; title: string; kind: string; at: number }> = [];
  for (const u of getUsers()) {
    try {
      const raw = localStorage.getItem(OWNER_NOTIF_KEY(u.username));
      const list = raw ? (JSON.parse(raw) as Array<{ title?: string; kind?: string; at?: number }>) : [];
      for (const n of list) {
        if (!n?.title) continue;
        rows.push({ username: u.username, title: n.title, kind: n.kind ?? 'system', at: Number(n.at ?? 0) });
      }
    } catch {
      /* skip malformed */
    }
  }
  rows.sort((a, b) => b.at - a.at);
  if (!rows.length) {
    host.innerHTML = '<p class="o-empty">No member activity recorded yet.</p>';
    return;
  }
  host.innerHTML = rows
    .slice(0, 12)
    .map(
      (r) => `<article class="o-act">
        <span class="o-tag">${esc(r.kind)}</span>
        <div><b>@${esc(r.username)}</b> — ${esc(r.title)}</div>
        <time>${new Date(r.at).toLocaleString()}</time>
      </article>`,
    )
    .join('');
}

/* ------------------------------------------------------------------ */
/* MT5 bridge snapshot                                                */
/* ------------------------------------------------------------------ */

function readPairing(): { url: string; token: string } | null {
  try {
    const raw = localStorage.getItem(BRIDGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { url?: string; token?: string };
    if (!p?.url || !p?.token) return null;
    return { url: p.url.replace(/\/+$/, ''), token: p.token };
  } catch {
    return null;
  }
}

async function renderBridge(): Promise<void> {
  const host = $('ownerBridge');
  if (!host) return;
  const pairing = readPairing();
  if (!pairing) {
    host.innerHTML = '<p class="o-empty">No bridge paired in this browser. Pair once from the Execution page to monitor the desk here.</p>';
    return;
  }
  host.innerHTML = '<p class="o-empty">Reading bridge status…</p>';
  try {
    const res = await fetch(`${pairing.url}/api/status`, {
      headers: { 'x-bridge-token': pairing.token },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = (await res.json()) as BridgeStatus;
    const acc = s.account;
    const ccy = acc?.currency ?? 'USD';
    host.innerHTML = `
      <div class="o-bridge-grid">
        <div class="o-b-card"><span>Mode</span><b>${esc(s.mode ?? '—')}</b></div>
        <div class="o-b-card"><span>Connected</span><b class="${s.connected ? 'o-ok' : 'o-bad'}">${s.connected ? 'terminal linked' : 'offline'}</b></div>
        <div class="o-b-card"><span>Trading enabled</span><b class="${s.tradingEnabled ? 'o-ok' : ''}">${s.tradingEnabled ? 'yes' : 'no'}</b></div>
        <div class="o-b-card"><span>Version</span><b>${esc(s.version ?? '—')}</b></div>
        <div class="o-b-card"><span>Login / server</span><b>${esc(acc?.login ?? '—')} · ${esc(acc?.server ?? '—')}</b></div>
        <div class="o-b-card"><span>Account type</span><b>${acc?.demo === true ? 'demo' : acc?.demo === false ? 'live' : '—'}</b></div>
        <div class="o-b-card"><span>Balance</span><b>${money(acc?.balance, ccy)}</b></div>
        <div class="o-b-card"><span>Equity</span><b>${money(acc?.equity, ccy)}</b></div>
        <div class="o-b-card"><span>Leverage</span><b>1:${esc(acc?.leverage ?? '—')}</b></div>
        <div class="o-b-card"><span>Open positions</span><b>${esc(s.positions?.open ?? '—')}</b></div>
        <div class="o-b-card"><span>Kill switch</span><b class="${s.safety?.killSwitch ? 'o-bad' : 'o-ok'}">${s.safety?.killSwitch ? 'engaged' : 'off'}</b></div>
        <div class="o-b-card"><span>Cloud sync</span><b class="${s.cloud?.error ? 'o-bad' : 'o-ok'}">${s.cloud?.error ? 'error' : s.cloud?.configured ? 'configured' : 'off'}</b></div>
      </div>`;
  } catch (e) {
    host.innerHTML = `<p class="o-empty">Bridge did not answer (${esc((e as Error).message)}). It may be off or unreachable from this browser.</p>`;
  }
}

/* ------------------------------------------------------------------ */
/* Mount                                                              */
/* ------------------------------------------------------------------ */

function mountConsole(): void {
  renderMembers();
  void renderRequests();
  renderActivity();
  void renderBridge();
  $('ownerRefresh')?.addEventListener('click', () => {
    renderMembers();
    void renderRequests();
    renderActivity();
    void renderBridge();
    toast('Console refreshed.');
  });
  $('ownerLock')?.addEventListener('click', () => {
    sessionStorage.removeItem(UNLOCK_KEY);
    location.reload();
  });
}

export function mountOwner(): void {
  if (!document.getElementById('ownerPage')) return;
  unlock();
}
