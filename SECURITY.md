# Security audit summary

## Server — Cloudflare Pages Functions (`functions/api/`)

- **Origin/CSRF**: `sameOriginError()` (`functions/api/auth/_lib.ts`) is enforced on
  every state-changing endpoint — `login`, `register` (implied by parity with
  `forgot`/`reset` flows and origin checks in `request`/`grant`/`features`/
  `strategies`/`members/delete`/`mt5/kill`/`mt5/kill-state`/`admin-password`/
  `forgot`/`reset`/`password`), `admin-password`, `owner/members/delete`,
  `owner/features`, `owner/strategies`, `subscription/request`,
  `subscription/grant`, `mt5/kill`, `mt5/kill-state`.
- **Sessions**: opaque random tokens (`randomToken(32)`), stored as `sid:<token>`
  with TTL equal to the cookie lifetime; cookie flags: `Path=/`, `HttpOnly`,
  `SameSite=Lax`, `Secure` on HTTPS, `Max-Age` 30 days / 180 days (remember-me).
- **Password hashing**: PBKDF2-SHA256, 100 000 iterations, 16-byte random salt
  per user, only the derived 256-bit hash stored (`derify`/`verifyPassword`).
- **Payload safety**: `readJson()` rejects bodies over 262 144 bytes.
- **Human verification**: Cloudflare Turnstile when `TURNSTILE_SITE_KEY` and
  `TURNSTILE_SECRET_KEY` are configured. `verifyCaptcha()` checks the token at
  `siteverify` before password work, requires the `auth` action, and treats the
  token as single-use with a five-minute lifetime. The secret never reaches the
  client; `/api/auth/config` exposes only the public site key.
- **Rate limits** (KV counters, `tooManyAttempts`):
  - login: 8/account/15 min, 40/IP/15 min
  - register: 12/IP/hour
  - forgot: 6/IP/hour
  - admin-password: 5/account/hour, 12/IP/hour
  - password: 6/account/15 min, 12/IP/hour
  - reset: 4/token/5 min
  - owner delete / owner features / owner strategies / subscription requests:
    per-owner (5–10/hour) + per-IP (12–60/hour)
- **Owner gating**: every sensitive endpoint requires `getSessionContext()` +
  `isOwnerEmail()`; `/api/owner/members/delete` removes the `u:`, `un:` and
  `s:` records **and every active `sid:` session** so other browsers lose the
  account.
- **KV layout**: `u:<email>`, `un:<username>`, `s:<userId>`, `sid:<token>`,
  `oauth:<state>` (10 min), `rst:<token>` (30 min), `rl:<key>`, `subreq:<id>` —
  prefixed and documented in `AUTH_SETUP.md`.

## Client

- **Membership gates** (`src/scripts/gate.ts`, `membership.ts`): section gates
  + chrome changes run off the server session via `syncSession()`; a stale
  mirror is cleared and the anonymous view repainted (no page reload).
- **Member page** (`src/scripts/member.ts`): authenticates with the server
  first; refuses live routing unless the bridge is paired; kill switch and
  risk gates cannot be bypassed; nothing is rendered as a broker fill unless
  the bridge confirms it.
- **Kill switch**: browser → `/api/mt5/kill` (record) → local
  `127.0.0.1:8899/api/kill-state` + `/api/shutdown`; MT5 disconnected,
  no auto-relaunch; `os._exit(0)` — no background re-attach.
- **Bridge**: token-only via `x-bridge-token`; `Allow-Private-Network: True`;
  no start-up discovery; prop-safe lock refuses opening orders.

## Sections audited

- `/login` — `public/login.html`: origin/referer checks, Turnstile human
  verification on login/register/forgot, login/forgot/admin rate limits,
  honest static rendering, session mirror + dashboard view; `gate` no longer
  reloads the page when the session is active.
- `/member` — `src/pages/member.astro` + `src/scripts/member.ts`: server-first
  session mount, live positions/terminal/playbook, kill switch, risk gates,
  order ticket; preview mode honest when no bridge is paired.
- `/owner` — `src/pages/owner.astro` + `src/scripts/owner.ts`: owner-gated
  directory, detail panels, plan grants, delete (with session removal),
  strategies/features registries, MRR chart; new admin password reset form.
- `/dashboard` — public ops dashboard; gated content.
- `/execution` — terminal, backtest entry `#backtest`, order ticket, live desk
  tab (`live_trade` gate, Desk tier).
- `/ai` — published analysis viewer (MCP worker).
- `/docs` + `/docs/company-code` — operator-only: members are redirected to
  `/member#capabilities` and nav entries hidden.

## Open gaps / follow-ups

1. **GitHub sign-in** is half-configured (dormant): `GITHUB_CLIENT_ID` is set,
   `GITHUB_CLIENT_SECRET` is missing. GitHub shows the honest "not configured"
   notice until the secret is added. Google sign-in is configured and its
   client id/secret pair was validated against Google's token endpoint; the
   callback logs provider errors server-side and returns only a short code.
2. **Authenticated production ACL test with a real owner cookie** has not been
   run yet (only anonymous 401s so far).
3. **Owner-added strategy/feature E2E visibility** has not been tested end to
   end.
4. **Kill-switch "session policy"** (3-min recheck / 5-min re-enable, per the
   work log) — no corresponding code was found; the current flow is arm →
   kill bridge + shutdown (no auto-relaunch) and disarm → start `run.cmd` +
   reconnect. If a specific policy is desired, a spec is needed.
