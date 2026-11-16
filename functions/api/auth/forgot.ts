/**
 * POST /api/auth/forgot — request a password-reset link.
 *
 * Always answers with the same shape so the endpoint cannot be used to
 * enumerate registered addresses. Delivery is real email via Resend when
 * RESEND_API_KEY is configured; otherwise the response says so instead of
 * pretending a message was sent.
 */
import type { Handler } from './_lib';
import {
  fail,
  getUser,
  isEmail,
  json,
  normaliseEmail,
  originOf,
  randomToken,
  readJson,
  requestIp,
  tooManyAttempts,
} from './_lib';

interface Body {
  email?: string;
}

const RESET_TTL = 60 * 30;

export const onRequestPost: Handler = async ({ request, env }) => {
  const ip = requestIp(request);
  if (await tooManyAttempts(env, `forgot:${ip}`, 6, 3600)) {
    return fail(429, 'rate_limited', 'Too many reset requests. Try again later.');
  }

  const body = await readJson<Body>(request);
  const email = normaliseEmail(body?.email ?? '');
  const generic = { ok: true, delivery: env.RESEND_API_KEY ? 'email' : 'unavailable' };

  if (!isEmail(email)) return json(generic);

  const user = await getUser(env, email);
  if (!user) return json(generic);

  const token = randomToken(24);
  await env.AUTH.put(`rst:${token}`, JSON.stringify({ email, at: Date.now() }), {
    expirationTtl: RESET_TTL,
  });

  if (!env.RESEND_API_KEY) return json(generic);

  const link = `${originOf(request, env)}/login.html?reset=${encodeURIComponent(token)}`;
  const sent = await sendResetEmail(env, email, user.name, link);
  return json({ ...generic, delivery: sent ? 'email' : 'unavailable' });
};

async function sendResetEmail(
  env: { RESEND_API_KEY?: string; MAIL_FROM?: string },
  to: string,
  name: string,
  link: string,
): Promise<boolean> {
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM ?? 'Vaelor Trading <no-reply@vaelor.pages.dev>',
        to: [to],
        subject: 'Reset your Vaelor Trading password',
        text: `Hello ${name},\n\nUse this link within 30 minutes to choose a new password:\n${link}\n\nIf you did not request it, ignore this email.\n`,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
