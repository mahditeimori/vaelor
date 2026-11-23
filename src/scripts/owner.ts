/**
 * Owner console — /owner, fully server-backed.
 *
 * The Owner menu is the complete Owner management surface: the full member
 * directory (server `/api/owner/members` first, local mirror second), the
 * per-user activity pane, upgrade requests, the paired bridge snapshot, the
 * audit log, and the owner feature/strategy catalogs.
 */
import { getPlan, getSubscription, getUsers, setSubscription, type Tier } from './membership';

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

interface AuditEntry {
  id?: number;
  ts: string;
  actor: string;
  action: string;
  ok?: boolean;
  detail?: string;
}

interface OwnerMember {
  id: string;
  username: string;
  name: string;
  firstName?: string;
  lastName?: string;
  email: string;
  providers: string[];
  createdAt: number;
  lastActiveAt?: number;
  subscription: {
    tier: Tier;
    status: string;
    startedAt: number | null;
    expiresAt: number | null;
  };
}

interface OwnerSession {
  id: string;
  userId: string;
  email: string;
  provider: string;
  createdAt: number;
  expiresAt: number;
}

interface MemberRow extends OwnerMember {
  planMrr: number;
  paid: boolean;
  daysLeft: number | null;
  operatorPaid: boolean;
  deskPaid: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

const fmtMoney = (v: number | undefined) =>
  typeof v === 'number' ? `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—';

const DAY_MS = 86400_000;
const MRR_MULT: Record<string, number> = { free: 0, operator: 49, desk: 199 };

function toast(message: string): void {
  let el = document.getElementById('ownerToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ownerToast';
    el.className = 'o-toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  window.setTimeout(() => el?.classList.remove('show'), 2200);
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

function formatDate(ms?: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

function relativeTime(ms: number | null): string {
  if (!ms) return '—';
  const diff = ms - Date.now();
  if (diff <= 0) return 'now';
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'a minute ago';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function readLocalUsers(): Array<{ username: string; email: string; name: string; providers: string[] }> {
  return getUsers()
    .filter((u) => Boolean(u.username))
    .map((u) => ({
      username: u.username ?? '',
      email: u.email ?? '',
      name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || (u.username ?? ''),
      providers: [u.provider].filter(Boolean) as string[],
    }));
}

/* ------------------------------------------------------------------ */
/* Member rows                                                         */
/* ------------------------------------------------------------------ */

let serverMembers: OwnerMember[] | null = null;
let membersFetchAttempted = false;

function paidFrom(sub: { tier: string; status: string; expiresAt?: number | null }): boolean {
  return sub.tier !== 'free' && sub.status !== 'canceled' && Boolean(sub.expiresAt);
}

function enrichMember(m: OwnerMember): MemberRow {
  const tier = TIERS_SAFE.includes(m.subscription?.tier) ? (m.subscription.tier as Tier) : 'free';
  const paid = paidFrom(m.subscription);
  const daysLeft = paid && m.subscription.expiresAt ? Math.max(0, Math.ceil((m.subscription.expiresAt - Date.now()) / DAY_MS)) : null;
  return {
    ...m,
    subscription: { tier, status: paid ? m.subscription.status : 'canceled', startedAt: m.subscription.startedAt, expiresAt: m.subscription.expiresAt },
    planMrr: (MRR_MULT[tier] * (daysLeft ?? 0)) / 30,
    paid,
    daysLeft,
    operatorPaid: paid && tier === 'operator',
    deskPaid: paid && tier === 'desk',
  };
}

const TIERS_SAFE: string[] = ['free', 'operator', 'desk'];

function memberRows(): MemberRow[] {
  const rows: MemberRow[] = [];
  const seen = new Set<string>();

  serverMembers?.forEach((m) => {
    const username = (m.username || m.email || '').trim();
    if (!username || seen.has(username)) return;
    seen.add(username);
    rows.push(enrichMember(m));
  });
  for (const u of readLocalUsers()) {
    if (seen.has(u.username)) continue;
    seen.add(u.username);
    const sub = getSubscription(u.username);
    const paid = paidFrom(sub);
    const daysLeft = paid && sub.expiresAt ? Math.max(0, Math.ceil((sub.expiresAt - Date.now()) / DAY_MS)) : null;
    const m: OwnerMember = {
      id: `local:${u.username.toLowerCase()}`,
      username: u.username,
      name: u.name,
      firstName: u.name.split(' ')[0] ?? u.name,
      lastName: u.name.split(' ').slice(1).join(' '),
      email: u.email ?? '',
      providers: u.providers,
      createdAt: 0,
      lastActiveAt: lastActivity(u.username) ?? undefined,
      subscription: sub,
    };
    rows.push({
      ...m,
      planMrr: (MRR_MULT[sub.tier] * (daysLeft ?? 0)) / 30,
      paid,
      daysLeft,
      operatorPaid: paid && sub.tier === 'operator',
      deskPaid: paid && sub.tier === 'desk',
    });
  }
  return rows;
}

function sortRows(rows: MemberRow[], mode: SortMode): MemberRow[] {
  const out = [...rows];
  if (mode === 'name') out.sort((a, b) => a.username.localeCompare(b.username) || a.name.localeCompare(b.name));
  if (mode === 'newest') out.sort((a, b) => b.createdAt - a.createdAt || (a.lastActiveAt ?? 0) - (b.lastActiveAt ?? 0));
  if (mode === 'paid') out.sort((a, b) => Number(b.paid) - Number(a.paid) || (b.daysLeft ?? 0) - (a.daysLeft ?? 0) || b.createdAt - a.createdAt);
  if (mode === 'active') out.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || b.createdAt - a.createdAt);
  return out;
}

function filteredRows(rows: MemberRow[], tier: TierFilter, query: string): MemberRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (tier !== 'all' && row.subscription.tier !== tier) return false;
    if (!q) return true;
    return (
      row.username.toLowerCase().includes(q) ||
      row.name.toLowerCase().includes(q) ||
      row.email.toLowerCase().includes(q) ||
      row.id.toLowerCase().includes(q)
    );
  });
}

async function grantOnServer(options: { username: string; tier: Tier; days?: number; requestId?: string }): Promise<boolean> {
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

function setSubscriptionLocal(username: string, tier: Tier, days: number | null, status: 'active' | 'canceled' = 'active'): void {
  const nowMs = Date.now();
  setSubscription(username, {
    tier,
    status,
    startedAt: status === 'active' && days ? nowMs : null,
    expiresAt: status === 'active' && days ? nowMs + days * DAY_MS : null,
  });
}

async function grant(username: string, days: number, options: { tier?: Tier; requestId?: string } = {}): Promise<void> {
  const tier = options.tier ?? 'desk';
  setSubscriptionLocal(username, tier, days);
  try {
    const raw = localStorage.getItem(OWNER_NOTIF_KEY(username));
    const list: Array<Record<string, unknown>> = raw ? JSON.parse(raw) : [];
    list.unshift({
      id: `n_${Date.now()}`,
      kind: 'subscription',
      title: 'Subscription active',
      body: `${tier === 'desk' ? 'Desk ($199/mo)' : tier === 'operator' ? 'Operator ($49/mo)' : 'Free plan'} — ${Math.round(days)} days until expiry.`,
      at: Date.now(),
      read: false,
    });
    localStorage.setItem(OWNER_NOTIF_KEY(username), JSON.stringify(list.slice(0, 50)));
  } catch { /* best-effort */ }
  const synced = await grantOnServer({ username, tier, days, requestId: options.requestId });
  if (synced) {
    serverMembers = null;
    membersFetchAttempted = false;
    renderMembers();
    renderMrrChart();
  }
  toast(synced ? `${username}: ${tier} — ${days} days granted on the server.` : `${username}: saved in this browser only.`);
}

async function editPlan(username: string, tier: Tier, days: number): Promise<void> {
  setSubscriptionLocal(username, tier, days);
  const synced = await grantOnServer({ username, tier, days });
  if (synced) {
    serverMembers = null;
    membersFetchAttempted = false;
    renderMembers();
    renderMrrChart();
  }
  toast(synced ? `${username}: plan changed to ${tier}.` : `${username}: edited locally only.`);
}

async function revoke(username: string): Promise<void> {
  setSubscriptionLocal(username, 'free', null, 'canceled');
  const synced = await grantOnServer({ username, tier: 'free' });
  if (synced) {
    serverMembers = null;
    membersFetchAttempted = false;
    renderMembers();
    renderMrrChart();
  }
  toast(synced ? `${username}: plan set to free.` : `${username}: cleared locally only.`);
}

async function deleteUser(username: string): Promise<void> {
  if (!confirm(`Delete @${username} and remove all data?`)) return;
  const ok = await ownerFetchJson<{ ok?: boolean; deleted?: { sessionsRemoved?: number } }>('/api/owner/members/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!ok?.ok) {
    toast(`Could not delete @${username}.`);
    return;
  }
  toast(`@${username} deleted — ${ok.deleted?.sessionsRemoved ?? 0} sessions removed.`);
  serverMembers = serverMembers?.filter((m) => m.username !== username) ?? null;
  renderMembers();
  renderMrrChart();
}

/* ------------------------------------------------------------------ */
/* KPI + MRR chart                                                     */
/* ------------------------------------------------------------------ */

function updateMemberStats(rows: MemberRow[]): void {
  const paid = rows.filter((r) => r.paid).length;
  const operatorPaid = rows.filter((r) => r.operatorPaid).length;
  const deskPaid = rows.filter((r) => r.deskPaid).length;
  const totalMrr = operatorPaid * MRR_MULT.operator + deskPaid * MRR_MULT.desk;
  const active = rows.filter((r) => r.lastActiveAt && r.lastActiveAt > Date.now() - DAY_MS * 24).length;

  for (const id of ['oMembersTotal', 'oMembersPaid', 'oMembersFree', 'oMembersMrr', 'oSessionsTotal', 'oMrrRatio']) {
    const el = $(id);
    if (el) el.className = el.className.replace(/\bok\b|\bwarm\b/g, '').trim();
  }
  if ($('oMembersTotal')) $('oMembersTotal')!.textContent = String(rows.length);
  if ($('oMembersTotalSub')) $('oMembersTotalSub')!.textContent = `All tiers (${rows.length})`;
  if ($('oMembersPaid')) $('oMembersPaid')!.textContent = String(paid);
  if ($('oMembersPaidSub')) $('oMembersPaidSub')!.textContent = 'Operator+Desk';
  if ($('oMembersPaid')) $('oMembersPaid')!.parentElement?.classList.add('ok');
  if ($('oMembersFree')) $('oMembersFree')!.textContent = String(rows.length - paid);
  if ($('oMembersFreeSub')) $('oMembersFreeSub')!.textContent = 'Free';
  if ($('oMembersMrr')) $('oMembersMrr')!.textContent = fmtMoney(totalMrr);
  if ($('oMembersMrr')) $('oMembersMrr')!.parentElement?.classList.toggle('warm', totalMrr > 0);
  if ($('oMembersMrrSub')) $('oMembersMrrSub')!.textContent = `Estimated from $49 Operator / $199 Desk plans`;
  if ($('oSessionsTotal')) $('oSessionsTotal')!.textContent = String(active);
  if ($('oSessionsSub')) $('oSessionsSub')!.textContent = `Active in the last 24h`;
  if ($('oMrrRatio')) $('oMrrRatio')!.textContent = `${operatorPaid}/${deskPaid}`;
  if ($('oMrrRatioSub')) $('oMrrRatioSub')!.textContent = 'operator/desk paid counts';
}

async function renderMrrChart(): Promise<void> {
  const host = $('oMrrChartCanvas') as HTMLCanvasElement | null;
  if (!host) return;
  const months = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01'];
  const nowKey = new Date().toISOString().slice(0, 7);
  const paidGrowth: Array<{ key: string; mrr: number }> = [];
  const counts = new Map<string, { op: number; desk: number }>();
  for (const m of memberRows()) {
    if (!m.operatorPaid && !m.deskPaid) continue;
    const key = m.subscription.startedAt ? new Date(m.subscription.startedAt).toISOString().slice(0, 7) : new Date().toISOString().slice(0, 7);
    const entry = counts.get(key) ?? { op: 0, desk: 0 };
    if (m.operatorPaid) entry.op += 1;
    if (m.deskPaid) entry.desk += 1;
    counts.set(key, entry);
  }
  const latest = [...counts.keys()].sort().at(-1) ?? nowKey;
  const series = months.map((key) => {
    const entry = counts.get(key);
    const mrr = (entry?.op ?? 0) * MRR_MULT.operator + (entry?.desk ?? 0) * MRR_MULT.desk;
    return { key, mrr };
  });

  const ctx = host.getContext('2d');
  if (!ctx) return;
  const w = host.clientWidth || 720;
  const h = host.clientHeight || 280;
  const dpr = window.devicePixelRatio || 1;
  host.width = Math.max(1, Math.round(w * dpr));
  host.height = Math.max(1, Math.round(h * dpr));
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(7,4,6,0.55)';
  ctx.fillRect(0, 0, w, h);
  const left = 18, right = 12, top = 12, bottom = 34;
  const plotW = w - left - right;
  const plotH = h - top - bottom;
  const max = Math.max(...series.map((s) => s.mrr), 1);

  ctx.font = '10px var(--mono)';
  for (const k of [0, 25, 50, 75, 100]) {
    const y = top + plotH * (1 - k / 100);
    ctx.strokeStyle = 'rgba(226,69,108,0.22)';
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(w - right, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(150,147,159,0.85)';
    ctx.textAlign = 'right';
    ctx.fillText(`$${Math.round(max * k / 100)}`, left - 6, y + 3);
  }
  const slot = plotW / Math.max(series.length, 1);
  for (const [i, s] of series.entries()) {
    const x = left + (i + 0.5) * slot - slot * 0.42;
    const barW = Math.max(slot * 0.42, 5);
    const height = Math.max(s.mrr / max * 100, 0.5);
    const y = top + plotH * (1 - height / 100);
    ctx.fillStyle = s.key === nowKey ? '#fbc7cc' : s.key === latest ? 'rgba(226,69,108,0.92)' : 'rgba(226,69,108,0.75)';
    ctx.fillRect(x, y, barW, plotH * height / 100 || 0.5);
    ctx.fillStyle = 'rgba(150,147,159,0.75)';
    ctx.font = '9px var(--mono)';
    ctx.textAlign = 'center';
    ctx.fillText(s.key.slice(5), x + barW / 2, h - 22);
  }
  const current = series.find((s) => s.key === nowKey) ?? series.at(-1)!;
  ctx.fillStyle = '#f5f0f2';
  ctx.font = '11px var(--sans)';
  ctx.textAlign = 'center';
  ctx.fillText(`Estimated MRR ~$${Math.round(current.mrr)}/month · ${current.key}`, w / 2, h - 4);
  paidGrowth.push(current);
  const totalM = paidGrowth.reduce((sum, s) => sum + s.mrr, 0);
  if ($('oMrrRatioSub')) $('oMrrRatioSub')!.textContent = `Sum of current month estimates: $${Math.round(totalM)}`;
}

/* ------------------------------------------------------------------ */
/* Members table                                                       */
/* ------------------------------------------------------------------ */

type SortMode = 'newest' | 'name' | 'paid' | 'active';
type TierFilter = 'all' | 'free' | 'operator' | 'desk';

let sortMode: SortMode = 'newest';
let tierFilter: TierFilter = 'all';

function renderMembers(): void {
  const body = $('ownerMembers');
  if (!body) return;
  const rows = filteredRows(sortRows(memberRows(), sortMode), tierFilter, ($<HTMLInputElement>('oSearch')?.value ?? '').trim());
  updateMemberStats(rows);
  renderTierTabs();
  renderMembersMeta(rows);

  if (!rows.length) {
    body.innerHTML = '<tr><td class="o-empty" colspan="8">No visible members. Accounts here appear when a Google account signs in or an account is created.</td></tr>';
  } else {
    body.innerHTML = rows
      .map((row) => {
        const paid = row.paid;
        const tierTag = `<span class="o-tag ${paid ? 'ok' : ''}">${paid ? esc(row.subscription.status) : 'free'}</span>`;
        return `<tr>
          <td><b class="o-user-link" data-detail="${esc(row.username)}">${esc(row.name || row.username)}</b><span class="o-sub">@${esc(row.username)} · ${esc(row.email || 'no email')}</span></td>
          <td>${tierTag}</td>
          <td>${esc(formatDate(row.createdAt))}</td>
          <td>${paid ? esc(fmtMoney(row.planMrr)) : '—'}</td>
          <td>${row.daysLeft == null ? '—' : esc(`${row.daysLeft === 0 ? '0' : row.daysLeft}d`)}</td>
          <td>${notifKeyCount(row.username)}</td>
          <td>${esc(relativeTime(lastActivity(row.username)))}</td>
          <td>
            <span class="o-kebab" data-kebab-user="${esc(row.username)}">
              <button type="button" class="o-btn small">⋮ ${esc(row.username)}</button>
              <span class="o-kebab-menu" role="menu">
                <button type="button" data-member-action="detail">View user</button>
                <button type="button" data-member-action="grant30">Grant Operator — 30d</button>
                <button type="button" data-member-action="grant365">Grant Desk — 365d</button>
                <button type="button" data-member-action="revoke">Set plan: free</button>
                <button type="button" data-member-action="edit">Edit plan</button>
                <button type="button" data-member-action="delete">Delete user</button>
              </span>
            </span>
          </td>
        </tr>`;
      })
      .join('');
  }

  body.querySelectorAll<HTMLElement>('[data-detail]').forEach((el) => {
    el.addEventListener('click', () => void renderUserDetail(el.dataset.detail ?? ''));
  });
  body.querySelectorAll<HTMLElement>('[data-kebab-user]').forEach((kebab) => {
    kebab.addEventListener('click', () => {
      kebab.classList.toggle('open');
      body.querySelectorAll<HTMLElement>('[data-kebab-user].open').forEach((other) => {
        if (other !== kebab) other.classList.remove('open');
      });
    });
    kebab.querySelectorAll<HTMLButtonElement>('[data-member-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const user = kebab.dataset.kebabUser ?? '';
        const action = btn.dataset.memberAction ?? '';
        kebab.classList.remove('open');
        if (user) {
          if (action === 'detail') void renderUserDetail(user);
          if (action === 'grant30') void grant(user, 30, { tier: 'operator' });
          if (action === 'grant365') void grant(user, 365, { tier: 'desk' });
          if (action === 'revoke') void revoke(user);
          if (action === 'edit') void editPlanForUser(user);
          if (action === 'delete') void deleteUser(user);
        }
      });
    });
  });
  void loadServerMembers();
}

async function editPlanForUser(username: string): Promise<void> {
  const row = memberRows().find((r) => r.username === username);
  const current = row?.subscription.tier ?? 'free';
  const daysInput = prompt(`How many days should @${username} have? (30/90/365 or blank for Free)`, String(row?.daysLeft ?? 0)) ?? '';
  const days = Number.parseInt(daysInput, 10);
  if (Number.isNaN(days) || days < 0 || days > 3650) {
    toast('Enter a number of days between 0 and 3650, or leave blank.');
    return;
  }
  if (days === 0) {
    await revoke(username);
    return;
  }
  const tier = days >= 365 ? 'desk' : 'operator';
  await grant(username, Math.min(days, 3650), { tier });
}

function renderMembersMeta(rows: MemberRow[]): void {
  const meta = $('oMembersMeta');
  if (!meta) return;
  meta.innerHTML = `<b>${rows.length}</b> visible · paid <b>${rows.filter((r) => r.paid).length}</b>`;
}

function renderTierTabs(): void {
  const host = $('oTierTabs');
  if (!host) return;
  host.innerHTML = [
    { id: 'all', label: 'All tiers' },
    { id: 'free', label: 'Free' },
    { id: 'operator', label: 'Operator' },
    { id: 'desk', label: 'Desk' },
  ]
    .map((t) => `<button type="button" class="${tierFilter === t.id ? 'is-active' : ''}" data-tier="${t.id}">${t.label}</button>`)
    .join('');
  host.querySelectorAll<HTMLButtonElement>('[data-tier]').forEach((btn) => {
    btn.addEventListener('click', () => {
      tierFilter = btn.dataset.tier as TierFilter;
      renderTierTabs();
      renderMembers();
    });
  });
}

async function loadServerMembers(): Promise<void> {
  if (serverMembers !== null || membersFetchAttempted) return;
  membersFetchAttempted = true;
  const payload = await ownerFetchJson<{ ok?: boolean; members?: OwnerMember[] }>('/api/owner/members', {
    headers: { accept: 'application/json' },
  });
  if (!payload?.ok || !Array.isArray(payload.members)) return;
  serverMembers = payload.members.map((m) => ({
    ...m,
    name: (m.name || `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || m.username).trim(),
  }));
  renderMembers();
  void renderMrrChart();
}

