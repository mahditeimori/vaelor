/**
 * Site-wide 0/1 rain layer.
 * A fixed canvas behind all page content (z-index: -1). It never fades out —
 * it persists from the top of the page to the very bottom.
 *
 * Reduced motion: draws a single static frame (no falling animation).
 */
export function mountMatrixBg(): void {
  if (document.querySelector('canvas[data-matrix-bg]')) return;

  const canvas = document.createElement('canvas');
  canvas.setAttribute('data-matrix-bg', '');
  canvas.className = 'bg-matrix';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const CELL = 16;
  let cols = 0;
  const drops: number[] = [];
  let lastDraw = 0;

  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let isReduced = reduced();

  function size(): void {
    canvas.width = Math.floor(window.innerWidth / 2);   // half-res: softer, cheaper
    canvas.height = Math.floor(window.innerHeight / 2);
    cols = Math.ceil(canvas.width / CELL);
    drops.length = 0;
    for (let i = 0; i < cols; i++) drops.push(Math.random() * -canvas.height);
    ctx!.font = '11px "JetBrains Mono", monospace';
    if (isReduced) drawStatic();
  }

  function pushColumn(x: number, y: number): void {
    // faint cherry trail + occasional gold head glyph
    if (Math.random() < 0.08) {
      ctx!.fillStyle = 'rgba(201, 162, 75, 0.55)';
    } else {
      ctx!.fillStyle = 'rgba(226, 69, 108, 0.42)';
    }
    ctx!.fillText(Math.random() < 0.5 ? '0' : '1', x, y % canvas.height);
  }

  function drawStatic(): void {
    ctx!.clearRect(0, 0, canvas.width, canvas.height);
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < 5; y++) {
        pushColumn(x * CELL, (drops[x] + y * CELL * 6) % canvas.height);
      }
    }
  }

  function tick(now: number): void {
    if (document.hidden) {
      requestAnimationFrame(tick);
      return;
    }
    if (isReduced !== reduced()) { // user toggled the OS setting
      isReduced = reduced();
      if (isReduced) drawStatic();
    }
    if (!isReduced && now - lastDraw >= 55) { // ~18fps: plenty for ambient rain
      lastDraw = now;
      ctx!.fillStyle = 'rgba(6, 3, 8, 0.16)';
      ctx!.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < cols; i++) {
        drops[i] += 2.2;
        pushColumn(i * CELL, drops[i]);
        if (drops[i] > canvas.height && Math.random() < 0.02) drops[i] = -Math.random() * 120;
      }
    }
    requestAnimationFrame(tick);
  }

  size();
  window.addEventListener('resize', size, { passive: true });
  requestAnimationFrame(tick);
}