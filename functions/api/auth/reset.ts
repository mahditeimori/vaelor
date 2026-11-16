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
} from './_lib';

interface Body {
  token?: string;
  password?: string;
}

export const onRequestPost: Handler = async ({ request, env }) => {
  const body = await readJson<Body>(request);
  if (!body?.token) return fail(400, 'token_missing', 'This reset link is incomplete.');

  const password = body.password ?? '';
  if (password.length < 8) return fail(400, 'password_weak', 'Use at least 8 characters.');

  const record = await env.AUTH.get<{ email?: string }>(`rst:${body.token}`, 'json');
  if (!record) {
    return fail(400, 'token_invalid', 'This reset link has expired or was already used.');
  }

  const { email } = record;
  const user = email ? await getUser(env, email) : null;
  if (!user) return fail(400, 'token_invalid', 'This reset link has expired or was already used.');

  user.pw = await hashPassword(password);
  await putUser(env, user);
  await env.AUTH.delete(`rst:${body.token}`);
  return json({ ok: true, message: 'Password updated. You can sign in now.' });
};
