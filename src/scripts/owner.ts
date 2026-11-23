/**
 * Owner console — /owner, fully server-backed.
 *
 * The visible Owner menu is the Owner management surface: the complete
 * member directory (server `/api/owner/members` first, local mirror last),
 * the full per-user activity pane, subscription requests, the paired bridge
 * snapshot, the audit log, and the owner feature/strategy catalogs.
 */
import {
  getPlan,
  getSubscription,
  getUsers,
  setSubscription,
  type Tier,
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

interface AuditEntry {
  id?: number;
  ts: string;
  actor: string;
  action: string;
  ok?: boolean;
  detail?: string;
}

const TIERS: Tier[] = ['free', 'operator', 'desk'];
const MRR_MULT: Record<string, number> = { free: 0, operator: 49, desk: 199 };
const now = Date.now;
const DAY_MS = 86400_000;

type SortMode = 'newest' | 'name' | 'paid' | 'active';
type TierFilter = 'all' | Tier;

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

function formatDate(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

function relativeTime(ms: number | null): string {
  if (!ms) return '—';
  const diff = ms - Date.now();
  if (diff <= 0) return 'just now';
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'a minute ago';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} months ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function readLocalUsers(): Array<{ username: string; email: string; name: string; providers: string[] }> {
  const users = getUsers();
  return users
    .filter((u) => Boolean(u.username))
    .map((u) => ({
      username: u.username ?? '',
      email: u.email ?? '',
      name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || (u.username ?? ''),
      providers: [u.provider].filter(Boolean) as string[],
    }));
}

/* ------------------------------------------------------------------ */
/* Member data                                                         */
/* ------------------------------------------------------------------ */

let serverMembers: OwnerMember[] | null = null;
let membersFetchAttempted = false;

function memberRows(): MemberRow[] {
  const rows: MemberRow[] = [];
  const seen = new Set<string>();

  const fromServer = (m: OwnerMember): MemberRow => {
    const username = (m.username || m.email || '').trim();
    if (!username) return { ...m, username: '', planMrr: 0, paid: false, daysLeft: null, operatorPaid: false, deskPaid: false };
    if (seen.has(username)) return { ...m, username: '', planMrr: 0, paid: false, daysLeft: null, operatorPaid: false, deskPaid: false };
    seen.add(username);
    const tier = TIERS.includes(m.subscription?.tier) ? m.subscription.tier : 'free';
    const paid = tier !== 'free' && m.subscription?.status !== 'canceled' && Boolean(m.subscription?.expiresAt);
    const daysLeft = paid && m.subscription.expiresAt ? Math.max(0, Math.ceil((m.subscription.expiresAt - Date.now()) / DAY_MS)) : null;
    return {
      ...m,
      username,
      planMrr: MRR_MULT[tier] * (daysLeft ?? 0) / 30,
      paid,
      daysLeft,
      operatorPaid: tier === 'operator' && paid,
      deskPaid: tier === 'desk' && paid,
    };
  };

  serverMembers?.forEach((m) => rows.push(fromServer(m)));
  readLocalUsers().forEach((u) => {
    if (seen.has(u.username)) return;
    seen.add(u.username);
    const sub = getSubscription(u.username);
    const paid = sub.tier !== 'free' && sub.status !== 'canceled' && Boolean(sub.expiresAt);
    const daysLeft = paid && sub.expiresAt ? Math.max(0, Math.ceil((sub.expiresAt - Date.now()) / DAY_MS)) : null;
    const m: OwnerMember = {
      id: `local:${u.username.toLowerCase()}`,
      email: u.email || '',
      username: u.username,
      name: u.name,
      firstName: u.name.split(' ')[0] ?? u.name,
      lastName: u.name.split(' ').slice(1).join(' '),
      providers: u.providers,
      createdAt: 0,
      lastActiveAt: lastActivity(u.username) ?? undefined,
      subscription: sub,
    };
    rows.push({
      ...m,
      planMrr: MRR_MULT[sub.tier] * (daysLeft ?? 0) / 30,
      paid,
      daysLeft,
      operatorPaid: sub.tier === 'operator' && paid,
      deskPaid: sub.tier === 'desk' && paid,
    });
  });
  return rows;
}

function sortRows(rows: MemberRow[], mode: SortMode): MemberRow[] {
  const out = [...rows];
  if (mode === 'name') out.sort((a, b) => a.username.localeCompare(b.username) || a.name.localeCompare(b.name));
  if (mode === 'newest') out.sort((a, b) => b.createdAt - a.createdAt || (a.lastActiveAt ?? 0) - (b.lastActiveAt ?? 0));
  if (mode === 'paid') out.sort((a, b) => Number(b.paid) - Number(a.paid) || (b.daysLeft ?? 0) - (a.daysLeft ?? 0) || b.createdAt - a.createdAt);
  if (mode === 'active') out.sort((b, a) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || b.createdAt - a.createdAt);
  return out;
}

function filteredRows(rows: MemberRow[], tier: TierFilter, query: string): MemberRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (tier !== 'all' && row.subscription.tier !== tier) return false;
    if (q) {
      return (
        row.username.toLowerCase().includes(q) ||
        row.name.toLowerCase().includes(q) ||
        row.email.toLowerCase().includes(q) ||
        row.email.split('@')[0]?.toLowerCase().includes(q) ||
        row.id.toLowerCase().includes(q)
      );
    }
    return true;
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

function setSubscriptionLocal(username: string, tier: Tier, days: number | null, status: 'active' | 'canceled' = 'active') {
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
  }
  toast(synced ? `${username}: plan set to free.` : `${username}: cleared locally only.`);
}

async function deleteUser(username: string): Promise<void> {
  const row = memberRows().find((r) => r.username === username);
  if (!row && !memberRows().some((r) => r.username.toLowerCase() === username.toLowerCase())) return;
  if (!confirm(`Delete @${username} and all of their data?`)) return;
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
/* Server member loading & KPI                                         */
/* ------------------------------------------------------------------ */

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
  renderMrrChart();
}

async function renderMrrChart(): Promise<void> {
  const host = $('oMrrChartCanvas');
  if (!host || !serverMembers?.length) return;
  const months: Array<{ key: string; operatorPaid: number; deskPaid: number }> = [];
  const monthIndex = new Map<string, { operator: number; desk: number }>();
  const firstMonth = new Date();
  firstMonth.setMonth(firstMonth.getMonth() - 6);
  for (const m of serverMembers) {
    if (m.subscription?.tier === 'operator') {
      const key = m.subscription.startedAt ? new Date(m.subscription.startedAt).toISOString().slice(0, 7) : '';
      if (key) {
        const entry = monthIndex.get(key) ?? { operator: 0, desk: 0 };
        entry.operator += 1;
        monthIndex.set(key, entry);
      }
    }
  }
  const nowKey = new Date().toISOString().slice(0, 7);
  for (let i = 0; i < 8; i++) {
    const d = new Date();
    d.setMonth(d.getMonth() - 7 + i);
    const key = d.toISOString().slice(0, 7);
    const entry = monthIndex.get(key) ?? { operator: 0, desk: 0 };
    months.push({ key, operatorPaid: entry.operator, deskPaid: entry.desk });
  }
  const series = months.map((m) => ({
    key: m.key,
    mrr: m.operatorPaid * MRR_MULT.operator + m.deskPaid * MRR_MULT.desk,
    max: Math.max(MRR_MULT.operator * 12, 0),
  }));
  const max = Math.max(...series.map((s) => s.mrr), 1);
  const bars = series.map((s) => ({
    key: s.key,
    mrr: s.mrr,
    h: (s.mrr / max) * 100,
    current: s.key === nowKey,
  }));
  const current = series.find((s) => s.key === nowKey) ?? series.at(-1)!;
  const totalM = MRR_MULT.operator * months[0]!.operatorPaid + MRR_MULT.desk * months[0]!.deskPaid;

  const ctx = host.getContext('2d');
  if (!ctx) return;
  const w = host.clientWidth || 720;
  const h = host.clientHeight || 280;
  const dpr = window.devicePixelRatio || 1;
  host.width = w * dpr;
  host.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const left = 18;
  const right = 12;
  const top = 12;
  const bottom = 42;
  const plotW = w - left - right;
  const plotH = h - top - bottom;

  ctx.fillStyle = 'rgba(7,4,6,0.55)';
  ctx.fillRect(0, 0, w, h);
  ctx.font = '10px var(--mono)';
  for (const k of [0, 25, 50, 75, 100]) {
    const y = top + plotH * (1 - k / 100);
    ctx.strokeStyle = 'rgba(226,69,108,0.2)';
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(w - right, y);
    ctx.stroke();
    const val = Math.round(max * k / 100);
    ctx.fillStyle = 'rgba(150,147,159,0.85)';
    ctx.textAlign = 'right';
    ctx.fillText(`$${val}`, left - 6, y + 3);
  }
  const slot = plotW / Math.max(bars.length, 1);
  for (const b of bars) {
    const x = left + (bars.indexOf(b) + 0.5) * slot - slot * 0.45;
    const barW = Math.max(slot * 0.42, 4);
    const height = Math.max(b.h, 0.5);
    const y = top + plotH * (1 - height / 100);
    const grad = ctx.createLinearGradient(0, top, 0, h);
    grad.addColorStop(0, 'rgba(226,69,108,0.98)');
    grad.addColorStop(1, 'rgba(146,40,56,0.9)');
    ctx.fillStyle = b.current ? 'rgba(251,199,204,1)' : grad;
    ctx.fillRect(x, y, barW, plotH * height / 100 || 0.5);
    ctx.fillStyle = 'rgba(150,147,159,0.8)';
    ctx.font = '9px var(--mono)';
    ctx.textAlign = 'center';
    ctx.fillText(b.key.slice(5), x + barW / 2, h - 24);
  }
  ctx.fillStyle = '#f5f0f2';
  ctx.textAlign = 'center';
  ctx.font = '12px var(--sans)';
  ctx.fillText(`Estimated monthly MRR this month — $${Math.round(current.mrr)} · growth +${Math.round(totalM)}\$/month`, w / 2, h - 3);
  const title = $('oMrrRatioSub');
  if (title) title.textContent = `Operator/Desk paid trends with a ~${Math.round(current.mrr / (MRR_MULT.operator + MRR_MULT.desk) * 30)} paid 30-day slot`;
}

/* ------------------------------------------------------------------ */
/* KPI                                                                 */
/* ------------------------------------------------------------------ */

function updateKpi(): void {
  const rows = memberRows();
  const paidCount = rows.filter((r) => r.paid).length;
  const operatorPaid = rows.filter((r) => r.operatorPaid).length;
  const deskPaid = rows.filter((r) => r.deskPaid).length;
  const totalMrr = operatorPaid * MRR_MULT.operator + deskPaid * MRR_MULT.desk;
  const sessions = new Map<string, OwnerSession[]>();

  for (const [key, id] of ['oMembersTotal', 'oMembersPaid', 'oMembersFree', 'oMembersMrr', 'oSessionsTotal', 'oMrrRatio'] as const) {
    $(key)?.classList.remove('ok', 'warm');
  }
  if ($('oMembersTotal')) $('oMembersTotal').textContent = String(rows.length);
  if ($('oMembersTotalSub')) $('oMembersTotalSub').textContent = `Member accounts`;
  if ($('oMembersPaid')) $('oMembersPaid').textContent = String(paidCount);
  if ($('oMembersPaid')) $('oMembersPaid').parentElement?.classList.toggle('ok', paidCount > 0);
  if ($('oMembersPaidSub')) $('oMembersPaidSub').textContent = 'Operator+Desk subscriptions';
  if ($('oMembersFree')) $('oMembersFree').textContent = String(rows.length - paidCount);
  if ($('oMembersFree')) $('oMembersFree').parentElement?.classList.toggle('warm', paidCount === 0);
  if ($('oMembersMrr')) $('oMembersMrr').textContent = fmtMoney(totalMrr);
  if ($('oMembersMrr')) $('oMembersMrr').parentElement?.classList.toggle('warm', totalMrr > 0);
  if ($('oMembersMrrSub')) $('oMembersMrrSub').textContent = 'Estimated from Operator/Desk plans';
  if ($('oSessionsTotal')) $('oSessionsTotal').textContent = String(sessions.size);
  if ($('oSessionsSub')) $('oSessionsSub').textContent = 'Awaiting bridge snapshot';
  if ($('oMrrRatio')) $('oMrrRatio').textContent = `${operatorPaid}/${deskPaid}`;
  if ($('oMrrRatioSub')) $('oMrrRatioSub').textContent = 'paid operator/desk counts';
}

/* ------------------------------------------------------------------ */
/* Members table & tier tabs                                           */
/* ------------------------------------------------------------------ */

let sortMode: SortMode = 'newest';
let tierFilter: TierFilter = 'all';

function updateMemberStats(rows: MemberRow[]): void {
  const paid = rows.filter((r) => r.paid).length;
  const total = rows.length;
  if ($('oMembersTotal')) $('oMembersTotal').textContent = String(total);
  if ($('oMembersTotalSub')) $('oMembersTotalSub').textContent = `All tiers (${total})`;
  if ($('oMembersPaid')) $('oMembersPaid').textContent = String(paid);
  if ($('oMembersPaidSub')) $('oMembersPaidSub').textContent = 'Operator+Desk';
  if ($('oMembersFree')) $('oMembersFree').textContent = String(total - paid);
  if ($('oMembersFreeSub')) $('oMembersFreeSub').textContent = 'Plan-free';
  const operatorPaid = rows.filter((r) => r.operatorPaid).length;
  const deskPaid = rows.filter((r) => r.deskPaid).length;
  const mrr = operatorPaid * MRR_MULT.operator + deskPaid * MRR_MULT.desk;
  if ($('oMembersMrr')) $('oMembersMrr').textContent = fmtMoney(mrr);
  if ($('oMembersMrr')) $('oMembersMrr').parentElement?.classList.toggle('warm', mrr > 0);
  if ($('oMembersMrrSub')) $('oMembersMrrSub').textContent = `Estimated: $49/${MRR_MULT.operator} + $199/${MRR_MULT.desk}`;
  const active = rows.filter((r) => r.lastActiveAt && r.lastActiveAt > Date.now() - 86400_000).length;
  if ($('oSessionsTotal')) $('oSessionsTotal').textContent = String(active);
  if ($('oSessionsSub')) $('oSessionsSub').textContent = `Active in last 24h (${active} of ${rows.length})`;
  if ($('oMrrRatio')) $('oMrrRatio').textContent = `${Math.round(mrr / 30)}/30d`;
  if ($('oMrrRatioSub')) $('oMrrRatioSub').textContent = 'Monthly implied MRR';
}

function renderMemberMeta(rows: MemberRow[]): void {
  const meta = $('oMembersMeta');
  const paid = rows.filter((r) => r.paid).length;
  meta?.replaceChildren(
    `Members: ${rows.length}`,
    `Paid: ${paid}`,
    `Unpaid: ${rows.length - paid}`,
  ).toString();
  if (meta) {
    meta.innerHTML = `Members: <b>${rows.length}</b> · Paid: <b>${paid}</b> · Free: <b>${rows.length - paid}</b>`;
  }
}

function renderTierTabs(): void {
  const host = $('oTierTabs');
  if (!host) return;
  host.innerHTML = [
    { id: 'all', label: 'All' },
    ...TIERS.map((t) => ({ id: t, label: t === 'free' ? 'Free' : t === 'operator' ? 'Operator' : 'Desk' })),
  ]
    .map((t) => `<button type="button" class="${tierFilter === t.id ? 'is-active' : ''}" data-tier="${esc(t.id)}">${esc(t.label)}</button>`)
    .join('');
  host.querySelectorAll<HTMLElement>('[data-tier]').forEach((btn) => {
    btn.addEventListener('click', () => {
      tierFilter = btn.dataset.tier === 'all' ? 'all' : (btn.dataset.tier as TierFilter);
      renderTierTabs();
      renderMembers();
    });
  });
}

function renderNav(): void {
  const host = $('oNav');
  if (!host) return;
  const sections = ['overview', 'members', 'requests', 'bridge', 'activity', 'audit', 'features', 'strategies'] as const;
  host.innerHTML = sections
    .map((id) => `<button type="button" class="o-nav-link" data-nav="${id}" ${id === 'members' ? 'disabled' : ''} aria-current="${id === 'members' ? 'page' : 'false'}">${id === 'overview' ? 'Overview' : id === 'members' ? 'Members' : id.charAt(0).toUpperCase() + id.slice(1)}</button>`)
    .join('');
  const membersLink = host.querySelector('[data-nav="members"]');
  membersLink?.classList.add('is-active', 'is-nav-main');
  host.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      for (const el of host.querySelectorAll<HTMLElement>('[data-nav]')) {
        el.classList.toggle('is-active', el.dataset.nav === btn.dataset.nav);
      }
      const id = btn.dataset.nav;
      if (id) {
        const target = $`${id}` ? (id === 'members' ? $('oMembers') : $(`o${id.charAt(0).toUpperCase()}${id.slice(1)}`)) : null;
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}

function renderMembers(): void {
  const body = $('ownerMembers');
  if (!body) return;
  const rows = filteredRows(sortRows(memberRows(), sortMode), tierFilter, $<HTMLInputElement>('oSearch')?.value ?? '');
  updateMemberStats(rows);
  renderMemberMeta(rows);
  renderTierTabs();

  if (!rows.length) {
    body.innerHTML = '<tr><td class="o-empty" colspan="8">No members visible yet. Accounts created on the login console or with you signed in here appear here.</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map((row) => {
      const paid = row.paid;
      const mrr = fmtMoney(row.planMrr);
      const daysLeft = row.daysLeft == null ? '—' : row.daysLeft === 0 ? '0d' : `${row.daysLeft}d`;
      return `<tr>
        <td><b class="o-user-link" data-detail="${esc(row.username)}">${esc(row.name || row.username)}</b><span class="o-sub"> @${esc(row.username)} · ${esc(row.email || 'no email')}</span></td>
        <td><span class="o-tag ${paid ? 'ok' : ''}">${paid ? esc(row.subscription.status) : 'free'}</span></td>
        <td>${esc(formatDate(row.createdAt))}</td>
        <td>${paid ? mrr : '—'}</td>
        <td>${daysLeft}</td>
        <td>${notifKeyCount(row.username)}</td>
        <td>${esc(relativeTime(lastActivity(row.username)))}</td>
        <td class="o-actions">
          <span class="o-kebab" data-kebab-id="${esc(row.username)}">
            <button type="button" class="o-btn small" aria-haspopup="menu" aria-label="Actions for ${esc(row.username)}">⋮</button>
            <span class="o-kebab-menu" role="menu">
              <button type="button" data-action="detail">View activity</button>
              <button type="button" data-action="grant30">Grant Operator (30d)</button>
              <button type="button" data-action="grant365">Grant Desk (365d)</button>
              <button type="button" data-action="revoke">Clear plan</button>
              <button type="button" data-action="edit">Edit plan</button>
              <button type="button" data-action="delete">Delete user</button>
            </span>
          </span>
        </td>
      </tr>`;
    })
    .join('');

  body.querySelectorAll<HTMLElement>('[data-detail]').forEach((el) => {
    el.addEventListener('click', () => void renderUserDetail(el.dataset.detail ?? ''));
  });
  body.querySelectorAll<HTMLElement>('[data-kebab]').forEach((kebab) => {
    const username = kebab.dataset.kebabId ?? '';
    kebab.addEventListener('click', () => {
      const open = kebab.classList.toggle('open');
      for (const other of body.querySelectorAll<HTMLElement>('[data-kebab].open')) {
        if (other !== kebab) other.classList.remove('open');
      }
      void open;
    });
    kebab.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action ?? '';
        if (username) {
          if (action === 'grant30') void grant(username, 30, { tier: 'operator' });
          if (action === 'grant365') void grant(username, 365, { tier: 'desk' });
          if (action === 'revoke') void revoke(username);
          if (action === 'edit') void editPlanPrompt(username);
          if (action === 'detail') void renderUserDetail(username);
          if (action === 'delete') void deleteUser(username);
        }
      });
    });
  });
  void loadServerMembers();
}

