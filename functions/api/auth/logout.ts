/**
 * POST /api/auth/logout — revoke the session record and clear the cookie.
 */
import type { Handler } from './_lib';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  isSecureRequest,
  json,
  readCookie,
} from './_lib';

export const onRequestPost: Handler = async ({ request, env }) => {
  const id = readCookie(request, SESSION_COOKIE);
  if (id) await env.AUTH.delete(`sid:${id}`);
  return json(
    { ok: true },
    { headers: { 'set-cookie': clearSessionCookie(isSecureRequest(request)) } },
  );
};

export const onRequestGet = onRequestPost;
