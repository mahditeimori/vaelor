/**
 * Server-backed session mirror.
 *
 * The real identity lives in a Cloudflare Pages Function behind an HttpOnly
 * cookie (`vaelor_session`). This module asks `/api/auth/me` who that cookie
 * belongs to and mirrors the answer into the legacy localStorage keys that the
 * membership/gate layer already reads, so no page had to be rewritten:
 *
 *   vaelor_active_session_v1   { user, remembered }
 *   vaelor_sub:<username>      subscription { tier, status, startedAt, expiresAt }
 *   vaelor_users_db_v1         member list (owner console reads this)
 *
 * Failure policy: only an explicit 401 clears the mirror. A network error,
 * a 404 while running `astro dev` without Functions, or a 5xx leaves the
 * mirror intact so an outage never signs a member out.
 */
import { SESSION_KEY, subKey, USERS_KEY, type MemberUser } from './membership';

export type Tier = 'free' | 'operator' | 'desk';
export type SubscriptionStatus = 'active' | 'trialing' | 'canceled';

export interface ServerUser extends MemberUser {
  name?: string;
  providers?: string[];
}

export interface ServerSubscription {
  tier: Tier;
  status: SubscriptionStatus;
  startedAt: number | null;
  expiresAt: number | null;
}

export interface MePayload {
  ok: true;
  user: ServerUser;
  subscription: ServerSubscription;
  isOwner: boolean;
}

export type SyncResult = 'ok' | 'signed-out' | 'unavailable';

const OWNER_KEY = 'vaelor.isOwner';

/** Ask the server who is signed in. Never throws. */
export async function fetchMe(): Promise<MePayload | null> {
  try {
    const response = await fetch('/api/auth/me', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as MePayload;
    return payload?.ok && payload.user ? payload : null;
  } catch {
    return null;
  }
}

/** Like fetchMe, but distinguishes "not signed in" from "cannot reach server". */
async function probe(): Promise<{ state: 'ok'; payload: MePayload } | { state: 'signed-out' } | { state: 'unavailable' }> {
  try {
    const response = await fetch('/api/auth/me', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (response.status === 401) return { state: 'signed-out' };
    if (!response.ok) return { state: 'unavailable' };
    const payload = (await response.json()) as MePayload;
    if (!payload?.ok || !payload.user) return { state: 'unavailable' };
    return { state: 'ok', payload };
  } catch {
    return { state: 'unavailable' };
  }
}

/**
 * Reconcile the local mirror with the server. Safe to call on every page.
 * Dispatches `vaelor:session` on `window` when the mirror changed so pages can
 * re-render their chrome.
 */
export async function syncSession(): Promise<SyncResult> {
  if (typeof window === 'undefined') return 'unavailable';
  const result = await probe();

  if (result.state === 'signed-out') {
    const had = window.localStorage.getItem(SESSION_KEY) !== null;
    window.localStorage.removeItem(SESSION_KEY);
    window.localStorage.removeItem(OWNER_KEY);
    if (had) notify();
    return 'signed-out';
  }

  if (result.state === 'unavailable') return 'unavailable';

  mirror(result.payload);
  notify();
  return 'ok';
}

function mirror(payload: MePayload): void {
  const { user, subscription, isOwner } = payload;
  const member: MemberUser = {
    username: user.username,
    firstName: user.firstName ?? user.name?.split(' ')[0] ?? '',
    lastName: user.lastName ?? user.name?.split(' ').slice(1).join(' ') ?? '',
    email: user.email,
    provider: user.provider ?? 'password',
  };

  window.localStorage.setItem(SESSION_KEY, JSON.stringify({ user: member, remembered: false }));
  window.localStorage.setItem(subKey(user.username), JSON.stringify(subscription));
  if (isOwner) window.localStorage.setItem(OWNER_KEY, '1');
  else window.localStorage.removeItem(OWNER_KEY);

  upsertMember(member);
}

/** Keep the owner console's member list aware of server-created accounts. */
function upsertMember(member: MemberUser): void {
  try {
    const raw = window.localStorage.getItem(USERS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const list: MemberUser[] = Array.isArray(parsed) ? (parsed as MemberUser[]) : [];
    const index = list.findIndex(
      (entry) =>
        entry.username?.toLowerCase() === member.username.toLowerCase() ||
        (entry.email && member.email && entry.email.toLowerCase() === member.email.toLowerCase()),
    );
    if (index >= 0) {
      list[index] = { ...list[index], ...member };
    } else {
      list.push(member);
    }
    window.localStorage.setItem(USERS_KEY, JSON.stringify(list));
  } catch {
    /* a corrupt registry must never break sign-in */
  }
}

function notify(): void {
  window.dispatchEvent(new CustomEvent('vaelor:session', { detail: { synced: true } }));
}

export function isOwner(): boolean {
  try {
    return window.localStorage.getItem(OWNER_KEY) === '1';
  } catch {
    return false;
  }
}

/** Revoke the server session, then clear every local trace of it. */
export async function signOut(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    /* clearing the cookie is a best effort; clear locally regardless */
  }
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { user?: { username?: string } };
      const username = parsed?.user?.username;
      if (username) window.localStorage.removeItem(subKey(username));
    }
  } catch {
    /* ignore */
  }
  window.localStorage.removeItem(SESSION_KEY);
  window.localStorage.removeItem(OWNER_KEY);
  notify();
}
