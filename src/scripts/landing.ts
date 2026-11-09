export interface SearchEntry { label: string; href: string; keys: string }

export const SEARCH_INDEX: SearchEntry[] = [
  { label: 'Overview — Go to home', href: '/', keys: 'home overview landing start' },
  { label: 'Documentation Index', href: '/docs', keys: 'docs index manual' },
  { label: 'Operating Overview', href: '/docs/01-overview', keys: 'overview operating manual spec' },
  { label: 'Corporate Governance', href: '/docs/02-governance', keys: 'governance board company code' },
  { label: 'Operational Roles', href: '/docs/03-roles', keys: 'roles positions personnel' },
  { label: 'Workflows', href: '/docs/04-workflows', keys: 'workflows process flow' },
  { label: 'Market Structure', href: '/docs/05-market-structure', keys: 'market structure futures cot oi' },
  { label: 'Incident Response', href: '/docs/06-incident-response', keys: 'incident response anomaly freeze' },
  { label: 'Payload Library', href: '/docs/07-payload-library', keys: 'payload library messages' },
  { label: 'Configuration Hooks', href: '/docs/08-configuration', keys: 'configuration config hooks params' },
  { label: 'Company Code (JSON)', href: '/docs/company-code', keys: 'company code json structure departments roles' },
  { label: 'AI Layer — Published analysis (MCP)', href: '/#ai', keys: 'ai mcp publish analysis signals regime' },
  { label: 'Mock Dashboard', href: '/dashboard', keys: 'dashboard mock charts terminal signal' },
];

export function initLanding(): void {
  /* ---------- scroll reveals ---------- */
  const reveals = Array.from(document.querySelectorAll<HTMLElement>('.reveal'));
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('in'));
  }

  /* ---------- auto-hiding search dock ---------- */
  const dock = document.getElementById('searchDock');
  const input = document.getElementById('searchInput') as HTMLInputElement | null;
  const results = document.getElementById('searchResults');
  if (!dock || !input || !results) return;

  let hideTimer = 0;
  let open = false;

  const openDock = () => {
    open = true;
    dock.dataset['open'] = 'true';
    renderResults(input.value);
    window.clearTimeout(hideTimer);
  };
  const closeDock = (delay = 350) => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      open = false;
      dock.dataset['open'] = 'false';
      results.dataset['show'] = 'false';
    }, delay);
  };

  dock.addEventListener('mouseenter', () => { window.clearTimeout(hideTimer); openDock(); });
  dock.addEventListener('mouseleave', () => closeDock());
  input.addEventListener('focus', openDock);
  input.addEventListener('blur', () => closeDock(120));
  input.addEventListener('input', () => renderResults(input.value));
  results.addEventListener('mouseenter', () => window.clearTimeout(hideTimer));
  results.addEventListener('mouseleave', () => closeDock());

  results.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a');
    if (a) closeDock(0);
  });

  let active = -1;
  input.addEventListener('keydown', (e) => {
    const links = Array.from(results.querySelectorAll<HTMLAnchorElement>('a'));
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(links.length - 1, active + 1);
      mark(links, active);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(0, active - 1);
      mark(links, active);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (links[active]?.href) window.location.href = links[active].href;
    } else if (e.key === 'Escape') {
      input.blur();
      closeDock(0);
    }
  });

  function mark(links: HTMLAnchorElement[], idx: number): void {
    links.forEach((l, i) => l.setAttribute('aria-selected', String(i === idx)));
    links[idx]?.scrollIntoView({ block: 'nearest' });
  }

  function renderResults(qRaw: string): void {
    const q = qRaw.trim().toLowerCase();
    const hits = q
      ? SEARCH_INDEX
          .filter((s) => (s.label + ' ' + s.keys).toLowerCase().includes(q))
          .slice(0, 8)
      : SEARCH_INDEX.slice(0, 6);
    const seed = qRaw;
    results.innerHTML = hits
      .map((h, i) => {
        const label = highlight(h.label, q, seed);
        return `<a href="${h.href}" ${i === 0 ? 'aria-selected="true"' : ''}>${label}</a>`;
      })
      .join('');
    results.dataset['show'] = hits.length ? 'true' : 'true';
    active = hits.length ? 0 : -1;
    if (!hits.length) {
      results.innerHTML = '<div style="padding:12px;color:var(--text-faint);font-family:var(--mono);font-size:0.8rem">No matches — try “dashboard” or “risk”</div>';
    }
  }

  function highlight(label: string, q: string, raw: string): string {
    if (!q) return label;
    const i = label.toLowerCase().indexOf(q);
    if (i < 0) return label;
    return label.slice(0, i) + '<b>' + label.slice(i, i + q.length) + '</b>' + label.slice(i + q.length);
  }

  dock.dataset['open'] = 'false';
}