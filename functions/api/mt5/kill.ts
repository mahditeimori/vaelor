/**
 * POST /api/mt5/kill — per-member MT5-connection kill switch.
 *
 * While `k:<userId>` in the AUTH KV holds `{ enabled: true, at }`, the
 * member's bridge is told to disconnect from MetaTrader 5 (and switches to
 * the simulation broker). The bridge supervisor then enforces it: it keeps
 * the connection down and does not relaunch the terminal — no automatic
 * PowerShell popups from the site. Disabling asks the bridge to reconnect
 * to the last terminal.
 *
 * The bridge call is best-effort: the site record of the switch is the
 * source of truth, so an unreachable bridge never fails the toggle.
 */
import type { Handler } from '../auth/_lib';
import { fail, getSessionContext, json, readJson } from '../auth/_lib';

interface KillToggleRequest {
  enabled?: boolean;
  /** The member's bridge instance, from localStorage (`vaelor.bridge.pairing`). */
  pairing?: { url: string; token: string } | null;
}

function bridgePath(enabled: boolean): string {
  return enabled ? '/api/mt5/disconnect' : '/api/mt5/reconnect';
}

export const onRequestPost: Handler = async ({ request, env }) => {
  const context = await getSessionContext(request, env);
  if (!context) return fail(401, 'not_authenticated');

  const payload: KillToggleRequest = (await readJson<KillToggleRequest>(request)) ?? {};
  const enabled = payload.enabled === true;

  await env.AUTH.put(
    `k:${context.user.id}`,
    JSON.stringify({ enabled, at: Date.now() }),
    { expirationTtl: 30 * 86400 },
  );

  const pairing = payload.pairing ?? null;
  if (pairing?.url && pairing.token) {
    try {
      await fetch(`${pairing.url.replace(/\/+$/, '')}${bridgePath(enabled)}`, {
        method: 'POST',
        headers: { 'x-bridge-token': pairing.token },
      });
    } catch {
      // Best-effort: the supervisor sees `mt5_kill` and acts on it.
    }
  }

  return json({ ok: true, enabled });
};