function editPlanPrompt(username: string): void {
  const row = memberRows().find((r) => r.username === username) ?? null;
  if (!row) return;
  toast(`Editing plan for ${username}. Use the granted plans or free.`);
  for (const tier of ['operator', 'desk'] as const) {
    const days = tier === 'desk' ? 180 : 30;
    const ok = confirm(`Grant ${tier === 'desk' ? 'Desk ($199/mo)' : 'Operator ($49/mo)'} to @${username} for ${days} days?`);
    if (ok) void grant(username, days, { tier });
  }
  if (confirm(`Clear the plan for @${username}?`)) void revoke(username);
}

/* ------------------------------------------------------------------ */
/* User detail panel                                                   */
/* ------------------------------------------------------------------ */

interface ServerDetail {
  serverMember: OwnerMember | null;
  sessions: OwnerSession[];
  requests: UpgradeRequest[];
  remoteRequests: UpgradeRequest[];
}

async function loadServerDetail(username: string): Promise<ServerDetail | null> {
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
    remoteRequests,
  };
}

function renderUserDetail(username: string): void {
  const panel = $('oUserDetail');
  const title = $('oUserDetailTitle');
  if (!panel || !title) return;
  panel.hidden = false;
  title.textContent = `@${username}`;
  $('oUserDetailBody').innerHTML = '<div class="o-empty">Loading…</div>';
  void renderUserDetailAsync(username, panel);
}

