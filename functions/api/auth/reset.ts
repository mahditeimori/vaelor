/**
 * POST /api/auth/reset — consume a single-use reset token.
 */
import type { Handler } from './_lib';
import {
  fail,
  getUser,
  hashPassword,
  json,
  putUser,
  readJson,
  sameOriginError,
  tooManyAttempts,
} from './_lib';

interface Body {
  token?: string;
  password?: string;
}

const RESET_TTL_MS = 30 * 60_000;

export const onRequestPost: Handler = async ({ request, env }) => {
  const originError = sameOriginError(request, env);
  if (originError) return fail(403, originError);
  const body = await readJson<Body>(request);
  if (!body?.token) return fail(400, 'token_missing', 'This reset link is incomplete.');
  const password = body.password ?? '';
  if (password.length < 8) return fail(400, 'password_weak', 'Use at least 8 characters.');

  const record = await env.AUTH.get<{ email?: string; at?: number }>(`rst:${body.token}`, 'json');
  if (!record || typeof record.at !== 'number' || Date.now() - record.at > RESET_TTL_MS) {
    return fail(400, 'token_invalid', 'This reset link has expired or was already used.');
  }
  if (await tooManyAttempts(env, `reset:${body.token}`, 4, 300_000)) {
    return fail(429, 'rate_limited', 'Too many reset attempts. Try again later.');
  }

  const { email } = record;
  const user = email ? await getUser(env, email) : null;
  if (!user) return fail(400, 'token_invalid', 'This reset link has expired or was already used.');

  user.pw = await hashPassword(password);
  await putUser(env, user);
  await env.AUTH.delete(`rst:${body.token}`);
  await env.AUTH.put(`reset:${body.token}`, '1', { expirationTtl: 60 });
  return json({ ok: true, message: 'Password updated. You can sign in now.' });
};
