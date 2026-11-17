# Authentication setup

The site no longer keeps passwords in the browser. Sign-in is handled by
Cloudflare Pages Functions under `functions/api/auth/` and the session is an
opaque token in an `HttpOnly` cookie.

## What works out of the box

- **Email + password** — registration, sign-in with email *or* username,
  password change, logout, server-side rate limiting.
- **Session cookie** — `vaelor_session`, `HttpOnly`, `SameSite=Lax`,
  `Secure` on HTTPS, 30 days normally, 180 days with "Remember me".
- **Password hashing** — PBKDF2-SHA256, 100 000 iterations, 16-byte random
  salt per user. Only the derived hash is stored.
- **Owner detection** — any address in `OWNER_EMAILS` gets `isOwner: true`
  from `/api/auth/me` and the owner link on the login page.

Google and GitHub sign-in are implemented end to end but require OAuth apps,
so they stay visibly disabled until the credentials below exist.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/auth/config` | Which providers are configured (no secrets). |
| `POST` | `/api/auth/register` | Create an account and sign in. |
| `POST` | `/api/auth/login` | Email/username + password. |
| `POST` | `/api/auth/logout` | Revoke the session and clear the cookie. |
| `GET` | `/api/auth/me` | Current user, subscription, owner flag. |
| `POST` | `/api/auth/password` | Change/set a password for the signed-in user. |
| `POST` | `/api/auth/forgot` | Request a reset link (email delivery if Resend is set). |
| `POST` | `/api/auth/reset` | Consume a single-use reset token. |
| `POST` | `/api/auth/admin-password` | Owner-only password reset for a locked-out member. |
| `GET` | `/api/auth/oauth/google/start` | Begin Google sign-in. |
| `GET` | `/api/auth/oauth/google/callback` | Finish Google sign-in. |
| `GET` | `/api/auth/oauth/github/start` | Begin GitHub sign-in. |
| `GET` | `/api/auth/oauth/github/callback` | Finish GitHub sign-in. |
| `POST` | `/api/subscription/request` | Member asks for Operator or Desk (rate limited, de-duplicated). |
| `GET` | `/api/subscription/requests` | Owner-only list of pending upgrade requests. |
| `POST` | `/api/subscription/grant` | Owner-only entitlement write (`operator` / `desk` / `free`). |

## Subscription endpoints

Tiers are server-owned. A member can ask; only an owner can grant.

```powershell
# member: ask for a plan
curl.exe -X POST https://vaelor.pages.dev/api/subscription/request `
  -H "content-type: application/json" -b "vaelor_session=<member cookie>" `
  -d '{"plan":"operator","period":"monthly"}'

# owner: see what is pending
curl.exe https://vaelor.pages.dev/api/subscription/requests -b "vaelor_session=<owner cookie>"

# owner: activate a plan for 30 days, closing the request that asked for it
curl.exe -X POST https://vaelor.pages.dev/api/subscription/grant `
  -H "content-type: application/json" -b "vaelor_session=<owner cookie>" `
  -d '{"username":"tier.tester","tier":"desk","days":30,"requestId":"<id>"}'
```

`putSubscription()` in `functions/api/auth/_lib.ts` is the only writer of
`s:<userId>`. A member calling `/api/subscription/grant` gets `403`.

## KV keys

All keys live in the `AUTH` namespace and are prefixed, so sharing the
existing KV database (`a1776533b5cb4299accd800aac8d2256`) with the MCP worker
is safe:

```
u:<email>       user record (provider list, password hash)
un:<username>   username -> email index
s:<userId>      subscription { tier, status, startedAt, expiresAt }
sid:<token>     session record (TTL = cookie lifetime)
oauth:<state>   OAuth state, 10 minutes
rst:<token>     password-reset token, 30 minutes
rl:<key>        rate-limit counters
subreq:<id>     upgrade request, 180 days
subreqidx       list of upgrade-request ids the owner console reads
```

## Local testing

```powershell
npm run build
npx wrangler pages dev dist --port 8788 --ip 127.0.0.1
```

Open `http://127.0.0.1:8788/login`. The local KV is simulated in
`.wrangler/state`, so test accounts are not created in production.

`wrangler pages dev` has no `--var` flag; local-only values go in `.dev.vars`
(gitignored), which wrangler reads automatically:

```
OWNER_EMAILS=you@example.com
```

