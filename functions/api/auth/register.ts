/**
 * POST /api/auth/register
 *
 * Creates a password account and signs the member straight in. The session is
 * an opaque token in an HttpOnly cookie; no credential is returned to JS.
 */
import type { Handler } from './_lib';
import {
  SESSION_TTL_REMEMBERED,
  SESSION_TTL_SECONDS,
  authPayload,
  clearAttempts,
  createSession,
  createUser,
  fail,
  getUser,
  isEmail,
  isSecureRequest,
  json,
  normaliseEmail,
  normaliseUsername,
  readJson,
  requestIp,
  sessionCookie,
  tooManyAttempts,
} from './_lib';

interface Body {
  email?: string;
  password?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  remember?: boolean;
}

export const onRequestPost: Handler = async ({ request, env }) => {
  const ip = requestIp(request);
  if (await tooManyAttempts(env, `register:${ip}`, 12, 3600)) {
    return fail(429, 'rate_limited', 'Too many sign-up attempts. Try again in an hour.');
  }

  const body = await readJson<Body>(request);
  if (!body) return fail(400, 'bad_request', 'Expected a JSON body.');

  const email = normaliseEmail(body.email ?? '');
  if (!isEmail(email)) return fail(400, 'email_invalid', 'Enter a valid email address.');

  const password = body.password ?? '';
  if (password.length < 8) {
    return fail(400, 'password_weak', 'Use at least 8 characters.');
  }
  if (password.length > 200) {
    return fail(400, 'password_invalid', 'That password is too long.');
  }

  if (body.username && normaliseUsername(body.username).length < 3) {
    return fail(400, 'username_invalid', 'Username needs at least 3 letters, numbers, dots, dashes or underscores.');
  }

  if (await getUser(env, email)) {
    return fail(409, 'email_taken', 'An account with that email already exists. Sign in instead.');
  }

  const name =
    (body.name ?? `${body.firstName ?? ''} ${body.lastName ?? ''}`).trim() || email.split('@')[0] || 'Member';

  let user;
  try {
    user = await createUser(env, {
      email,
      name,
      provider: 'password',
      password,
      username: body.username,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error('auth.register failed:', reason);
    if (reason === 'username_taken') return fail(409, 'username_taken', 'That username is already taken.');
    if (reason === 'username_invalid') {
      return fail(400, 'username_invalid', 'Username needs at least 3 letters, numbers, dots, dashes or underscores.');
    }
    return fail(500, 'register_failed', 'Could not create the account. Please retry.');
  }

  const ttl = body.remember ? SESSION_TTL_REMEMBERED : SESSION_TTL_SECONDS;
  const { id } = await createSession(env, user, 'password', ttl);
  await clearAttempts(env, `login:${ip}:${email}`);

  return json(authPayload(env, user, { tier: 'free', status: 'active', startedAt: null, expiresAt: null }), {
    status: 201,
    headers: { 'set-cookie': sessionCookie(id, ttl, isSecureRequest(request)) },
  });
};