/* ------------------------------------------------------------------ */
/* User detail                                                         */
/* ------------------------------------------------------------------ */

interface ServerDetail {
  serverMember: OwnerMember | null;
  sessions: OwnerSession[];
  requests: UpgradeRequest[];
}

interface DetailContext {
  tab: string;
  notifs: Array<{ id?: string; kind?: string; title?: string; body?: string; at?: number; read?: boolean }>;
}

function readOwnerNotifs(username: string): DetailContext['notifs'] {
  try {
    const raw = localStorage.getItem(OWNER_NOTIF_KEY(username));
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? (list as DetailContext['notifs']) : [];
  } catch {
    return [];
  }
}

function renderUserDetail(username: string): void {
  const panel = $('oUserDetail');
  if (!panel) return;
  panel.hidden = false;
  $('oUserDetailTitle')!.textContent = `User details — @${username}`;
  const body = $('oUserDetailBody');
  if (body) body.innerHTML = '<p class="o-empty">Loading…</p>';
  void renderUserDetailAsync(username, panel);
}

async function renderUserDetailAsync(username: string, panel: HTMLElement): Promise<void> {
  const detail = await loadServerDetail(username);
  const row = memberRows().find((r) => r.username === username) ?? null;
  const sub = detail.serverMember?.subscription ?? (row ? getSubscription(row.username) : null);
  const notifs = readOwnerNotifs(username).filter((n) => n.at).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  const meta = $('oUserDetailMeta');
  if (meta) {
    const email = detail.serverMember?.email || readLocalUsers().find((u) => u.username === username)?.email || '';
    const providers = detail.serverMember?.providers?.length ? detail.serverMember.providers.join(', ') : (readLocalUsers().find((u) => u.username === username)?.providers ?? []).join(', ');
    meta.innerHTML = `
      <div>${esc(email)}${providers ? ` · ${esc(providers)}` : ''}</div>
      <div class="o-sub">${esc(sub?.tier ?? 'free')} · ${esc(sub?.status ?? 'active')} · ${esc(formatDate(detail.serverMember?.createdAt ?? row?.createdAt))}</div>`;
  }

  const tabs = $('oUserDetailTabs');
  if (tabs) {
    tabs.innerHTML = [
      { id: 'overview', label: 'Overview' },
      { id: 'activity', label: 'Activity' },
      { id: 'plans', label: 'Plans' },
      { id: 'sessions', label: 'Sessions' },
      { id: 'notifications', label: 'Notifications' },
      { id: 'actions', label: 'Actions' },
    ].map((t) => `<button type="button" class="${t.id === 'overview' ? 'is-active' : ''}" data-detail-tab="${t.id}">${t.label}</button>`).join('');
    tabs.querySelectorAll<HTMLButtonElement>('[data-detail-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        tabs.querySelectorAll<HTMLElement>('[data-detail-tab]').forEach((b) => b.classList.toggle('is-active', b === btn));
        renderUserDetailBody(username, detail, { tab: btn.dataset.detailTab ?? 'overview', notifs });
      });
    });
  }
  renderUserDetailBody(username, detail, { tab: 'overview', notifs });
  attachUserDetailControls(username, panel);
}

