/**
 * Shared auth helpers for the Cloudflare Pages Functions under /api/auth.
 *
 * Storage (KV binding `AUTH`):
 *   u:<email>        user record
 *   u:<userid>       (see idIndex) not used — lookup is by email only
 *   sid:<sessionId>  session record, TTL-bounded by KV itself
 *   oauth:<state>    short-lived OAuth state token
 *   rl:<key>         login attempt counters
 *   s:<userId>       subscription record (tier/status/expiry)
 *
 * Passwords are PBKDF2-SHA256, 100 000 iterations, 16-byte random salt. Only the
 * derived hash is stored. Sessions are opaque 32-byte tokens delivered in an
 * HttpOnly cookie, so no credential ever reaches client JavaScript.
 */

export interface KVLike {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: 'json'): Promise<T | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Env {
  AUTH: KVLike;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Cloudflare Turnstile. Both must be present for the human check to run. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** Optional override, e.g. https://vaelor.pages.dev */
  PUBLIC_ORIGIN?: string;
  /** Comma-separated emails allowed into /owner. */
  OWNER_EMAILS?: string;
  /** Optional transactional email (password resets). */
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
}

export interface EventContext {
  request: Request;
  env: Env;
  params: Record<string, string | string[]>;
  waitUntil(promise: Promise<unknown>): void;
}

export type Handler = (context: EventContext) => Promise<Response>;

export const SESSION_COOKIE = 'vaelor_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const SESSION_TTL_REMEMBERED = 60 * 60 * 24 * 180;
export const OAUTH_STATE_TTL = 600;
/** Cloudflare Workers caps WebCrypto PBKDF2 at 100 000 iterations. */
export const PBKDF2_ITERATIONS = 100000;

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function fail(status: number, error: string, detail?: string): Response {
  return json({ ok: false, error, detail }, { status });
}

export function originOf(request: Request, env: Env): string {
  if (env.PUBLIC_ORIGIN) return env.PUBLIC_ORIGIN.replace(/\/+$/, '');
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

export function sessionCookie(value: string, maxAge: number, secure: boolean): string {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie('', 0, secure);
}

export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    const text = await request.text();
    if (!text || text.length > MAX_JSON_BYTES) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const MAX_JSON_BYTES = 262_144;

/** Require POST/PUT/DELETE state changes to originate from our own origin. */
export function sameOriginError(request: Request, env: Env): string | null {
  const expected = originOf(request, env);
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  if (origin) {
    try {
      const parsed = new URL(origin);
      return `${parsed.protocol}//${parsed.host}` !== expected ? 'origin_mismatch' : null;
    } catch {
      return 'origin_mismatch';
    }
  }
  if (referer) {
    try {
      const parsed = new URL(referer, expected);
      return parsed.origin !== expected ? 'referer_mismatch' : null;
    } catch {
      return 'referer_mismatch';
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Turnstile (Cloudflare) human verification                           */
/* ------------------------------------------------------------------ */

export function captchaEnabled(env: Env): boolean {
  return Boolean(env.TURNSTILE_SITE_KEY?.trim() && env.TURNSTILE_SECRET_KEY?.trim());
}

export interface CaptchaResult {
  ok: boolean;
  /** False when the deployment has no Turnstile keys; callers then skip the check. */
  configured: boolean;
  reason?: string;
}

/**
 * Verify a Turnstile token server-side. The token is single-use and expires
 * after five minutes, so it is checked before any password work happens.
 * A deployment without keys keeps working (the rate limits still apply), which
 * allows local previews and staged rollouts without a captcha.
 */
export async function verifyCaptcha(
  request: Request,
  env: Env,
  token: string | undefined,
): Promise<CaptchaResult> {
  if (!captchaEnabled(env)) return { ok: true, configured: false };

  const response = (token ?? '').trim();
  if (!response) return { ok: false, configured: true, reason: 'missing' };
  if (response.length > 4096) return { ok: false, configured: true, reason: 'oversized' };

  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY!.trim(),
    response,
  });
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) body.set('remoteip', ip);

  try {
    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(6000),
    });
    if (!result.ok) return { ok: false, configured: true, reason: `siteverify_${result.status}` };

    const data = (await result.json()) as {
      success?: boolean;
      action?: string;
      hostname?: string;
      'error-codes'?: string[];
    };

    if (data.success !== true) {
      return {
        ok: false,
        configured: true,
        reason: (data['error-codes'] ?? []).join(',') || 'rejected',
      };
    }
    if (data.action && data.action !== 'auth') {
      return { ok: false, configured: true, reason: 'action_mismatch' };
    }
    return { ok: true, configured: true };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      reason: error instanceof Error ? error.message.slice(0, 80) : 'unreachable',
    };
  }
}

