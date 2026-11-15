/**
 * Vaelor member — subscription / entitlement layer (client side).
 *
 * The operator login console (`public/login.html`) is a self-contained auth
 * flow: users live in `localStorage['vaelor_users_db_v1']`, the active session
 * in `localStorage['vaelor_active_session_v1']`, remembered credentials in
 * `localStorage['vaelor_remembered_user_v1']`.
 *
 * Every member that signs in gets a unique dashboard state. The subscription
 * record per user is kept in `localStorage['vaelor_sub:<username>']`.
 *
 * Feature entitlements:
 *   - free tier      → backtest (+ anything the operator marks free)
 *   - subscriber      → the paid toolkit (AI chat, live desk, indicator export,
 *                       OI/COT + CDTC charts, custom strategy upload, analytical
 *                       engine, terminal section 2 content, news custom analysis)
 *   - code/docs       → hidden from members entirely (operator surface)
 */

export type Tier = 'free' | 'subscriber';

export interface SubscriptionState {
  tier: Tier;
  status: 'active' | 'trialing' | 'canceled';
  startedAt: number | null;
  expiresAt: number | null;
}

export interface MemberNotification {
  id: string;
  kind: 'signal' | 'ai' | 'system' | 'subscription';
  title: string;
  body: string;
  at: number;
  read: boolean;
}

export const USERS_KEY = 'vaelor_users_db_v1';
export const SESSION_KEY = 'vaelor_active_session_v1';
export const REMEMBER_KEY = 'vaelor_remembered_user_v1';
export const subKey = (username: string) => `vaelor_sub:${username}`;

/* ------------------------------------------------------------------ */
/* User / session helpers (mirror of the login console storage keys)   */
/* ------------------------------------------------------------------ */

export interface MemberUser {
  username: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  password?: string;
  provider?: string;
}

export function getUsers(): MemberUser[] {
  try {
    const raw = window.localStorage.getItem(USERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as MemberUser[]) : [];
  } catch {
    return [];
  }
}

export function saveUsers(users: MemberUser[]): void {
  window.localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

export function getSessionUser(): MemberUser | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && parsed.user) {
      return parsed.user as MemberUser;
    }
  } catch {
    /* ignore malformed storage */
  }
  return null;
}

export function setSessionUser(user: MemberUser): void {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify({ user, remembered: false }));
}

export function getCurrentUser(): MemberUser | null {
  return getSessionUser();
}

/* ------------------------------------------------------------------ */
/* Subscription state (per user)                                       */
/* ------------------------------------------------------------------ */

