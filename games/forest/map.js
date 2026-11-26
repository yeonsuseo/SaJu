// 단풍숲 layout, shared by server.js (require) and the page (<script src="map.js">): one seed, the same forest everywhere
// heights are absolute: heightAt(x, y) is the ground, and everything (people, throws, rock tops) is measured from 0
(function (root) {
  const W = 8000, H = 6000, CEIL = 3000, CX = W / 2, CY = H / 2; // open sky: CEIL is only a cap for throws and the camera
  let seed = 20261116;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  // rolling hills: smooth mounds (some outside the edge, so mountains ring the forest) plus a gentle ripple; the spawn clearing stays flat
  const bumps = Array.from({ length: 30 }, () => ({ x: -1500 + rnd() * (W + 3000), y: -1500 + rnd() * (H + 3000), r: 850 + rnd() * 1000, h: 70 + rnd() * 250 }));
  function rawHeight(x, y) {
    let h = 18 + 18 * Math.sin(x / 470 + 1.3) * Math.cos(y / 530);
    for (const b of bumps) { const q = ((x - b.x) ** 2 + (y - b.y) ** 2) / (b.r * b.r); if (q < 9) h += b.h * Math.exp(-q); }
    return h;
  }
  const mid = rawHeight(CX, CY);
  function heightAt(x, y) { // the clearing is levelled at its own height and blends out into the hills
    const k = Math.min(1, Math.max(0, (Math.hypot(x - CX, y - CY) - 350) / 900)), e = k * k * (3 - 2 * k);
    return Math.max(0, mid + (rawHeight(x, y) - mid) * e);
  }
  const trees = [], rocks = [], logs = [], all = [];
  // inside the map, out of the spawn clearing, and not on top of anything else
  const free = (x, y, r) => x > 80 + r && x < W - 80 - r && y > 80 + r && y < H - 80 - r && Math.hypot(x - CX, y - CY) > 380 + r && !all.some(o => Math.hypot(o.x - x, o.y - y) < o.r + r + 36);
  for (let i = 0; i < 260; i++) { // boulders: 40-80 above the ground, tall enough to hide behind, low enough to jump onto
    const x = rnd() * W, y = rnd() * H, w = 50 + rnd() * 80, d = 50 + rnd() * 80, top = 40 + rnd() * 40, r = Math.max(w, d) * .6;
    if (free(x, y, r)) { const o = { x, y, r, w, d, top, base: heightAt(x, y) }; rocks.push(o); all.push(o); }
  }
  for (let i = 0; i < 200; i++) { // fallen logs, lying east-west or north-south
    const x = rnd() * W, y = rnd() * H, len = 150 + rnd() * 150, th = 30 + rnd() * 10, ns = rnd() < .5, r = len / 2;
    if (free(x, y, r)) { const o = { x, y, r, w: ns ? th : len, d: ns ? len : th, top: th, ns, base: heightAt(x, y) }; logs.push(o); all.push(o); }
  }
  for (let gx = 0; gx < W; gx += 170) for (let gy = 0; gy < H; gy += 170) {
    const on = rnd() < .75, x = gx + rnd() * 170, y = gy + rnd() * 170, r = 10 + rnd() * 9, h = 300 + rnd() * 200, c = rnd();
    if (on && free(x, y, r)) { const t = { x, y, r, h, c, base: heightAt(x, y) }; trees.push(t); all.push(t); }
  }
  const R = Math.round;
  // [x, y, w, d, top]: trunks reach the sky, rocks and logs stop throws and bullets below their (absolute) top
  const WALLS = [...trees.map(t => [R(t.x - t.r), R(t.y - t.r), R(2 * t.r), R(2 * t.r), CEIL]),
    ...[...rocks, ...logs].map(o => [R(o.x - o.w / 2), R(o.y - o.d / 2), R(o.w), R(o.d), R(o.base + o.top)])];
  const map = { W, H, CEIL, CX, CY, trees, rocks, logs, WALLS, heightAt };
  if (typeof module !== 'undefined') module.exports = map; else root.FOREST = map;
})(this);