async function loadServerDetail(username: string): Promise<ServerDetail> {
  const payload = await ownerFetchJson<{ ok?: boolean; members?: OwnerMember[]; sessions?: OwnerSession[] }>(
    '/api/owner/members',
    { headers: { accept: 'application/json' } },
  );
  const serverMember = (payload?.members ?? []).find((m) => m.username === username) ?? null;
  const remoteRequests = await fetchRemoteRequests();
  return {
    serverMember,
    sessions: (payload?.sessions ?? []).filter((s) => s.userId === serverMember?.id),
    requests: (remoteRequests ?? []).filter((r) => r.status === 'pending' && (r.username === username || r.email === serverMember?.email)).sort((a, b) => b.at - a.at),
  };
}

function renderUserDetailBody(username: string, detail: ServerDetail, ctx: DetailContext): void {
  const body = $('oUserDetailBody');
  if (!body) return;
  const row = memberRows().find((r) => r.username === username) ?? null;
  const sub = detail.serverMember?.subscription ?? (row ? getSubscription(row.username) : null);
  const notifs = ctx.notifs.filter((n) => n.at).slice(0, 50);
  const paid = row?.paid ?? Boolean(sub && sub.tier !== 'free' && sub.status !== 'canceled' && sub.expiresAt);
  const activeGrants = notifs.filter((n) => /Subscription active|plan/i.test(n.title ?? ''));
  const sections: Record<string, string> = {
    overview: `
      <h3>Overview</h3>
      <div class="o-d-meta">${esc(detail.serverMember?.email || readLocalUsers().find((u) => u.username === username)?.email || '')} · ${esc(readLocalUsers().find((u) => u.username === username)?.providers[0] ?? 'password')} · ID ${esc(detail.serverMember?.id ?? `local:${username}`)} · since ${esc(formatDate(detail.serverMember?.createdAt ?? row?.createdAt ?? null))}</div>
      <div class="o-bridge-grid">
        <div class="o-b-card"><span>Plan</span><b>${esc(sub?.tier ?? 'free')}</b><span>since ${formatDate(sub?.startedAt)}</span></div>
        <div class="o-b-card"><span>Days left</span><b>${row?.daysLeft == null ? '—' : `${row.daysLeft}d`}</b><span>MRR ${fmtMoney(row?.operatorPaid ? MRR_MULT.operator / 30 : row?.deskPaid ? MRR_MULT.desk / 30 : 0)}</span></div>

        <div class="o-b-card"><span>Live sessions</span><b>${String(detail.sessions.length)}</b><span>${detail.sessions.map((s) => s.provider).join(', ') || '—'}</span></div>
        <div class="o-b-card"><span>MRR contribution</span><b>${esc(paid ? fmtMoney((row?.operatorPaid ? MRR_MULT.operator : row?.deskPaid ? MRR_MULT.desk : 0) / 30) : '—')}</b><span>${paid ? 'active' : 'inactive'}</span></div>
      </div>
      <div class="o-d-meta">Estimated lifetime value: ${esc(fmtMoney((row?.operatorPaid ? MRR_MULT.operator : row?.deskPaid ? MRR_MULT.desk : 0) / 30 * (row?.daysLeft ?? 0)))}</div>`,
    activity: `
      <h3>Activity</h3>
      <div id="userActivityList">${notifs.slice(0, 12).map((n) => `
        <div class="o-d-act"><b>${esc(n.title ?? 'Activity')}</b><div class="o-sub">${esc(n.body ?? '')}</div><time>${n.at ? esc(new Date(n.at).toLocaleString()) : ''}</time></div>`).join('')}</div>
      <p class="o-empty">${notifs.length ? '' : 'No activity recorded yet.'}</p>`,
    plans: `
      <h3>Plans</h3>
      <div class="o-bridge-grid">
        <div class="o-b-card"><span>Current plan</span><b>${esc(sub?.tier ?? 'free')}</b><span>until ${esc(formatDate(sub?.expiresAt))}</span></div>
        <div class="o-b-card"><span>Active grants</span><b>${esc(activeGrants.length)}</b><span>from history/requests</span></div>
        <div class="o-b-card"><span>Days remaining</span><b>${row?.daysLeft == null ? '—' : `${row.daysLeft}d`}</b></div>
        <div class="o-b-card"><span>Requests</span><b>${detail.requests.length}</b><span>pending upgrade requests</span></div>
      </div>
      <div class="o-d-meta">History: account created ${esc(formatDate(detail.serverMember?.createdAt ?? row?.createdAt ?? null))}; current entitlement written server-side with every grant.</div>
      <div class="o-d-sec"><b>Recent subscription activity</b>
        ${activeGrants.slice(0, 8).map((n) => `<div class="o-d-act"><b>${esc(n.title ?? 'Subscription')}</b><time>${esc(new Date(n.at ?? 0).toLocaleString())}</time></div>`).join('') || '<p class="o-empty">No recorded grants.</p>'}
      </div>`,
    sessions: `
      <h3>Sessions</h3>
      <div class="o-d-meta">${detail.sessions.length} device session${detail.sessions.length === 1 ? '' : 's'}</div>
      ${detail.sessions.length
        ? `<table class="o-table"><thead><tr><th>Provider</th><th>Logged in</th><th>Expires</th></tr></thead><tbody>${detail.sessions.slice(0, 50).map((s) => `<tr><td>${esc(s.provider)}</td><td>${esc(formatDate(s.createdAt))}</td><td>${esc(formatDate(s.expiresAt))}</td></tr>`).join('')}</tbody></table>`
        : '<p class="o-empty">No active server sessions.</p>'}`,
    notifications: `
      <h3>Notifications</h3>
      <div id="userNotifList">${notifs.slice(0, 50).map((n) => `
        <div class="o-d-act"><b>${esc(n.title ?? 'Activity')}</b><div class="o-sub">${esc(n.body ?? '')}</div><time>${n.at ? esc(new Date(n.at).toLocaleString()) : ''}</time></div>`).join('') || '<p class="o-empty">No notifications.</p>'}</div>`,
    actions: `
      <h3>Actions</h3>
      <div class="o-actions">
        <button type="button" class="o-btn primary" data-do="grant30">+30d Operator</button>
        <button type="button" class="o-btn primary" data-do="grant365">+365d Desk</button>
        <button type="button" class="o-btn ghost" data-do="edit">Edit plan</button>
        <button type="button" class="o-btn ghost" data-do="revoke">Set free</button>
        <button type="button" class="o-btn danger" data-do="delete">Delete user</button>
      </div>`,
  };
  body.innerHTML = sections[ctx.tab] ?? sections.overview;
  body.querySelectorAll<HTMLButtonElement>('[data-do]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.do ?? '';
      if (action === 'grant30') void grant(username, 30, { tier: 'operator' });
      if (action === 'grant365') void grant(username, 365, { tier: 'desk' });
      if (action === 'edit') void editPlanForUser(username);
      if (action === 'revoke') void revoke(username);
      if (action === 'delete') void deleteUser(username);
    });
  });
}