/* ------------------------------------------------------------------ */
/* Randomness / hashing                                                */
/* ------------------------------------------------------------------ */

export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let binary = '';
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(digest);
}

export interface PasswordRecord {
  hash: string;
  salt: string;
  iterations: number;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return toHex(bits);
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  let binary = '';
  for (const byte of salt) binary += String.fromCharCode(byte);
  return {
    hash,
    salt: btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    iterations: PBKDF2_ITERATIONS,
  };
}

export function unchanged(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  const normalised = record.salt.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalised);
  const salt = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) salt[i] = binary.charCodeAt(i);
  const hash = await derive(password, salt, record.iterations || PBKDF2_ITERATIONS);
  return unchanged(hash, record.hash);
}

/* ------------------------------------------------------------------ */
/* User records                                                        */
/* ------------------------------------------------------------------ */

export type Provider = 'password' | 'google' | 'github';

export interface UserRecord {
  id: string;
  email: string;
  username: string;
  name: string;
  providers: Provider[];
  pw?: PasswordRecord;
  createdAt: number;
}

export interface SubscriptionRecord {
  tier: 'free' | 'operator' | 'desk';
  status: 'active' | 'trialing' | 'canceled';
  startedAt: number | null;
  expiresAt: number | null;
}

export interface SessionRecord {
  userId: string;
  email: string;
  provider: Provider;
  createdAt: number;
  expiresAt: number;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/** Keep the dashboard handle URL-safe and stable across providers. */
export function usernameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? 'member';
  const clean = local.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '');
  return clean.length >= 2 ? clean.slice(0, 32) : `member${Math.floor(Math.random() * 9000 + 1000)}`;
}

export async function getUser(env: Env, email: string): Promise<UserRecord | null> {
  return env.AUTH.get<UserRecord>(`u:${normaliseEmail(email)}`, 'json');
}

export async function putUser(env: Env, user: UserRecord): Promise<void> {
  await env.AUTH.put(`u:${normaliseEmail(user.email)}`, JSON.stringify(user));
}

/**
 * The login form accepts either an email address or a username. Usernames are
 * indexed in `un:<username>` -> email by `claimUsername`.
 */
export async function resolveEmail(env: Env, identifier: string): Promise<string | null> {
  const value = identifier.trim();
  if (!value) return null;
  if (value.includes('@')) {
    const email = normaliseEmail(value);
    return isEmail(email) ? email : null;
  }
  const mapped = await env.AUTH.get(`un:${value.toLowerCase()}`);
  return mapped ? normaliseEmail(mapped) : null;
}

export function isOwnerEmail(env: Env, email: string): boolean {
  const list = (env.OWNER_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(normaliseEmail(email));
}

export async function findAvailableUsername(env: Env, email: string): Promise<string> {
  const base = usernameFromEmail(email);
  const emailKey = normaliseEmail(email);
  let candidate = base;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const taken = await env.AUTH.get(`un:${candidate}`);
    if (!taken || taken === emailKey) return candidate;
    candidate = `${base}${attempt + 2}`.slice(0, 36);
  }
  return `${base}${Date.now().toString(36).slice(-4)}`;
}

export async function claimUsername(env: Env, username: string, email: string): Promise<void> {
  await env.AUTH.put(`un:${username.toLowerCase()}`, normaliseEmail(email));
}

export function normaliseUsername(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+/, '')
    .slice(0, 32);
}

export async function createUser(
  env: Env,
  input: { email: string; name: string; provider: Provider; password?: string; username?: string },
): Promise<UserRecord> {
  const email = normaliseEmail(input.email);
  let username: string;
  if (input.username) {
    const requested = normaliseUsername(input.username);
    if (requested.length < 3) throw new Error('username_invalid');
    const taken = await env.AUTH.get(`un:${requested}`);
    if (taken && taken !== email) throw new Error('username_taken');
    username = requested;
  } else {
    username = await findAvailableUsername(env, email);
  }
  const user: UserRecord = {
    id: randomToken(12),
    email,
    username,
    name: input.name.trim() || username,
    providers: [input.provider],
    createdAt: Date.now(),
  };
  if (input.password) user.pw = await hashPassword(input.password);
  await putUser(env, user);
  await claimUsername(env, username, email);
  return user;
}

