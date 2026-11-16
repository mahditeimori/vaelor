/**
 * GET /api/auth/oauth/:provider/callback
 *
 * Exchanges the authorization code, reads the verified email from the
 * provider, then creates or reuses the member and signs them in.
 *
 * Google: OpenID userinfo endpoint (the email is already verified by Google).
 * GitHub: /user plus /user/emails — /user.email can be null and may be a
 *         private, unverified address, so the verified primary one is used.
 */
import type { Env, Handler } from '../../_lib';
import {
  SESSION_TTL_REMEMBERED,
  SESSION_TTL_SECONDS,
  createSession,
  createUser,
  getUser,
  isSecureRequest,
  isEmail,
  linkProvider,
  normaliseEmail,
  originOf,
  redirect,
  safeNext,
  sessionCookie,
} from '../../_lib';

type Provider = 'google' | 'github';

interface StateRecord {
  provider?: Provider;
  remember?: boolean;
  next?: string;
}

interface Profile {
  email: string;
  name: string;
}

export const onRequestGet: Handler = async ({ request, env, params }) => {
  const provider = String(params.provider ?? '').toLowerCase() as Provider;
  const origin = originOf(request, env);
  const back = (code: string, detail?: string) =>
    redirect(
      `${origin}/login.html?error=${encodeURIComponent(code)}${detail ? `&detail=${encodeURIComponent(detail)}` : ''}`,
    );

  if (provider !== 'google' && provider !== 'github') return back('unknown_provider');

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (url.searchParams.get('error')) return back('oauth_denied');
  if (!code || !state) return back('oauth_incomplete');

  const stored = await env.AUTH.get<StateRecord>(`oauth:${state}`, 'json');
  await env.AUTH.delete(`oauth:${state}`);
  if (!stored) return back('oauth_state');
  const record = stored;
  if (record.provider !== provider) return back('oauth_state');

  try {
    const profile =
      provider === 'google'
        ? await googleProfile(code, env, origin)
        : await githubProfile(code, env, origin);

    if (!profile || !isEmail(profile.email)) return back('oauth_email');

    const email = normaliseEmail(profile.email);
    let user = await getUser(env, email);
    if (user) {
      user = await linkProvider(env, user, provider);
    } else {
      user = await createUser(env, { email, name: profile.name, provider });
    }

    const ttl = record.remember ? SESSION_TTL_REMEMBERED : SESSION_TTL_SECONDS;
    const { id } = await createSession(env, user, provider, ttl);
    return redirect(`${origin}${safeNext(record.next ?? null)}`, sessionCookie(id, ttl, isSecureRequest(request)));
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 140) : 'unknown';
    return back('oauth_failed', detail);
  }
};

function clientSecret(env: { GOOGLE_CLIENT_SECRET?: string; GITHUB_CLIENT_SECRET?: string }, provider: Provider) {
  return (provider === 'google' ? env.GOOGLE_CLIENT_SECRET : env.GITHUB_CLIENT_SECRET) ?? '';
}

function clientId(env: { GOOGLE_CLIENT_ID?: string; GITHUB_CLIENT_ID?: string }, provider: Provider) {
  return (provider === 'google' ? env.GOOGLE_CLIENT_ID : env.GITHUB_CLIENT_ID) ?? '';
}

async function exchangeCode(
  provider: Provider,
  code: string,
  env: Env,
  origin: string,
): Promise<string> {
  const tokenUrl =
    provider === 'google' ? 'https://oauth2.googleapis.com/token' : 'https://github.com/login/oauth/access_token';
  const body = new URLSearchParams({
    client_id: clientId(env, provider),
    client_secret: clientSecret(env, provider),
    code,
    grant_type: 'authorization_code',
    redirect_uri: `${origin}/api/auth/oauth/${provider}/callback`,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'vaelor-auth',
    },
    body,
  });

  if (!response.ok) throw new Error(`token_exchange_${response.status}`);
  const payload = (await response.json()) as { access_token?: string; error?: string };
  if (!payload.access_token) throw new Error(payload.error ?? 'token_missing');
  return payload.access_token;
}

async function googleProfile(
  code: string,
  env: Env,
  origin: string,
): Promise<Profile | null> {
  const accessToken = await exchangeCode('google', code, env, origin);
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`userinfo_${response.status}`);
  const data = (await response.json()) as {
    email?: string;
    email_verified?: boolean;
    name?: string;
    given_name?: string;
  };
  if (!data.email || data.email_verified === false) return null;
  return { email: data.email, name: data.name ?? data.given_name ?? data.email.split('@')[0] ?? 'Member' };
}

async function githubProfile(
  code: string,
  env: Env,
  origin: string,
): Promise<Profile | null> {
  const accessToken = await exchangeCode('github', code, env, origin);
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'vaelor-auth',
  };

  const userResponse = await fetch('https://api.github.com/user', { headers });
  if (!userResponse.ok) throw new Error(`github_user_${userResponse.status}`);
  const profile = (await userResponse.json()) as { login?: string; name?: string; email?: string };

  let email = profile.email ?? '';
  if (!email) {
    const emailResponse = await fetch('https://api.github.com/user/emails', { headers });
    if (emailResponse.ok) {
      const list = (await emailResponse.json()) as Array<{
        email?: string;
        primary?: boolean;
        verified?: boolean;
      }>;
      const preferred =
        list.find((entry) => entry.primary && entry.verified) ?? list.find((entry) => entry.verified);
      email = preferred?.email ?? '';
    }
  }

  if (!email) return null;
  return {
    email,
    name: profile.name ?? profile.login ?? email.split('@')[0] ?? 'Member',
  };
}