function attachUserDetailControls(username: string, panel: HTMLElement): void {
  panel.querySelectorAll<HTMLButtonElement>('[data-delete-user]').forEach((btn) => {
    btn.addEventListener('click', () => void deleteUser(username));
  });
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
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
      (r) => `<div class="o-request">
        <div class="o-request-head"><b>@${esc(r.username)}</b><span>${esc(r.planName)} · ${esc(r.price)} · ${esc(formatDate(r.at))}</span></div>
        <div class="o-request-actions">
          <button type="button" class="o-btn small" data-request-action="approve">Approve</button>
          <button type="button" class="o-btn small ghost" data-request-action="deny">Dismiss</button>
        </div>
      </div>`,
    )
    .join('');
  host.querySelectorAll<HTMLButtonElement>('[data-request-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const user = btn.dataset.requestUser ?? '';
      const plan = btn.dataset.requestPlan ?? 'desk';
      if (!user) return;
      if (btn.dataset.requestAction === 'approve') {
        void grant(user, plan === 'operator' ? 30 : 365, { tier: plan === 'operator' ? 'operator' : 'desk' });
      } else {
        const list = readRequests().map((r) => (r.username === user ? { ...r, status: 'dismissed' } : r));
        writeRequests(list);
        void renderRequests();
      }
    });
  });
  host.querySelectorAll<HTMLButtonElement>('[data-request-action="approve"]').forEach((btn) => {
    btn.dataset.requestUser = btn.closest('.o-request')?.querySelector('b')?.textContent?.replace(/^@/, '') ?? '';
    btn.dataset.requestPlan = 'desk';
  });
  updateRequestBadge(requests.length);
}

