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
 * Plans (see PLANS for the catalogue the site renders):
 *   observer  (free)  backtest + docs + feature overview
 *   operator  ($49)   research workstation: signals, indicator export, OI/COT,
 *                     CDTC, analytical engine, news AI, AI chat
 *   desk      ($199)  operator + a dedicated cloud MT5 bridge, live desk
 *                     routing, audit trail and strategy upload
 *
 * `subscriber` is a legacy value written by older builds and is treated as
 * `desk` so existing members keep everything they paid for.
 */

export type Tier = 'free' | 'operator' | 'desk';

export const TIER_RANK: Record<Tier, number> = { free: 0, operator: 1, desk: 2 };

export type SubscriptionStatus = 'active' | 'trialing' | 'canceled' | 'expired';

export interface SubscriptionState {
  tier: Tier;
  status: SubscriptionStatus;
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
/* Plan catalogue                                                      */
/* ------------------------------------------------------------------ */

export interface PlanLimits {
  /** -1 means unlimited. */
  backtestsPerDay: number;
  aiMessagesPerDay: number;
  watchedSymbols: number;
  bridgeInstances: number;
}

export interface Plan {
  id: Tier;
  name: string;
  /** Monthly price in USD. */
  price: number;
  /** Annual price in USD (two months free). */
  annual: number;
  tagline: string;
  audience: string;
  badge?: string;
  limits: PlanLimits;
  highlights: string[];
  excludes: string[];
}

export const PLANS: Record<Tier, Plan> = {
  free: {
    id: 'free',
    name: 'Observer',
    price: 0,
    annual: 0,
    tagline: 'Read the desk before you pay for it.',
    audience: 'For traders evaluating the method.',
    limits: { backtestsPerDay: 5, aiMessagesPerDay: 0, watchedSymbols: 3, bridgeInstances: 0 },
    highlights: [
      'Full documentation and operational protocol',
      'Backtest engine — 5 runs per day',
      'Feature overview with per-plan gating',
      'Yesterday’s signal digest (delayed, no entries)',
      'Member notifications',
    ],
    excludes: ['Live signal feed', 'Cloud MT5 bridge', 'AI chat', 'OI / COT and CDTC analytics'],
  },
  operator: {
    id: 'operator',
    name: 'Operator',
    price: 49,
    annual: 490,
    tagline: 'Trade your own account with Vaelor’s research.',
    audience: 'For discretionary traders who execute manually.',
    badge: 'Most popular',
    limits: { backtestsPerDay: -1, aiMessagesPerDay: 50, watchedSymbols: 15, bridgeInstances: 0 },
    highlights: [
      'Everything in Observer',
      'Live signal feed across all timeframes',
      'MT5 indicator export — indicator, never an EA',
      'OI / COT positioning and CDTC charts',
      'Composite analytical engine and terminal analysis',
      'News desk with custom AI analysis',
      'AI chat — 50 messages per day',
      'Unlimited backtests, 15 watched symbols',
    ],
    excludes: ['Dedicated cloud bridge', 'Live desk order routing', 'Strategy upload'],
  },
  desk: {
    id: 'desk',
    name: 'Desk',
    price: 199,
    annual: 1990,
    tagline: 'Your own cloud MT5 desk, one VPS, always on.',
    audience: 'For traders who want the bridge, the blotter and the audit trail.',
    limits: { backtestsPerDay: -1, aiMessagesPerDay: -1, watchedSymbols: 100, bridgeInstances: 1 },
    highlights: [
      'Everything in Operator',
      'Dedicated cloud bridge instance + MetaTrader 5 terminal',
      'Live desk: order ticket, blotter, kill switch, risk gates',
      'Prop-safe lock for challenge accounts',
      'Bridge audit trail and execution usage',
      'Strategy upload (owner-approved before it runs)',
      'Unlimited AI chat under fair use',
      'Priority support',
    ],
    excludes: [],
  },
};

export const PLAN_ORDER: Tier[] = ['free', 'operator', 'desk'];

export function getPlan(tier: Tier): Plan {
  return PLANS[tier] ?? PLANS.free;
}

export function tierLabel(tier: Tier): string {
  return getPlan(tier).name;
}

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

function normaliseTier(value: unknown): Tier {
  if (value === 'desk' || value === 'subscriber') return 'desk';
  if (value === 'operator') return 'operator';
  return 'free';
}

export function getSubscription(username: string): SubscriptionState {
  const fallback: SubscriptionState = { tier: 'free', status: 'active', startedAt: null, expiresAt: null };
  try {
    const raw = window.localStorage.getItem(subKey(username));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      const sub = parsed as Partial<SubscriptionState>;
      const status: SubscriptionStatus =
        sub.status === 'trialing' || sub.status === 'canceled' ? sub.status : 'active';
      return {
        tier: normaliseTier(sub.tier),
        status,
        startedAt: typeof sub.startedAt === 'number' ? sub.startedAt : null,
        expiresAt: typeof sub.expiresAt === 'number' ? sub.expiresAt : null,
      };
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

export function setSubscription(username: string, sub: SubscriptionState): void {
  window.localStorage.setItem(subKey(username), JSON.stringify(sub));
}

/** 'none' when there is no usable paid record; 'expired' once the clock runs out. */
export function subscriptionStatus(username: string): SubscriptionStatus | 'none' {
  const sub = getSubscription(username);
  if (sub.status === 'canceled') return 'canceled';
  if (sub.tier === 'free') return 'none';
  if (sub.expiresAt !== null && sub.expiresAt <= Date.now()) return 'expired';
  return sub.status;
}

export function getTier(): Tier {
  const user = getCurrentUser();
  if (!user?.username) return 'free';
  const status = subscriptionStatus(user.username);
  if (status === 'canceled' || status === 'expired' || status === 'none') return 'free';
  return getSubscription(user.username).tier;
}

export function getSubscriptionRemainingSeconds(): number | null {
  const user = getCurrentUser();
  if (!user?.username) return null;
  const sub = getSubscription(user.username);
  if (!sub.expiresAt) return null;
  const ms = sub.expiresAt - Date.now();
  return ms <= 0 ? 0 : Math.floor(ms / 1000);
}

/** "12 days left", "today", "no expiry" — used by the member header and plan card. */
export function formatRemaining(seconds: number | null): string {
  if (seconds === null) return 'no expiry set';
  if (seconds <= 0) return 'expired';
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'} left`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'} left`;
  const minutes = Math.max(1, Math.floor(seconds / 60));
  return `${minutes} min left`;
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

export interface FeatureDef {
  key: FeatureKey;
  label: string;
  /** Lowest plan that unlocks the feature. */
  minTier: Tier;
  freeFallback: string;
}

export const FEATURES: Record<FeatureKey, FeatureDef> = {
  backtest: { key: 'backtest', label: 'Backtest', minTier: 'free', freeFallback: 'Backtest is included on every plan.' },
  signals: { key: 'signals', label: 'Live signal feed', minTier: 'operator', freeFallback: 'The live signal feed starts on the Operator plan.' },
  indicator_download: { key: 'indicator_download', label: 'MT5 indicator export', minTier: 'operator', freeFallback: 'Indicator export starts on the Operator plan.' },
  oi_cot: { key: 'oi_cot', label: 'OI / COT analytics', minTier: 'operator', freeFallback: 'OI / COT positioning starts on the Operator plan.' },
  cdtc: { key: 'cdtc', label: 'CDTC charts + analysis', minTier: 'operator', freeFallback: 'CDTC charts start on the Operator plan.' },
  analytical_chart: { key: 'analytical_chart', label: 'Analytical engine', minTier: 'operator', freeFallback: 'The analytical engine starts on the Operator plan.' },
  terminal_section2: { key: 'terminal_section2', label: 'Live terminal analysis', minTier: 'operator', freeFallback: 'The live terminal starts on the Operator plan.' },
  news_custom_ai: { key: 'news_custom_ai', label: 'Custom news AI analysis', minTier: 'operator', freeFallback: 'Custom news AI analysis starts on the Operator plan.' },
  ai_chat: { key: 'ai_chat', label: 'AI chat (MCP)', minTier: 'operator', freeFallback: 'AI chat starts on the Operator plan.' },
  pair: { key: 'pair', label: 'Cloud bridge pairing', minTier: 'desk', freeFallback: 'A dedicated cloud bridge is included on the Desk plan.' },
  live_trade: { key: 'live_trade', label: 'Live trade desk', minTier: 'desk', freeFallback: 'Live desk routing is included on the Desk plan.' },
  execution_usage: { key: 'execution_usage', label: 'Execution usage & audit', minTier: 'desk', freeFallback: 'Execution tracking and the audit trail are included on the Desk plan.' },
  upload_strategy: { key: 'upload_strategy', label: 'Strategy upload', minTier: 'desk', freeFallback: 'Strategy upload is included on the Desk plan.' },
};

export const FEATURE_ORDER: FeatureKey[] = [
  'signals',
  'indicator_download',
  'oi_cot',
  'cdtc',
  'analytical_chart',
  'terminal_section2',
  'news_custom_ai',
  'ai_chat',
  'pair',
  'live_trade',
  'execution_usage',
  'upload_strategy',
  'backtest',
];

export function requiredTier(feature: FeatureKey): Tier {
  return FEATURES[feature]?.minTier ?? 'desk';
}

/** Everything unlocked at or below this tier. */
export function featuresForTier(tier: Tier): FeatureKey[] {
  const rank = TIER_RANK[tier];
  return FEATURE_ORDER.filter((key) => TIER_RANK[FEATURES[key].minTier] <= rank);
}

/* ------------------------------------------------------------------ */
/* Tabs & locked-section previews                                       */
/* ------------------------------------------------------------------ */

export type TabId = 'overview' | 'execution' | 'terminal' | 'playbook';

/**
 * Locked-preview feature set per tab: the features whose teaser cards and
 * capability rows appear in the locked section behind the lock overlay.
 * `execution` is the Desk feature set plus `pair` — pairing is part of
 * execution.
 */
export const TAB_PREVIEW_FEATURES: Record<TabId, FeatureKey[]> = {
  overview: [],
  execution: ['live_trade', 'execution_usage', 'upload_strategy', 'pair'],
  terminal: ['terminal_section2', 'analytical_chart', 'ai_chat', 'signals', 'oi_cot', 'cdtc', 'news_custom_ai', 'indicator_download'],
  playbook: [],
};

export function can(feature: FeatureKey): boolean {
  const user = getCurrentUser();
  if (!user?.username) return false;
  const def = FEATURES[feature];
  if (!def) return false;
  return TIER_RANK[getTier()] >= TIER_RANK[def.minTier];
}

export function isAtLeast(tier: Tier): boolean {
  return TIER_RANK[getTier()] >= TIER_RANK[tier];
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

export function unreadNotificationCount(): number {
  return getNotifications().filter((n) => !n.read).length;
}

/* ------------------------------------------------------------------ */
/* Lock UI — shared overlay shown when a member hits a locked feature  */
/* ------------------------------------------------------------------ */

const PLANS_ANCHOR = '/member/#membership';

/**
 * Persisted tail of every feature-lock popup: locked sections stay visible,
 * so the popup ends with this sentence telling the member why.
 */
export const LOCK_MESSAGE =
  'برای دسترسی به این بخش باید اشتراک تهیه کنید. — Subscribe for access to this section.';

export function openFeatureLock(feature: FeatureKey): void {
  if (typeof document === 'undefined') return;
  const def = FEATURES[feature];
  if (!def) return;
  if (can(feature)) return;

  const needed = getPlan(def.minTier);
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
  card.style.position = 'relative';

  const kicker = document.createElement('div');
  kicker.style.fontFamily = '"JetBrains Mono",monospace';
  kicker.style.fontSize = '10px';
  kicker.style.letterSpacing = '0.2em';
  kicker.style.textTransform = 'uppercase';
  kicker.style.color = '#e11d48';
  kicker.textContent = `VAELOR · ${needed.name.toUpperCase()} PLAN`;

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
  body.style.margin = '0 0 6px';
  body.textContent = def.freeFallback;

  const meta = document.createElement('p');
  meta.style.fontSize = '12px';
  meta.style.lineHeight = '1.7';
  meta.style.color = '#6f5f66';
  meta.style.margin = '0 0 20px';
  meta.textContent = `${needed.name} · $${needed.price}/mo (or $${needed.annual}/yr). Includes ${needed.highlights.length} capabilities.`;

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
  btn.textContent = `See what ${needed.name} includes`;
  btn.addEventListener('click', () => {
    location.assign(PLANS_ANCHOR);
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Not now';
  close.style.marginTop = '10px';
  close.style.width = '100%';
  close.style.padding = '10px';
  close.style.borderRadius = '12px';
  close.style.border = '1px solid rgba(120,80,95,0.5)';
  close.style.background = 'transparent';
  close.style.color = '#a89aa0';
  close.style.fontSize = '12px';
  close.style.cursor = 'pointer';
  close.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove();
  });

  const closeX = document.createElement('button');
  closeX.type = 'button';
  closeX.className = 'close-btn';
  closeX.setAttribute('data-close', '');
  closeX.setAttribute('aria-label', 'Close');
  closeX.innerHTML = '&times;';
  closeX.addEventListener('click', () => overlay.remove());
  card.appendChild(closeX);

  card.appendChild(kicker);
  card.appendChild(title);
  card.appendChild(body);
  card.appendChild(meta);
  card.appendChild(btn);
  card.appendChild(close);

  // Locked sections stay visible: the popup ends with the persisted note.
  const note = document.createElement('p');
  note.style.fontFamily = '"JetBrains Mono",monospace';
  note.style.fontSize = '11px';
  note.style.lineHeight = '1.6';
  note.style.color = '#8a7a82';
  note.style.margin = '14px 0 0';
  note.textContent = LOCK_MESSAGE;
  card.appendChild(note);

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
      getPlan: (tier: Tier) => Plan;
      can: (f: FeatureKey) => boolean;
      openFeatureLock: (f: FeatureKey) => void;
      getSubscriptionRemainingSeconds: () => number | null;
      getNotifications: () => MemberNotification[];
      pushNotification: (n: Omit<MemberNotification, 'id' | 'at' | 'read'>) => void;
      markNotificationsRead: () => void;
      PLANS: Record<Tier, Plan>;
    };
  }
}

if (typeof window !== 'undefined') {
  window.VaelorMembership = {
    getCurrentUser,
    getTier,
    getPlan,
    can,
    openFeatureLock,
    getSubscriptionRemainingSeconds,
    getNotifications,
    pushNotification,
    markNotificationsRead,
    PLANS,
  };
}

export {};