async function renderUserDetailAsync(username: string, panel: HTMLElement): Promise<void> {
  const detail = await loadServerDetail(username);
  const localUser = readLocalUsers().find((u) => u.username === username);
  const row = memberRows().find((r) => r.username === username) ?? null;
  const sub = detail.serverMember?.subscription ?? (row ? getSubscription(row.username) : null);
  const notifs = readOwnerNotifs(username).filter((n) => n.at).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  const meta = $('oUserDetailMeta');
  if (meta) {
    meta.innerHTML =
      `${esc(detail.serverMember?.email ?? localUser?.email ?? '—')} · ${esc(detail.serverMember?.providers?.join(', ') ?? localUser?.providers.join(', ') ?? 'unknown')}` +
      (detail.serverMember?.createdAt ? ` · since ${formatDate(detail.serverMember.createdAt)}` : '') +
      ` · plan ${esc(sub?.tier ?? 'free')} · ${sub?.expiresAt ? `${Math.max(0, Math.ceil((sub.expiresAt - Date.now()) / DAY_MS))}d left` : 'no expiry'}` +
      (row?.operatorPaid ? ' · $49/mo' : '') +
      (row?.deskPaid ? ' · $199/mo' : '');
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
    ].map((t) => `<button type="button" class="${t.id === 'overview' ? 'is-active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('');
    tabs.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        tabs.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.classList.toggle('is-active', b === btn));
        renderUserDetailBody(username, detail, { tab: btn.dataset.tab ?? 'overview', notifs });
      });
    });
  }

  renderUserDetailBody(username, detail, { tab: 'overview', notifs });
  attachUserDetailControls(username, panel);
}

interface DetailContext {
  tab: string;
  notifs: Array<{ id?: string; kind?: string; title?: string; body?: string; at?: number; read?: boolean }>;
}

function renderUserDetailBody(username: string, detail: ServerDetail, ctx: DetailContext): void {
  const body = $('oUserDetailBody');
  if (!body) return;
  const row = memberRows().find((r) => r.username === username) ?? null;
  const sub = detail.serverMember?.subscription ?? (row ? getSubscription(row.username) : null);
  const paid = row?.paid ?? Boolean(sub && sub.tier !== 'free' && sub.status !== 'canceled' && sub.expiresAt);
  const notifs = ctx.notifs.filter((n) => n.at).slice(0, 50);
  const overview = `
    <section class="o-d-sec">
      <div class="o-d-meta">${esc(username)} · @${esc(detail.serverMember?.username ?? username)} · ID ${esc(detail.serverMember?.id ?? 'local')} · ${esc(sub?.provider ?? 'unknown')} · since ${formatDate(detail.serverMember?.createdAt)} · premium since ${formatDate(sub?.startedAt)}</div>
      <div class="o-bridge-grid">
        <div class="o-b-card"><span>Plan</span><b>${esc(sub?.tier ?? 'free')}</b></div>
        <div class="o-b-card"><span>MRR