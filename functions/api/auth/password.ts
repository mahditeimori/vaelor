/**
 * POST /api/auth/password — change or set the password for the signed-in user.
 *
 * OAuth-only accounts have no password yet, so they may set one without
 * proving a current password. Accounts that already have one must prove it.
 */
import type { Handler } from './_lib';
import {
  fail,
  getSessionContext,
  hashPassword,
  json,
  putUser,
  readJson,
  verifyPassword,
} from './_lib';

interface Body {
  currentPassword?: string;
  newPassword?: string;
}

export const onRequestPost: Handler = async ({ request, env }) => {
  const context = await getSessionContext(request, env);
  if (!context) return fail(401, 'not_authenticated');

  const body = await readJson<Body>(request);
  if (!body) return fail(400, 'bad_request', 'Expected a JSON body.');

  const next = body.newPassword ?? '';
  if (next.length < 8) return fail(400, 'password_weak', 'Use at least 8 characters.');
  if (next.length > 200) return fail(400, 'password_invalid', 'That password is too long.');

  if (context.user.pw) {
    const current = body.currentPassword ?? '';
    if (!current) return fail(400, 'password_missing', 'Enter your current password.');
    if (!(await verifyPassword(current, context.user.pw))) {
      return fail(403, 'password_wrong', 'Current password is incorrect.');
    }
  }

  context.user.pw = await hashPassword(next);
  await putUser(env, context.user);
  return json({ ok: true, message: 'Password updated.' });
};
