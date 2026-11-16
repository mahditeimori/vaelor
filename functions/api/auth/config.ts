/**
 * GET /api/auth/config
 *
 * Tells the login console which methods are actually wired up, so the page can
 * show an honest state instead of a button that goes nowhere until the OAuth
 * apps are created in the provider dashboards.
 */
import type { Handler } from './_lib';
import { json, originOf } from './_lib';

export const onRequestGet: Handler = async ({ request, env }) => {
  const google = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const github = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  return json({
    ok: true,
    origin: originOf(request, env),
    providers: { password: true, google, github },
    passwordReset: Boolean(env.RESEND_API_KEY),
  });
};
