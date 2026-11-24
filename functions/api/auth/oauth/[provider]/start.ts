/**
 * GET /api/auth/oauth/:provider/start
 *
 * Builds the provider authorize URL. A random `state` is stored in KV for ten
 * minutes and checked on the callback, which blocks login CSRF.
 */
import type { Handler, Env } from '../../_lib';
import {
  OAUTH_STATE_TTL,
  fail,
  originOf,
  randomToken,
  redirect,
  safeNext,
} from '../../_lib';

type Provider = 'google' | 'github';

const SCOPES: Record<Provider, string> = {
  google: 'openid email profile',
  github: 'read:user user:email',
};

const AUTHORIZE: Record<Provider, string> = {
  google: 'https://accounts.google.com/o/oauth2/v2/auth',
  github: 'https://github.com/login/oauth/authorize',
};

export function providerConfigured(env: Env, provider: Provider): boolean {
  if (provider === 'google') {
    return Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
  }
  return Boolean(env.GITHUB_CLIENT_ID?.trim() && env.GITHUB_CLIENT_SECRET?.trim());
}

function clientId(env: Env, provider: Provider): string {
  return (
    (provider === 'google' ? env.GOOGLE_CLIENT_ID : env.GITHUB_CLIENT_ID)?.trim() ?? ''
  );
}

export const onRequestGet: Handler = async ({ request, env, params }) => {
  const provider = String(params.provider ?? '').toLowerCase() as Provider;
  const origin = originOf(request, env);

  if (provider !== 'google' && provider !== 'github') {
    return fail(404, 'unknown_provider', 'Unknown sign-in provider.');
  }

  if (!providerConfigured(env, provider)) {
    return redirect(`${origin}/login.html?error=oauth_not_configured&provider=${provider}`);
  }

  const url = new URL(request.url);
  const remember = url.searchParams.get('remember') === '1';
  const next = safeNext(url.searchParams.get('next'));

  const state = randomToken(24);
  await env.AUTH.put(
    `oauth:${state}`,
    JSON.stringify({ provider, remember, next, at: Date.now() }),
    { expirationTtl: OAUTH_STATE_TTL },
  );

  const redirectUri = `${origin}/api/auth/oauth/${provider}/callback`;
  const authorize = new URL(AUTHORIZE[provider]);
  authorize.searchParams.set('client_id', clientId(env, provider));
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', SCOPES[provider]);
  authorize.searchParams.set('state', state);
  if (provider === 'google') {
    authorize.searchParams.set('access_type', 'online');
    authorize.searchParams.set('prompt', 'select_account');
    authorize.searchParams.set('include_granted_scopes', 'true');
  }

  return redirect(authorize.toString());
};