To exercise OAuth locally, add the local callback URL to the same OAuth app
(Google allows several; GitHub needs a second app) and put the client
id/secret in `.dev.vars` too.

## Production deployment

1. `functions/` and `wrangler.toml` must be in the repository that Cloudflare
   Pages builds. The config already declares:

   ```toml
   pages_build_output_dir = "dist"

   [[kv_namespaces]]
   binding = "AUTH"
   id = "a1776533b5cb4299accd800aac8d2256"
   ```

2. Deploy the built site plus functions:

   ```powershell
   npm run build
   npx wrangler pages deploy dist --project-name vaelor
   ```

   A git push to the Pages-connected branch also deploys, as long as the
   Pages project reads `wrangler.toml`.

3. Set the secrets (dashboard → Pages project → Settings → Environment
   variables, or `npx wrangler pages secret put <NAME> --project-name vaelor`):

   | Variable | Required | Purpose |
   | --- | --- | --- |
   | `GOOGLE_CLIENT_ID` | for Google | OAuth client id |
   | `GOOGLE_CLIENT_SECRET` | for Google | OAuth client secret |
   | `GITHUB_CLIENT_ID` | for GitHub | OAuth app client id |
   | `GITHUB_CLIENT_SECRET` | for GitHub | OAuth app client secret |
   | `OWNER_EMAILS` | recommended | Comma-separated addresses allowed into `/owner` and `/api/auth/admin-password` |
   | `PUBLIC_ORIGIN` | optional | `https://vaelor.pages.dev` (defaults to the request host) |
   | `RESEND_API_KEY` | optional | Enables emailed password-reset links |
   | `MAIL_FROM` | optional | Verified sender, e.g. `Vaelor Trading <no-reply@yourdomain>` |

4. Redeploy after changing variables — Pages only picks them up on a new
   deployment.

## Google sign-in

1. Go to <https://console.cloud.google.com/> → pick a project (or create one).
2. **Google Auth Platform → Branding**: app name, user support email, application
   home page, privacy policy and terms links, authorized domain (the site's
   registrable domain, e.g. `vaelor.pages.dev`), developer contact email.
3. **Google Auth Platform → Audience**: user type External. While the app is in
   *Testing* only listed test users can sign in (100-user lifetime cap). With
   only `openid email profile` scopes, **Publish app** moves it to *In
   production* without verification.
4. **Google Auth Platform → Clients → Create client**:
   - Application type: **Web application**
   - Authorised redirect URIs:
     - `https://vaelor.pages.dev/api/auth/oauth/google/callback`
     - `http://127.0.0.1:8788/api/auth/oauth/google/callback` (local testing)
5. Copy the client id/secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
6. `GET /api/auth/config` should now return `"google": true` and the button
   becomes active automatically.

## GitHub sign-in

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Homepage URL: `https://vaelor.pages.dev`
   Authorization callback URL:
   `https://vaelor.pages.dev/api/auth/oauth/github/callback`
3. **Generate a new client secret** — GitHub asks for sudo mode (2FA) first,
   and the secret is shown only once.
4. Copy the client id/secret into `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.
5. GitHub allows several callback URLs per app, but wildcards only match
   subdomains/paths of a listed URI. For local testing add
   `http://127.0.0.1:8788/api/auth/oauth/github/callback` to the same app.

An existing account is reused when the provider returns an email that already
exists, so a member can register with a password and later add Google/GitHub
to the same account.

## Password recovery without email

If `RESEND_API_KEY` is not configured the page says so honestly. The owner can
still reset a member:

```powershell
# signed in as an OWNER_EMAILS account
$body = '{"email":"member@example.com","password":"temporary-pass"}'
curl.exe -X POST https://vaelor.pages.dev/api/auth/admin-password `
  -H "content-type: application/json" `
  -b "vaelor_session=<owner cookie>" `
  -d $body
```

Members can change it afterwards from `/api/auth/password`.

## Security notes

- The browser never receives a password hash or session token; the cookie is
  `HttpOnly`.
- Login attempts are counted server-side: 8 per account and 40 per IP per 15
  minutes, 12 registrations per IP per hour, 6 reset requests per IP per hour.
- OAuth uses a single-use `state` value stored in KV for 10 minutes.
- `src/scripts/auth-client.ts` treats the server as authoritative: only an
  explicit `401` clears the local mirror, so a network outage cannot sign a
  paying member out.
- Client-side gating remains cosmetic. The real boundary is the bridge API,
  which validates its pairing token independently.