export function getSubscription(username: string): SubscriptionState {
  const fallback: SubscriptionState = { tier: 'free', status: 'active', startedAt: null, expiresAt: null };
  try {
    const raw = window.localStorage.getItem(subKey(username));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      const sub = parsed as Partial<SubscriptionState>;
      const state: SubscriptionState = {
        tier: sub.tier === 'subscriber' ? 'subscriber' : 'free',
        status: sub.status === 'trialing' ? 'trialing' : sub.status === 'canceled' ? 'canceled' : 'active',
        startedAt: typeof sub.startedAt === 'number' ? sub.startedAt : null,
        expiresAt: typeof sub.expiresAt === 'number' ? sub.expiresAt : null,
      };
      return state;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

export function setSubscription(username: string, sub: SubscriptionState): void {
  window.localStorage.setItem(subKey(username), JSON.stringify(sub));
}

export function getTier(): Tier {
  const user = getCurrentUser();
  if (!user?.username) return 'free';
  const sub = getSubscription(user.username);
  if (sub.status === 'canceled') return 'free';
  return sub.tier;
}

export function getSubscriptionRemainingSeconds(): number | null {
  const user = getCurrentUser();
  if (!user?.username) return null;
  const sub = getSubscription(user.username);
  if (!sub.expiresAt) return null;
  const ms = sub.expiresAt - Date.now();
  if (ms <= 0) return 0;
  return Math.floor(ms / 1000);
}

/* ------------------------------------------------------------------ */
/* Entitlements                                                        */
/* ------------------------------------------------------------------ */

export type FeatureKey =
  | 'signals'
  | 'execution_usage'
  | 'pair'
  | 'live_trade'
  | 'indicator_download'
  | 'ai_chat'
  | 'oi_cot'
  | 'cdtc'
  | 'upload_strategy'
  | 'analytical_chart'
  | 'terminal_section2'
  | 'news_custom_ai'
  | 'backtest';

export type TierAccess = 'free' | 'subscriber';

export interface FeatureDef {
  key: FeatureKey;
  label: string;
  forTier: TierAccess;
  freeFallback: string;
}

export const FEATURES: Record<FeatureKey, FeatureDef> = {
  backtest: { key: 'backtest', label: 'Backtest', forTier: 'free', freeFallback: 'Backtest is included in the free tier.' },
  signals: { key: 'signals', label: 'Signals', forTier: 'subscriber', freeFallback: 'Signal streaming requires a subscription.' },
  execution_usage: { key: 'execution_usage', label: 'Execution usage', forTier: 'subscriber', freeFallback: 'Execution usage tracking requires a subscription.' },
  pair: { key: 'pair', label: 'Bridge pairing', forTier: 'subscriber', freeFallback: 'Bridge pairing requires a subscription.' },
  live_trade: { key: 'live_trade', label: 'Live trade desk', forTier: 'subscriber', freeFallback: 'Live trading requires a subscription.' },
  indicator_download: { key: 'indicator_download', label: 'MT5 indicator export', forTier: 'subscriber', freeFallback: 'Indicator export requires a subscription.' },
  ai_chat: { key: 'ai_chat', label: 'AI chat (MCP)', forTier: 'subscriber', freeFallback: 'AI chat requires a subscription.' },
  oi_cot: { key: 'oi_cot', label: 'OI / COT analytics', forTier: 'subscriber', freeFallback: 'OI/COT analytics require a subscription.' },
  cdtc: { key: 'cdtc', label: 'CDTC charts + analysis', forTier: 'subscriber', freeFallback: 'CDTC charts require a subscription.' },
  upload_strategy: { key: 'upload_strategy', label: 'Strategy upload', forTier: 'subscriber', freeFallback: 'Strategy upload requires a subscription.' },
  analytical_chart: { key: 'analytical_chart', label: 'Analytical engine', forTier: 'subscriber', freeFallback: 'The analytical engine requires a subscription.' },
  terminal_section2: { key: 'terminal_section2', label: 'Terminal analysis sections', forTier: 'subscriber', freeFallback: 'Terminal analysis sections require a subscription.' },
  news_custom_ai: { key: 'news_custom_ai', label: 'Custom news AI analysis', forTier: 'subscriber', freeFallback: 'Custom news AI analysis requires a subscription.' },
};

export function can(feature: FeatureKey): boolean {
  const user = getCurrentUser();
  if (!user?.username) return false;
  const def = FEATURES[feature];
  if (!def) return false;
  if (def.forTier === 'free') return true;
  const tier = getTier();
  if (tier !== 'subscriber') return false;
  const sub = getSubscription(user.username);
  return sub.status === 'active' || sub.status === 'trialing';
}

export function isMember(): boolean {
  const user = getCurrentUser();
  return Boolean(user?.username);
}

/* ------------------------------------------------------------------ */
/* Notifications (per user)                                            */
/* ------------------------------------------------------------------ */

export function getNotifications(): MemberNotification[] {
  const user = getCurrentUser();
  if (!user?.username) return [];
  try {
    const raw = window.localStorage.getItem(`vaelor_notif:${user.username}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as MemberNotification[]) : [];
  } catch {
    return [];
  }
}

export function pushNotification(n: Omit<MemberNotification, 'id' | 'at' | 'read'>): void {
  const user = getCurrentUser();
  if (!user?.username) return;
  const list = getNotifications();
  list.unshift({
    ...n,
    id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    read: false,
  });
  window.localStorage.setItem(`vaelor_notif:${user.username}`, JSON.stringify(list.slice(0, 50)));
}

export function markNotificationsRead(): void {
  const user = getCurrentUser();
  if (!user?.username) return;
  const list = getNotifications().map((n) => ({ ...n, read: true }));
  window.localStorage.setItem(`vaelor_notif:${user.username}`, JSON.stringify(list));
}

/* ------------------------------------------------------------------ */
/* Lock UI — shared overlay shown when a member hits a locked feature  */
/* ------------------------------------------------------------------ */

export function openFeatureLock(feature: FeatureKey): void {
  if (typeof document === 'undefined') return;
  const def = FEATURES[feature];
  if (!def) return;
  if (can(feature)) return;
  let host = document.getElementById('vaelorLockRoot');
  if (!host) {
    host = document.createElement('div');
    host.id = 'vaelorLockRoot';
    document.body.appendChild(host);
  }
  host.innerHTML = '';
  const overlay = document.createElement('div');
  overlay.id = 'vaelorFeatureLock';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.zIndex = '2147483000';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.padding = '24px';
  overlay.style.background = 'rgba(4,2,3,0.86)';
  overlay.style.backdropFilter = 'blur(6px)';

  const card = document.createElement('div');
  card.style.borderRadius = '16px';
  card.style.border = '1px solid rgba(226,69,108,0.35)';
  card.style.background = 'rgba(18,11,15,0.97)';
  card.style.padding = '28px';
  card.style.maxWidth = '460px';
  card.style.width = '100%';
  card.style.boxShadow = '0 30px 80px -20px rgba(0,0,0,0.8)';

  const kicker = document.createElement('div');
  kicker.style.fontFamily = '"JetBrains Mono",monospace';
  kicker.style.fontSize = '10px';
  kicker.style.letterSpacing = '0.2em';
  kicker.style.textTransform = 'uppercase';
  kicker.style.color = '#e11d48';
  kicker.textContent = 'VAELOR · MEMBERSHIP';

  const title = document.createElement('h3');
  title.style.fontFamily = '"Playfair Display",serif';
  title.style.fontSize = '24px';
  title.style.fontWeight = '700';
  title.style.color = '#fff';
  title.style.margin = '18px 0 8px';
  title.textContent = def.label;

  const body = document.createElement('p');
  body.style.fontSize = '13px';
  body.style.lineHeight = '1.7';
  body.style.color = '#a89aa0';
  body.style.margin = '0 0 20px';
  body.textContent = def.freeFallback;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'vaelorLockCta';
  btn.style.width = '100%';
  btn.style.padding = '13px';
  btn.style.borderRadius = '12px';
  btn.style.border = 'none';
  btn.style.background = 'linear-gradient(135deg,#e11d48,#be185d)';
  btn.style.color = '#fff';
  btn.style.fontSize = '13px';
  btn.style.fontWeight = '600';
  btn.style.cursor = 'pointer';
  btn.textContent = 'View subscription plans';

  card.appendChild(kicker);
  card.appendChild(title);
  card.appendChild(body);
  card.appendChild(btn);
  overlay.appendChild(card);
  host.appendChild(overlay);
}

/* ------------------------------------------------------------------ */
/* Global handle for inline scripts                                    */
/* ------------------------------------------------------------------ */

declare global {
  interface Window {
    VaelorMembership?: {
      getCurrentUser: () => MemberUser | null;
      getTier: () => Tier;
      can: (f: FeatureKey) => boolean;
      openFeatureLock: (f: FeatureKey) => void;
      getSubscriptionRemainingSeconds: () => number | null;
      getNotifications: () => MemberNotification[];
      pushNotification: (n: Omit<MemberNotification, 'id' | 'at' | 'read'>) => void;
      markNotificationsRead: () => void;
    };
  }
}

if (typeof window !== 'undefined') {
  window.VaelorMembership = {
    getCurrentUser,
    getTier,
    can,
    openFeatureLock,
    getSubscriptionRemainingSeconds,
    getNotifications,
    pushNotification,
    markNotificationsRead,
  };
}

export {};
