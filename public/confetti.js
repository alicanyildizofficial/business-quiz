'use strict';

/* Küçük konfeti — bağımlılık yok, tek canvas, iş bitince kendini durdurur. */
window.confettiBurst = (function () {
  const cv = document.getElementById('confetti');
  if (!cv) return function () {};
  const ctx = cv.getContext('2d');
  const COLORS = ['#2563ff', '#22d3a8', '#f5a524', '#e5484d', '#ffffff', '#6d5ef8'];
  let parts = [];
  let raf = null;

  function size() {
    cv.width = window.innerWidth;
    cv.height = window.innerHeight;
  }
  size();
  window.addEventListener('resize', size);

  function frame() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    let alive = 0;
    for (const p of parts) {
      if (p.life <= 0) continue;
      alive++;
      p.life -= 1;
      p.vy += 0.22;          // yerçekimi
      p.vx *= 0.995;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 40));
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (alive > 0) {
      raf = requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, cv.width, cv.height);
      parts = [];
      raf = null;
    }
  }

  return function burst(count) {
    const n = count || 90;
    const cx = cv.width / 2;
    const cy = cv.height * 0.42;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 4 + Math.random() * 9;
      parts.push({
        x: cx + (Math.random() - 0.5) * 80,
        y: cy + (Math.random() - 0.5) * 40,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 4,
        w: 6 + Math.random() * 6,
        h: 9 + Math.random() * 7,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        c: COLORS[(Math.random() * COLORS.length) | 0],
        life: 70 + Math.random() * 50,
      });
    }
    if (parts.length > 400) parts = parts.slice(-400);
    if (!raf) raf = requestAnimationFrame(frame);
  };
})();