function updateRequestBadge(count: number): void {
  const badge = $('oReqCount');
  if (badge) badge.textContent = String(count);
}

/* ------------------------------------------------------------------ */
/* Bridge snapshot + audit                                             */
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
    host.innerHTML = '<div class="o-empty">No bridge paired. Pair once from the Execution page.</div>';
    return;
  }
  host.innerHTML = '<div class="o-empty">Reading bridge status…</div>';
  try {
    const res = await fetch(`${pairing.url}/api/status`, { headers: { 'x-bridge-token': pairing.token }, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = (await res.json()) as BridgeStatus;
    const acc = s.account;
    const ccy = acc?.currency ?? 'USD';
    host.innerHTML = `<table class="o-table">
      <tbody>
        <tr><td>Mode</td><td><b>${esc(s.mode ?? '—')}</b></td></tr>
        <tr><td>Connected</td><td><b class="${s.connected ? 'o-ok' : 'o-bad'}">${s.connected ? 'terminal linked' : 'offline'}</b></td></tr>
        <tr><td>Trading enabled</td><td><b>${s.tradingEnabled ? 'yes' : 'no'}</b></td></tr>
        <tr><td>Version</td><td><b>${esc(s.version ?? '—')}</b></td></tr>
        <tr><td>Login / server</td><td><b>${esc(acc?.login ?? '—')} · ${esc(acc?.server ?? '—')}</b></td></tr>
        <tr><td>Account type</td><td><b>${acc?.demo === true ? 'demo' : acc?.demo === false ? 'live' : '—'}</b></td></tr>
        <tr><td>Balance</td><td><b>${money(acc?.balance, ccy)}</b></td></tr>
        <tr><td>Equity</td><td><b>${money(acc?.equity, ccy)}</b></td></tr>
        <tr><td>Leverage</td><td><b>1:${esc(acc?.leverage ?? '—')}</b></td></tr>
        <tr><td>Open positions</td><td><b>${esc(s.positions?.open ?? '—')}</b></td></tr>
        <tr><td>Kill switch</td><td><b class="${s.safety?.killSwitch ? 'o-bad' : 'o-ok'}">${s.safety?.killSwitch ? 'engaged' : 'off'}</b></td></tr>
        <tr><td>Cloud sync</td><td><b class="${s.cloud?.error ? 'o-bad' : 'o-ok'}">${s.cloud?.error ? 'error' : s.cloud?.configured ? 'configured' : 'off'}</b></td></tr>
      </tbody>
    </table>`;
  } catch (e) {
    host.innerHTML = `<div class="o-empty">Bridge is offline (${esc((e as Error).message)}). Check the execution page and pair again.</div>`;
  }
}

function money(v: number | undefined, ccy = 'USD'): string {
  return typeof v === 'number' ? `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${ccy}` : '—';
}

async function renderAudit(): Promise<void> {
  const host = $('ownerAudit');
  if (!host) return;
  const pairing = readPairing();
  if (!pairing) {
    host.innerHTML = '<div class="o-empty">No bridge paired. Connect it from the Execution page for a live audit trail.</div>';
    return;
  }
  host.innerHTML = '<div class="o-empty">Reading bridge audit…</div>';
  try {
    const res = await fetch(`${pairing.url}/api/audit?limit=200`, {
      headers: { 'x-bridge-token': pairing.token },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entries = (await res.json()) as { entries?: AuditEntry[] };
    const rows = entries.entries ?? [];
    if (!rows.length) {
      host.innerHTML = '<div class="o-empty">Bridge audit is empty.</div>';
      return;
    }
    host.innerHTML = `<table class="o-audit-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Detail</th><th>Status</th></tr></thead><tbody>${
      rows
        .map((e) => `<tr>
          <td>${esc(formatDate(e.ts ? new Date(e.ts).getTime() : null))}</td>
          <td>${esc(e.actor)}</td>
          <td><b>${esc(e.action)}</b></td>
          <td><span>${esc(String(e.detail ?? '').slice(0, 260))}</span></td>
          <td><span class="o-tag ${e.ok === false || /failed|rejected/i.test(e.action) ? 'bad' : 'ok'}">${e.ok === false || /failed|rejected/i.test(e.action) ? 'rejected' : 'ok'}</span></td>
        </tr>`)
        .join('')
    }</tbody></table>`;
  } catch (e) {
    host.innerHTML = `<div class="o-empty">Audit unavailable (${esc((e as Error).message)}).</div>`;
  }
}

/* ------------------------------------------------------------------ */
/* Activity                                                            */
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
    } catch { /* skip */ }
  }
  rows.sort((a, b) => b.at - a.at);
  if (!rows.length) {
    host.innerHTML = '<p class="o-empty">No member activity recorded yet.</p>';
    return;
  }
  host.innerHTML = rows
    .slice(0, 30)
    .map(
      (r) => `<div class="o-act"><span class="o-tag">${esc(r.kind)}</span><b>@${esc(r.username)}</b> · ${esc(r.title)}<time>${esc(formatDate(r.at))}</time></div>`,
    )
    .join('');
}

