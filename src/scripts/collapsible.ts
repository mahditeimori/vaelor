/**
 * Reusable collapsible rails (sidebar / quick bars).
 *
 * Any element with [data-collapsible] becomes a collapsible rail. Place a
 * button with [data-collapse-toggle] inside it. Clicking toggles the class
 * `is-collapsed` on the rail, updates aria-expanded, and remembers the choice
 * in localStorage so it survives navigation and reloads.
 *
 * Text that should disappear when collapsed must carry `.collapse-label`.
 * Icons (and the toggle button) stay visible.
 */

const storageKey = (id: string) => `vaeor:collapsed:${id}`;

function readState(id: string): boolean {
  try {
    return localStorage.getItem(storageKey(id)) === '1';
  } catch {
    return false;
  }
}

function writeState(id: string, collapsed: boolean): void {
  try {
    localStorage.setItem(storageKey(id), collapsed ? '1' : '0');
  } catch {
    /* storage may be blocked — UI still works for this session */
  }
}

export function mountCollapsibles(): void {
  if (typeof document === 'undefined') return;

  const rails = Array.from(document.querySelectorAll<HTMLElement>('[data-collapsible]'));
  for (const rail of rails) {
    if (rail.dataset.collapsibleBound === '1') continue;
    rail.dataset.collapsibleBound = '1';

    const toggle = rail.querySelector<HTMLElement>('[data-collapse-toggle]');
    if (!toggle) continue;

    const id = rail.dataset.collapsible || rail.id || 'rail';
    let collapsed = readState(id);

    const apply = (next: boolean): void => {
      collapsed = next;
      rail.classList.toggle('is-collapsed', next);
      toggle.setAttribute('aria-expanded', String(!next));
      toggle.setAttribute('aria-label', next ? 'Expand panel' : 'Collapse panel');
      toggle.setAttribute('title', next ? 'Expand' : 'Collapse');
    };

    apply(collapsed);

    toggle.addEventListener('click', () => {
      apply(!collapsed);
      writeState(id, collapsed);
      window.dispatchEvent(new CustomEvent('vaelor:collapse', {
        detail: { id, collapsed },
      }));
    });
  }
}
