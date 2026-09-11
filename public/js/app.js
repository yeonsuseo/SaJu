/**
 * 공통 UI 유틸리티 & 별 파티클 애니메이션
 */

// ══════════════════════════════════════════════════════════
// 별 파티클 캔버스
// ══════════════════════════════════════════════════════════

(function initStars() {
  const canvas = document.getElementById('stars-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  let stars = [];
  let shootingStars = [];
  let W, H;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
    createStars();
  }

  function createStars() {
    stars = [];
    const count = Math.floor((W * H) / 4000);
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 1.5 + 0.3,
        alpha: Math.random() * 0.8 + 0.2,
        speed: Math.random() * 0.3 + 0.05,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  function spawnShootingStar() {
    shootingStars.push({
      x: Math.random() * W,
      y: Math.random() * H * 0.5,
      vx: Math.random() * 3 + 2,
      vy: Math.random() * 2 + 1,
      length: Math.random() * 80 + 40,
      alpha: 1,
      life: 0,
      maxLife: 60,
    });
  }

  function drawStars(t) {
    ctx.clearRect(0, 0, W, H);

    stars.forEach(s => {
      const twinkle = 0.5 + 0.5 * Math.sin(t * s.speed + s.phase);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${s.alpha * twinkle})`;
      ctx.fill();
    });

    // 유성
    shootingStars.forEach((ss, i) => {
      ss.life++;
      ss.x += ss.vx;
      ss.y += ss.vy;
      ss.alpha = 1 - ss.life / ss.maxLife;

      const grad = ctx.createLinearGradient(ss.x, ss.y, ss.x - ss.length * 0.7, ss.y - ss.length * 0.35);
      grad.addColorStop(0, `rgba(255, 215, 0, ${ss.alpha})`);
      grad.addColorStop(1, 'rgba(255, 215, 0, 0)');

      ctx.beginPath();
      ctx.moveTo(ss.x, ss.y);
      ctx.lineTo(ss.x - ss.length * 0.7, ss.y - ss.length * 0.35);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (ss.life >= ss.maxLife) shootingStars.splice(i, 1);
    });
  }

  let frame = 0;
  function animate(ts) {
    frame++;
    if (frame % 180 === 0 && Math.random() < 0.6) spawnShootingStar();
    drawStars(ts * 0.001);
    requestAnimationFrame(animate);
  }

  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(animate);
})();

// ══════════════════════════════════════════════════════════
// 로딩 오버레이
// ══════════════════════════════════════════════════════════

function showLoading(show, text = '사주 기운 뜯어보는 중이다, 쫌만 기달리라...') {
  const overlay = document.getElementById('loadingOverlay');
  if (!overlay) return;
  const textEl = document.getElementById('loadingText');
  if (textEl) textEl.textContent = text;
  overlay.classList.toggle('show', show);
}

// ══════════════════════════════════════════════════════════
// 토스트 알림
// ══════════════════════════════════════════════════════════

let toastTimer = null;

function showToast(msg, duration = 2500) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

// ══════════════════════════════════════════════════════════
// 페이지 진입 애니메이션
// ══════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.fade-in').forEach((el, i) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    setTimeout(() => {
      el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    }, i * 80);
  });
});