/** Add a provider to an existing account the first time it is used to sign in. */
export async function linkProvider(env: Env, user: UserRecord, provider: Provider): Promise<UserRecord> {
  if (user.providers.includes(provider)) return user;
  user.providers = [...user.providers, provider];
  await putUser(env, user);
  return user;
}

export async function getSubscription(env: Env, userId: string): Promise<SubscriptionRecord> {
  const stored = await env.AUTH.get<Partial<SubscriptionRecord>>(`s:${userId}`, 'json');
  if (stored && typeof stored === 'object') {
    const sub = stored;
    return {
      tier: sub.tier === 'operator' || sub.tier === 'desk' ? sub.tier : 'free',
      status: sub.status === 'trialing' || sub.status === 'canceled' ? sub.status : 'active',
      startedAt: typeof sub.startedAt === 'number' ? sub.startedAt : null,
      expiresAt: typeof sub.expiresAt === 'number' ? sub.expiresAt : null,
    };
  }
  return { tier: 'free', status: 'active', startedAt: null, expiresAt: null };
}

/** The single writer for entitlements. Only owner-gated code may call it. */
export async function putSubscription(
  env: Env,
  userId: string,
  sub: SubscriptionRecord,
): Promise<void> {
  await env.AUTH.put(`s:${userId}`, JSON.stringify(sub));
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export async function createSession(
  env: Env,
  user: UserRecord,
  provider: Provider,
  ttl: number,
): Promise<{ id: string; record: SessionRecord }> {
  const id = randomToken(32);
  const now = Date.now();
  const record: SessionRecord = {
    userId: user.id,
    email: user.email,
    provider,
    createdAt: now,
    expiresAt: now + ttl * 1000,
  };
  await env.AUTH.put(`sid:${id}`, JSON.stringify(record), { expirationTtl: ttl });
  return { id, record };
}

export interface SessionContext {
  id: string;
  session: SessionRecord;
  user: UserRecord;
  subscription: SubscriptionRecord;
}

export async function getSessionContext(request: Request, env: Env): Promise<SessionContext | null> {
  const id = readCookie(request, SESSION_COOKIE);
  if (!id) return null;
  const record = await env.AUTH.get<SessionRecord>(`sid:${id}`, 'json');
  if (!record) return null;
  if (record.expiresAt && record.expiresAt < Date.now()) {
    await env.AUTH.delete(`sid:${id}`);
    return null;
  }
  const user = await getUser(env, record.email);
  if (!user) return null;
  return { id, session: record, user, subscription: await getSubscription(env, user.id) };
}

/** Hand the client the same shape the dashboard already speaks. */
export function publicUser(user: UserRecord): Record<string, unknown> {
  return {
    username: user.username,
    email: user.email,
    name: user.name,
    firstName: user.name.split(' ')[0] ?? user.name,
    lastName: user.name.split(' ').slice(1).join(' '),
    provider: user.providers[0] ?? 'password',
    providers: user.providers,
  };
}

export function authPayload(
  env: Env,
  user: UserRecord,
  subscription: SubscriptionRecord,
): Record<string, unknown> {
  return {
    user: publicUser(user),
    subscription,
    isOwner: isOwnerEmail(env, user.email),
  };
}

/** Cloudflare supplies the client address; fall back to a shared bucket. */
export function requestIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

export function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location });
  headers.set('cache-control', 'no-store');
  if (cookie) headers.set('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

/** Only allow same-site relative paths as post-login destinations. */
export function safeNext(value: string | null): string {
  if (!value) return '/member';
  if (!value.startsWith('/') || value.startsWith('//')) return '/member';
  return value;
}

/* ------------------------------------------------------------------ */
/* Rate limiting (KV counters — best effort, per isolate-agnostic key) */
/* ------------------------------------------------------------------ */

export async function tooManyAttempts(env: Env, key: string, limit: number, windowSeconds = 900): Promise<boolean> {
  const bucket = `rl:${key}`;
  const raw = await env.AUTH.get(bucket);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= limit) return true;
  await env.AUTH.put(bucket, String(count + 1), { expirationTtl: windowSeconds });
  return false;
}

export async function clearAttempts(env: Env, key: string): Promise<void> {
  await env.AUTH.delete(`rl:${key}`);
}