/* ------------------------------------------------------------------ */
/* Feature & strategy managers                                         */
/* ------------------------------------------------------------------ */

interface OwnerCapability {
  key: string;
  label: string;
  section: string;
  tier: Tier;
  price: number;
  addedAt: number;
}

interface OwnerStrategy {
  title: string;
  description: string;
  strategyId: string;
  visibleTiers: string[];
  addedAt: number;
}

const OWNER_TIERS: Tier[] = ['free', 'operator', 'desk'];
const OWNER_SECTIONS = ['Terminal', 'Execution', 'Playbook', 'Other'];

function ownerSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function fieldValue(id: string): string {
  const el = $(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
  return el ? el.value.trim() : '';
}

async function ownerFetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function renderOwnerFeatures(list: OwnerCapability[]): void {
  const host = $('ownerFeaturesList');
  if (!host) return;
  const query = ($('oFeatureSearch') as HTMLInputElement | null)?.value.trim().toLowerCase() ?? '';
  const visible = list.filter((c) => !query || `${c.label} ${c.key} ${c.section}`.toLowerCase().includes(query));
  if (!visible.length) {
    host.innerHTML = '<p class="o-empty">No capabilities match the filter.</p>';
    return;
  }
  host.innerHTML = visible
    .map((c) => {
      const plan = getPlan(c.tier);
      const benefits = (plan.highlights ?? []).slice(0, 4).map((h) => `<li>${esc(h)}</li>`).join('');
      return `
        <div class="o-feature">
          <div class="o-feature-head">
            <b>${esc(c.label)}</b>
            <span class="o-tag ok">${esc(plan.name)} · $${esc(fmtMoney(c.price))}/mo</span>
          </div>
          <div class="o-sub">${esc(c.key)} · ${esc(c.section)} · added ${formatDate(c.addedAt)}</div>
          ${benefits ? `<ul class="o-feature-benefits">${benefits}</ul>` : ''}
          <div class="o-feature-actions">
            <span class="o-kebab"><button type="button" class="o-btn small">⋮</button><span class="o-kebab-menu">
              <button data-feature-action="edit" data-key="${esc(c.key)}">Edit</button>
              <button data-feature-action="delete" data-key="${esc(c.key)}">Delete</button>
            </span></span>
          </div>
        </div>`;
    })
    .join('');
  host.querySelectorAll<HTMLButtonElement>('[data-feature-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.featureAction ?? '';
      const key = btn.dataset.key ?? '';
      if (action === 'edit') editFeaturePrompt(key, list.find((c) => c.key === key));
      if (action === 'delete') void deleteFeature(key, list.find((c) => c.key === key));
    });
  });
}

