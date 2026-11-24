/**
 * POST /api/auth/login
 *
 * Email-or-username + password. A Turnstile token (when the deployment has
 * keys) blocks scripted attempts, and two independent counters (per IP, per
 * account) back it up. Both live on the server, so the browser cannot reset
 * them as it could with the old client-side captcha.
 */
import type { Handler } from './_lib';
import {
  SESSION_TTL_REMEMBERED,
  SESSION_TTL_SECONDS,
  authPayload,
  clearAttempts,
  createSession,
  fail,
  getSubscription,
  getUser,
  isSecureRequest,
  json,
  readJson,
  requestIp,
  resolveEmail,
  sameOriginError,
  sessionCookie,
  tooManyAttempts,
  verifyCaptcha,
  verifyPassword,
} from './_lib';

interface Body {
  identifier?: string;
  email?: string;
  password?: string;
  remember?: boolean;
  captchaToken?: string;
}

export const onRequestPost: Handler = async ({ request, env }) => {
  const ip = requestIp(request);
  if (await tooManyAttempts(env, `login-ip:${ip}`, 40, 900)) {
    return fail(429, 'rate_limited', 'Too many attempts from this network. Try again in 15 minutes.');
  }
  const originError = sameOriginError(request, env);
  if (originError) return fail(403, originError);

  const body = await readJson<Body>(request);
  if (!body) return fail(400, 'bad_request', 'Expected a JSON body.');

  const captcha = await verifyCaptcha(request, env, body.captchaToken);
  if (!captcha.ok) {
    console.warn('auth.login captcha rejected:', captcha.reason ?? 'unknown');
    return fail(400, 'captcha_failed', 'Complete the human verification and try again.');
  }

  const identifier = (body.identifier ?? body.email ?? '').trim();
  const password = body.password ?? '';
  if (!identifier || !password) {
    return fail(400, 'credentials_missing', 'Enter your email or username and password.');
  }

  const accountKey = `login:${normaliseAccount(identifier)}`;
  if (await tooManyAttempts(env, accountKey, 8, 900)) {
    return fail(429, 'rate_limited', 'Too many failed attempts for this account. Try again in 15 minutes.');
  }

  const email = await resolveEmail(env, identifier);
  if (!email) return fail(401, 'invalid_credentials', 'Email, username or password is incorrect.');

  const user = await getUser(env, email);
  if (!user || !user.pw) {
    return fail(401, 'invalid_credentials', 'Email, username or password is incorrect.');
  }

  if (!(await verifyPassword(password, user.pw))) {
    return fail(401, 'invalid_credentials', 'Email, username or password is incorrect.');
  }

  await clearAttempts(env, accountKey);
  const ttl = body.remember ? SESSION_TTL_REMEMBERED : SESSION_TTL_SECONDS;
  const { id } = await createSession(env, user, 'password', ttl);
  const subscription = await getSubscription(env, user.id);

  return json(authPayload(env, user, subscription), {
    headers: { 'set-cookie': sessionCookie(id, ttl, isSecureRequest(request)) },
  });
};

function normaliseAccount(value: string): string {
  return value.trim().toLowerCase();
}
