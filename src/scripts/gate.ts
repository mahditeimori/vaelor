/**
 * Page-level membership gate.
 *
 * Runs on every public page from BaseLayout. Three jobs:
 *
 *   1. Member chrome — when a session exists, hide the Documentation (and
 *      company-code) entry points and turn "Sign in" into "Member".
 *   2. Route guard — an authenticated member who opens /docs or
 *      /docs/company-code is sent to the member dashboard instead. Code and
 *      documentation are operator surfaces, hidden from every member.
 *   3. Section gates — any element marked `data-gate="feature_key"` gets a
 *      lock overlay when the signed-in member's tier does not include that
 *      feature. Clicking the overlay opens the upgrade dialog.
 *
 * Free-tier rules are centralised in `membership.ts`; this file never
 * hard-codes them.
 */
import {
  can,
  getCurrentUser,
  getTier,
  isMember,
  openFeatureLock,
  FEATURES,
  type FeatureKey,
} from './membership';

const DOC_PATHS = ['/docs', '/docs/', '/docs/company-code', '/docs/company-code/'];

function isDocPath(pathname: string): boolean {
  const clean = pathname.replace(/\/index\.html$/, '/');
  return clean === '/docs' || clean.startsWith('/docs/') || clean.startsWith('/company-code');
}

/** Swap the header's "Sign in" for the member entry point and hide docs. */
function applyMemberChrome(): void {
  if (!isMember()) return;

  // Every documentation and source entry point is operator-only: hide it in
  // the nav, the footer and any landing-page card.
  for (const link of Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/docs"], a[href*="company-code"]'),
  )) {
    link.hidden = true;
    link.setAttribute('aria-hidden', 'true');
  }

  for (const link of Array.from(document.querySelectorAll<HTMLAnchorElement>('a.nav-link'))) {
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('/login')) {
      link.href = '/member';
      link.textContent = 'Member';
      link.setAttribute('aria-current', location.pathname.startsWith('/member') ? 'page' : 'false');
    }
  }

  const brand = document.querySelector<HTMLAnchorElement>('header.site-header a.brand');
  if (brand && !document.getElementById('memberTierPill')) {
    const user = getCurrentUser();
    const tier = getTier();
    if (user?.username) {
      const pill = document.createElement('a');
      pill.id = 'memberTierPill';
      pill.href = '/member';
      pill.textContent = `${tier === 'subscriber' ? 'MEMBER' : 'FREE'} · @${user.username}`;
      pill.className = 'nav-link';
      pill.style.cssText =
        'margin-left:auto;border:1px solid rgba(225,29,72,0.35);border-radius:999px;padding:8px 14px;' +
        'font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:0.08em;text-decoration:none;white-space:nowrap';
      const nav = document.querySelector('header.site-header nav.nav-links');
      if (nav?.parentElement) nav.parentElement.insertBefore(pill, nav.nextSibling);
      else document.querySelector('header.site-header')?.appendChild(pill);
    }
  }
}

/** Members must never see code or documentation. */
function guardDocs(): void {
  if (!isMember()) return;
  if (!isDocPath(location.pathname)) return;
  location.replace('/member#capabilities');
}

/** Lock any element the current tier cannot use. */
function applySectionGates(): void {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-gate]'));
  if (!nodes.length) return;
  const signedIn = isMember();

  for (const node of nodes) {
    const key = node.dataset.gate as FeatureKey | undefined;
    if (!key || !FEATURES[key]) continue;
    const allowed = signedIn ? can(key) : false;
    if (allowed) {
      node.removeAttribute('data-locked');
      continue;
    }
    // Free visitors and free members both see a calm placeholder — never the
    // real numbers. Anonymous visitors get the same upgrade path.
    node.dataset.locked = 'true';
    node.style.position = node.style.position || 'relative';
    if (node.querySelector('.v-gate')) continue;

    const overlay = document.createElement('div');
    overlay.className = 'v-gate';
    overlay.style.cssText =
      'position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;gap:10px;' +
      'align-items:center;justify-content:center;text-align:center;padding:22px;' +
      'background:rgba(7,4,6,0.92);backdrop-filter:blur(4px);border-radius:inherit';

    const kicker = document.createElement('div');
    kicker.textContent = 'VAELOR · MEMBERSHIP';
    kicker.style.cssText =
      'font-family:"JetBrains Mono",monospace;font-size:10px;letter-spacing:0.22em;color:#e11d48';

    const title = document.createElement('div');
    title.textContent = FEATURES[key].label;
    title.style.cssText = 'font-family:"Playfair Display",serif;font-size:20px;color:#fff';

    const body = document.createElement('p');
    body.textContent = FEATURES[key].freeFallback;
    body.style.cssText = 'font-size:13px;line-height:1.6;color:#a89aa0;max-width:340px;margin:0';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = signedIn ? 'Upgrade membership' : 'Sign in to continue';
    btn.style.cssText =
      'margin-top:4px;padding:10px 18px;border-radius:10px;border:none;cursor:pointer;' +
      'background:linear-gradient(135deg,#e11d48,#be185d);color:#fff;font-size:12px;font-weight:600';
    btn.addEventListener('click', () => {
      if (!signedIn) {
        location.href = '/login.html';
        return;
      }
      openFeatureLock(key);
    });

    overlay.append(kicker, title, body, btn);
    node.appendChild(overlay);
    // Keep the gate visible above the section's own stacking context.
    if (getComputedStyle(node).position === 'static') node.style.position = 'relative';
  }
}

export function applyMemberGate(): void {
  if (typeof document === 'undefined') return;
  const run = (): void => {
    try {
      applyMemberChrome();
      guardDocs();
      applySectionGates();
    } catch (e) {
      console.warn('[membership] gate skipped:', e);
    }
  };
  // Loaded from <head>, so wait for the body to exist before gating it.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}