function editFeaturePrompt(key: string, current?: OwnerCapability): void {
  if (!current) {
    toast('Feature not found.');
    return;
  }
  const label = prompt('New capability name:', current.label) ?? '';
  if (!label.trim()) return;
  const section = prompt(`Section (${OWNER_SECTIONS.join('/')}):`, current.section) ?? '';
  const tier = prompt(`Tier (${OWNER_TIERS.join('/')}):`, current.tier) ?? '';
  const price = Number(prompt('Price per month (USD):', String(current.price)));
  if (!label.trim() || !tiwas(tier) || !OWNER_SECTIONS.includes(section) || Number.isNaN(price)) {
    toast('Please enter a valid capability name, tier, section and price.');
    return;
  }
  void ownerFetchJson('/api/owner/features', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      feature: { key: ownerSlug(label), label: label.trim(), section: OWNER_SECTIONS.includes(section) ? section : 'Other', tier, price },
    }),
  }).then(() => {
    toast('Capability updated.');
    void loadOwnerFeatures();
  });
}

function tiwas(t: string): boolean {
  return OWNER_TIERS.includes(t as Tier);
}

async function deleteFeature(key: string, current?: OwnerCapability): Promise<void> {
  const name = current?.label ?? key;
  if (!confirm(`Delete capability "${name}"? Members using it are still in play.`)) return;
  const ok = await ownerFetchJson<{ ok?: boolean; features?: OwnerCapability[] }>('/api/owner/features', {
    method: 'DELETE',
    headers: { accept: 'application/json' },
    body: JSON.stringify({ key }),
  });
  toast(ok?.ok ? `Deleted ${name}.` : 'Could not delete capability.');
  if (ok?.ok) void loadOwnerFeatures();
}

function renderOwnerStrategies(list: OwnerStrategy[]): void {
  const host = $('ownerStrategiesList');
  if (!host) return;
  const query = ($('oStrategySearch') as HTMLInputElement | null)?.value.trim().toLowerCase() ?? '';
  const visible = list.filter((s) => !query || `${s.title} ${s.strategyId}`.toLowerCase().includes(query));
  if (!visible.length) {
    host.innerHTML = '<p class="o-empty">No strategies match the filter.</p>';
    return;
  }
  host.innerHTML = visible
    .map((s) => {
      const visibleLabel = s.visibleTiers.length ? `Visible to ${s.visibleTiers.join('/')}` : 'Visible to everyone';
      return `<div class="o-strategy">
        <div class="o-strategy-meta"><b>${esc(s.title)}</b><span>${esc(s.strategyId)}</span><span>${esc(visibleLabel)} · added ${formatDate(s.addedAt)}</span></div>
        ${s.description ? `<div class="o-sub">${esc(s.description)}</div>` : ''}
        <div class="o-strategy-actions">
          <span class="o-kebab"><button type="button" class="o-btn small">⋮</button><span class="o-kebab-menu">
            <button data-strategy-action="edit" data-title="${esc(s.title)}">Edit</button>
            <button data-strategy-action="delete" data-title="${esc(s.title)}">Delete</button>
          </span></span>
        </div>
      </div>`;
    })
    .join('');
  host.querySelectorAll<HTMLButtonElement>('[data-strategy-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.strategyAction ?? '';
      const title = btn.dataset.title ?? '';
      const current = list.find((s) => s.title === title);
      if (action === 'edit') editStrategyPrompt(current);
      if (action === 'delete') void deleteStrategy(title);
    });
  });
}

async function deleteStrategy(title: string): Promise<void> {
  if (!confirm(`Delete strategy "${title}"?`)) return;
  const ok = await ownerFetchJson<{ ok?: boolean; strategies?: OwnerStrategy[] }>('/api/owner/strategies', {
    method: 'DELETE',
    headers: { accept: 'application/json' },
    body: JSON.stringify({ title }),
  });
  toast(ok?.ok ? `Deleted "${title}".` : 'Could not delete strategy.');
  if (ok?.ok) void loadOwnerStrategies();
}

function editStrategyPrompt(current?: OwnerStrategy): void {
  if (!current) return;
  const title = prompt('New title:', current.title) ?? '';
  if (!title.trim()) return;
  const visible = window.confirm('Visible to everyone?')
    ? []
    : ['free', 'operator', 'desk'].filter((t) => window.confirm(`Show to ${t}?`));
  void ownerFetchJson('/api/owner/strategies', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ strategy: { title: title.trim(), description: current.description, strategyId: current.strategyId, visibleTiers: visible } }),
  }).then(() => {
    toast(`Strategy "${title.trim()}" updated.`);
    void loadOwnerStrategies();
  });
}

async function loadOwnerFeatures(): Promise<void> {
  const payload = await ownerFetchJson<{ ok?: boolean; features?: OwnerCapability[] }>('/api/owner/features', {
    headers: { accept: 'application/json' },
  });
  renderOwnerFeatures(payload?.features ?? []);
}

async function loadOwnerStrategies(): Promise<void> {
  const payload = await ownerFetchJson<{ ok?: boolean; strategies?: OwnerStrategy[] }>('/api/owner/strategies', {
    headers: { accept: 'application/json' },
  });
  renderOwnerStrategies(payload?.strategies ?? []);
}

async function addCapability(): Promise<void> {
  const form = $<HTMLFormElement>('addCapabilityForm');
  if (!form) return;
  const name = fieldValue('capName');
  const key = ownerSlug(name);
  if (!key) {
    toast('Give the capability a name first.');
    return;
  }
  const payload = {
    feature: {
      key,
      label: name,
      section: fieldValue('capSection') || 'Other',
      tier: ($('capTier') as HTMLSelectElement).value,
      price: Number(fieldValue('capPrice')) || 0,
    },
  };
  const ok = await ownerFetchJson<{ ok?: boolean }>('/api/owner/features', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!ok?.ok) {
    toast('Capability could not be saved.');
    return;
  }
  toast('Capability added — members will see it after reload');
  form.reset();
  void loadOwnerFeatures();
}

async function addStrategy(): Promise<void> {
  const form = $<HTMLFormElement>('addStrategyForm');
  if (!form) return;
  const title = fieldValue('stratTitle');
  if (!title) {
    toast('Give the strategy a title first.');
    return;
  }
  const visibleTiers: string[] = [];
  form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box) => {
    if (box.checked) visibleTiers.push(box.value);
  });
  const payload = {
    strategy: {
      title,
      description: fieldValue('stratDesc'),
      strategyId: fieldValue('stratId'),
      visibleTiers,
    },
  };
  const ok = await ownerFetchJson<{ ok?: boolean }>('/api/owner/strategies', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!ok?.ok) {
    toast('Strategy could not be saved.');
    return;
  }
  toast('Strategy added — members see it from their dashboards.');
  form.reset();
  void loadOwnerStrategies();
}

function attachOwnerManagerForms(): void {
  $('addCapabilityForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    void addCapability();
  });
  $('addStrategyForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    void addStrategy();
  });
  $('oFeatureSearch')?.addEventListener('input', () => void loadOwnerFeatures());
  $('oStrategySearch')?.addEventListener('input', () => void loadOwnerStrategies());
}

function attachNavAndSearch(): void {
  const nav = $('oNav');
  if (nav) {
    nav.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-nav]');
      if (!target) return;
      nav.querySelectorAll<HTMLElement>('[data-nav]').forEach((b) => b.classList.toggle('is-active', b === target));
      const id = target.dataset.nav;
      if (id === 'members') $('oMembers')?.scrollIntoView({ behavior: 'smooth' });
      if (id === 'requests') $('oRequests')?.scrollIntoView({ behavior: 'smooth' });
      if (id === 'bridge') $('oBridge')?.scrollIntoView({ behavior: 'smooth' });
      if (id === 'activity') $('oActivity')?.scrollIntoView({ behavior: 'smooth' });
      if (id === 'audit') $('oAudit')?.scrollIntoView({ behavior: 'smooth' });
      if (id === 'features') $('oFeatures')?.scrollIntoView({ behavior: 'smooth' });
      if (id === 'strategies') $('oStrategies')?.scrollIntoView({ behavior: 'smooth' });
    });
  }
  const search = $<HTMLInputElement>('oSearch');
  search?.addEventListener('input', () => renderMembers());
  const sort = $<HTMLSelectElement>('oSort');
  sort?.addEventListener('change', () => {
    sortMode = sort.value as SortMode;
    renderMembers();
  });
}

/* ------------------------------------------------------------------ */
/* Mount                                                               */
/* ------------------------------------------------------------------ */

function mountConsole(): void {
  renderMembers();
  void renderRequests();
  renderActivity();
  void renderBridge();
  void renderAudit();
  void loadOwnerFeatures();
  void loadOwnerStrategies();
  attachOwnerManagerForms();
  attachNavAndSearch();
  const refresh = $('oRefresh');
  refresh?.addEventListener('click', () => {
    serverMembers = null;
    membersFetchAttempted = false;
    renderMembers();
    void renderRequests();
    renderActivity();
    void renderBridge();
    void renderAudit();
    void loadOwnerFeatures();
    void loadOwnerStrategies();
    toast('Console refreshed.');
  });
  const lock = $('oLock');
  lock?.addEventListener('click', () => {
    sessionStorage.removeItem(UNLOCK_KEY);
    location.reload();
  });
  const close = $('oUserDetailClose');
  close?.addEventListener('click', () => $('oUserDetail')?.classList.add('hidden'));
  void renderMrrChart();
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
      $('ownerGateError')!.textContent = 'Access key rejected.';
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

export function mountOwner(): void {
  if (!document.getElementById('ownerPage')) return;
  unlock();
}
