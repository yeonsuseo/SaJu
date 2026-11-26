// 단풍숲: zero-dependency realtime server (GET polls the room, POST sends your state/actions).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const PORT = process.env.PORT || 8081;
const MAP = require('./map.js'); // the forest: trees, rocks and logs, shared with the page
const W = MAP.W, H = MAP.H, WALL = 0, CEIL = MAP.CEIL, MAX_PLAYERS = 100;
const RANGE = 520, HIT_R = 26, STONE_MS = 2500, POOP_MS = 60000, MAX_POOPS = 150;
const SNACK_EVERY = 667, MAX_SNACKS = 225, REACH = 42; // 1.5x the items: faster and more on the floor
// item kinds: 0-3 snacks (+1KG), 4 lunchbox (+5KG), 5 big lunchbox (+10KG), 6 baseball bat (10 swings), 7 TRG sniper rifle (10 shots)
const LUNCH = 4, BIG_LUNCH = 5, BAT = 6, RIFLE = 7, AR = 8; // 8: assault rifle (소총, 30 rounds, full auto)
const ITEM_KG = { [LUNCH]: 5, [BIG_LUNCH]: 10 };
const BAT_USES = 10, BAT_KG = -5, SWING_MS = 1500;
const RIFLE_SHOTS = 10, RIFLE_KG = -20, RIFLE_RANGE = Math.ceil(Math.hypot(W, H)), SHOT_MS = 1500; // no range limit: a bullet flies until it hits something or the cliffs
const AR_ROUNDS = 30, AR_KG = -2, AR_RANGE = RIFLE_RANGE, AR_GAP = 70; // the page fires every 110ms while the button is held
const DEAD_MS = 5000; // lying broken before being born again somewhere else
function pickKind(r) { // r in [0,1): out in the forest guns are common
  if (r < 0.22) return RIFLE;
  if (r < 0.55) return AR;
  if (r < 0.58) return BAT;
  if (r < 0.66) return BIG_LUNCH;
  if (r < 0.82) return LUNCH;
  return ((r - 0.82) / 0.18 * 4) | 0;
}
const ON_FLOOR_MAX = { [BAT]: 3, [RIFLE]: 22, [AR]: 37 }; // most of each lying around at once
const COLORS = ['#ff7448', '#4f8cff', '#f2c230', '#b469e0', '#26b5a3', '#ff5c8a', '#7a5cff', '#e8833a'];
// [x, y, w, d, top] from map.js; the whole forest is walkable; no chairs out here
const WALLS = MAP.WALLS, AREAS = [[0, 0, W, H]], CHAIR_HOMES = new Map();
const CHAIR_IDLE_MS = 180000, HURL_MS = 2500;
const inArea = (x, y) => AREAS.some(([ax, ay, aw, ah]) => x > ax + 20 && x < ax + aw - 20 && y > ay + 20 && y < ay + ah - 20);
const PAGE = path.join(__dirname, 'index.html'); // read per request so page edits need no restart
const MAPJS = path.join(__dirname, 'map.js'); const PAGE_2D = path.join(__dirname, 'index2d.html'); // the old flat version, kept at /2d
const DATA = path.join(__dirname, 'data.json');

const players = new Map(); // publicId -> sanitized state
const lastSeen = new Map(); // publicId -> last request time
const lastAct = new Map(); // publicId -> {kind: time}, for rate limits
// publicId -> {name, color, kg}; saved to data.json so weight and ranking survive refreshes and restarts
let profiles = new Map();
try {
  const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  profiles = new Map(Object.entries(d.profiles || {}));
  for (const [id, kg] of Object.entries(d.kg || {})) if (!profiles.has(id)) profiles.set(id, { name: '이름없음', color: COLORS[0], kg }); // older file format
} catch {}
let dirty = false;
let poops = [], stones = [], swings = [], shots = [], snacks = [], seq = 0;
const chairs = new Map(); // chair id -> {x, y, r, held, t}, only chairs that left their home spot
let hurls = []; // chair throws in flight
const ars = new Map(); // publicId -> assault-rifle rounds left (in memory, like the others)
const deaths = new Map(); // publicId -> when they died; they can't act or be hit until born again
const spawns = new Map(); // publicId -> {x, y, n}: where the page should put you after being born again (n changes each time)
const bats = new Map(); // publicId -> swings left (in memory; a restart takes bats away)
const rifles = new Map(); // publicId -> shots left (same)
let chat = [], chatSeq = Date.now(); // ids keep rising across restarts so clients' "since" stays valid
let chatEpoch = Date.now(); // changes when history is wiped, so clients drop their copy
const KICK_MS = 10 * 60 * 1000;
const banned = new Map(); // publicId -> banned-until; in memory, so a restart lets everyone back

// the host = someone on this PC at localhost; tunnel traffic always carries Cloudflare's cf-connecting-ip header
const isHost = req => !req.headers['cf-connecting-ip'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const MAX_CHAT = 200;

// the browser keeps a secret id; everyone else only ever sees its hash
const publicId = secret => crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
const kgOf = id => profiles.get(id)?.kg || 0;
const sizeOf = kg => 1 + kg * 0.012; // same growth as the page
const reachOf = id => REACH + 19 * (sizeOf(kgOf(id)) - 1); // big bodies reach further down to the floor
const addKg = (id, d) => { const p = profiles.get(id); if (p) { p.kg = Math.max(0, (p.kg || 0) + d); dirty = true; } };
// damage: weight off, and anyone knocked from above 0 down to 0KG dies (a fresh 0KG body can't drop any lower, so it can't die)
// one request at a time on one thread, so fast hits can't double-kill or skip the check
const SAFE_MS = 180000, safeUntil = new Map(); // the guide's shield only works this long after joining, so it can't be kept on
const shielded = id => players.get(id)?.safe === 1 && (safeUntil.get(id) || 0) > Date.now();
function hurt(id, kg, by) {
  if (deaths.has(id) || !players.has(id) || shielded(id)) return;
  const before = kgOf(id); addKg(id, -kg);
  if (before > 0 && kgOf(id) === 0) {
    deaths.set(id, Date.now()); bats.delete(id); rifles.delete(id); ars.delete(id);
    const dead = profiles.get(id), killer = by !== id && profiles.get(by); // the board's kills and deaths (saved with the weight)
    if (dead) dead.d = (dead.d || 0) + 1;
    if (killer) killer.k = (killer.k || 0) + 1;
    dirty = true;
  }
}

// shortcut: sorts every saved profile on each poll, fine for a few thousand; cache it if the file gets huge
function ranking(me) {
  const rows = [...profiles].filter(([id, p]) => p.kg > 0 || p.k || p.d || players.has(id))
    .map(([id, p]) => ({ id, name: p.name, color: p.color, kg: p.kg || 0, k: p.k || 0, d: p.d || 0, online: players.has(id) }))
    .sort((a, b) => b.kg - a.kg || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.rank = i + 1; });
  const top = rows.slice(0, 10), mine = rows.find(r => r.id === me);
  if (mine && mine.rank > 10) top.push(mine);
  return top;
}

// everything from clients is untrusted: clamp and trim
const str = (v, n) => typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').slice(0, n) : '';
const num = (v, lo, hi) => Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
function clean(b) {
  return {
    name: str(b.name, 12) || '이름없음',
    color: COLORS.includes(b.color) ? b.color : COLORS[0],
    x: Math.round(num(b.x, 0, W)), y: Math.round(num(b.y, 0, H)), z: Math.round(num(b.z, 0, 1500)), // absolute: the hills reach ~750
    f: b.f === -1 ? -1 : 1,
    ai: b.ai === 1 ? 1 : 0, a: +num(b.a, -4, 4).toFixed(2), // rifle aim: on/off and angle, so others see the laser
    ch: +num(b.ch, 0, 1).toFixed(2), // how far a held chair is wound up for a throw
    say: str(b.say, 80), sayAt: num(b.sayAt, 0, 9e15),
    safe: b.safe === 1 ? 1 : 0, // reading the welcome guide
  };
}

// first player on the straight path wins. Bigger players are wider targets (body radius 19 x size).
// A stone flies low, so jumping players dodge it; a bullet (shot = {h0, slope}) has a height along its flight
// and only hits a body it actually passes through, stopping at the floor or the ceiling.
function throwStone(byId, from, tx, ty, others, range = RANGE, shot = null, kgOfId = kgOf, pad = 0) {
  let dx = tx - from.x, dy = ty - from.y;
  let len = Math.min(range, Math.hypot(dx, dy)) || 1; const d = Math.hypot(dx, dy) || 1;
  dx /= d; dy /= d;
  if (shot && !shot.hAt && shot.slope < 0) len = Math.min(len, shot.h0 / -shot.slope);
  if (shot && !shot.hAt && shot.slope > 0) len = Math.min(len, (CEIL - shot.h0) / shot.slope);
  let hit = null, best = len;
  for (const [id, p] of others) {
    if (id === byId || deaths.has(id) || (!shot && p.z > 50)) continue;
    const t = (p.x - from.x) * dx + (p.y - from.y) * dy, sz = sizeOf(kgOfId(id));
    if (t < 0 || t > best) continue;
    if (shot) { const h = shot.hAt ? shot.hAt(t) : shot.h0 + shot.slope * t; if (h < p.z - 4 || h > p.z + 48 * sz + 4) continue; }
    if (Math.abs((p.y - from.y) * dx - (p.x - from.x) * dy) < HIT_R - 19 + 19 * sz + pad) { hit = id; best = t; }
  }
  return { by: byId, sx: from.x, sy: from.y, ex: Math.round(from.x + dx * best), ey: Math.round(from.y + dy * best), hit };
}

// removes and returns the nearest item within reach, or null
const chairAt = id => chairs.get(id) || { ...CHAIR_HOMES.get(id), r: null, held: null };
const chairHeldBy = pid => { for (const [id, c] of chairs) if (c.held === pid) return id; return null; };
// a spot a chair can rest on: walk back from (x, y) toward (fx, fy) until it's inside a room and clear of walls
function restSpot(x, y, fx, fy) {
  const d = Math.hypot(x - fx, y - fy) || 1;
  for (let k = 0; k <= d; k += 8) {
    const px = x + (fx - x) * k / d, py = y + (fy - y) * k / d;
    if (inArea(px, py) && !inWall(px, py, 18)) return { x: Math.round(px), y: Math.round(py) };
  }
  return { x: Math.round(fx), y: Math.round(fy) };
}
// chair throw: wound up p (0..1) -> 140..600 range, -10..-50KG
// how far something can fly from `from` along (ux, uy) before running into a wall
function wallReach(from, ux, uy, max) { // walls, and the outer walls (anything outside the rooms)
  for (let t = 20; t <= max; t += 8) { const x = from.x + ux * t, y = from.y + uy * t; if (inWall(x, y, 10) || !inArea(x, y)) return Math.max(0, t - 8); }
  return max;
}
const hurlRange = p => 140 + 460 * p, hurlKg = p => Math.round(10 + 40 * p);
// chair arc: launch speed from the wind-up, angle from where you aimed. Height after floor distance d:
// h(d) = h0 + sl*d - (1 + sl^2) d^2 / (2 v^2), with v = range/10 so a level throw from h0 = 50 lands at hurlRange
const hurlV = p => hurlRange(p) / 10;
const STONE_V = 28.3; // a lobbed hand throw (the page aims it a little up so the arc comes down on the crosshair)
const arcH = (h0, sl, v, d) => h0 + sl * d - (1 + sl * sl) * d * d / (2 * v * v);
// how far it gets: to the floor, or stopped by a wall / the ceiling (then it drops)
function arcReach(from, ux, uy, h0, sl, v) {
  for (let d = 8; d < 3000; d += 8) {
    const x = from.x + ux * d, y = from.y + uy * d, h = arcH(h0, sl, v, d);
    if (inWallBelow(x, y, h, 10) || !inArea(x, y)) return { d: Math.max(0, d - 8), wall: 1 }; // flies over low partitions and the cabinet
    if (h >= CEIL - 8) return { d, wall: 1 };
    if (h <= MAP.heightAt(x, y)) return { d, wall: 0 }; // landed on the hillside
  }
  return { d: 3000, wall: 0 };
}
// how far a bullet gets before a trunk, rock or log in its path
function shotReach(from, ux, uy, shot) {
  for (let d = 8; d < RIFLE_RANGE; d += 8) {
    const x = from.x + ux * d, y = from.y + uy * d, h = shot.h0 + shot.slope * d;
    if (inWallBelow(x, y, h, 2) || h < MAP.heightAt(x, y) || !inArea(x, y)) return d; // a trunk, rock or log, the hillside, or the cliffs at the edge
  }
  return RIFLE_RANGE;
}
function takeNearest(list, p, reach = REACH) {
  let bi = -1, bd = reach;
  list.forEach((o, i) => { const d = Math.hypot(o.x - p.x, o.y - p.y); if (d < bd) { bd = d; bi = i; } });
  return bi < 0 ? null : list.splice(bi, 1)[0];
}

// how tall each wall is: desk partitions (8 wide) 73, the drawer cabinet (45 deep) 84, room walls up to the ceiling
const wallTop = w => w[4];
// walls bucketed into 200-unit cells (padded by the largest margin anyone asks for, 40), so each check only looks at the few nearby
const CELL = 200, PAD = 40, wallGrid = new Map();
for (const w of WALLS) for (let cx = Math.floor((w[0] - PAD) / CELL); cx <= Math.floor((w[0] + w[2] + PAD) / CELL); cx++)
  for (let cy = Math.floor((w[1] - PAD) / CELL); cy <= Math.floor((w[1] + w[3] + PAD) / CELL); cy++) { const k = cx * 4096 + cy; if (!wallGrid.has(k)) wallGrid.set(k, []); wallGrid.get(k).push(w); }
const wallsNear = (x, y) => wallGrid.get(Math.floor(x / CELL) * 4096 + Math.floor(y / CELL)) || [];
const inWallBelow = (x, y, h, m) => wallsNear(x, y).some(w => h < wallTop(w) && x > w[0] - m && x < w[0] + w[2] + m && y > w[1] - m && y < w[1] + w[3] + m);
const inWall = (x, y, m) => wallsNear(x, y).some(([wx, wy, ww, wh]) => x > wx - m && x < wx + ww + m && y > wy - m && y < wy + wh + m);
// a bat hits everyone in front of the swinger within reach; bigger players reach further and are easier to hit
function swingBat(byId, from, tx, ty, others, kgOfId) {
  let dx = tx - from.x, dy = ty - from.y; const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
  const hits = [];
  for (const [id, p] of others) {
    if (id === byId || deaths.has(id) || p.z - MAP.heightAt(p.x, p.y) > 50) continue; // dead, or jumped over it
    const vx = p.x - from.x, vy = p.y - from.y;
    if (vx * dx + vy * dy < -10) continue; // behind the swinger
    if (Math.hypot(vx, vy) < 45 + 20 * sizeOf(kgOfId(byId)) + 15 * sizeOf(kgOfId(id))) hits.push(id);
  }
  return { by: byId, x: from.x, y: from.y, dx: +dx.toFixed(3), dy: +dy.toFixed(3), hits };
}

// a random clear spot anywhere in the forest, away from trunks, rocks and logs
function spawnSpot() {
  for (let i = 0; i < 50; i++) { const x = Math.round(150 + Math.random() * (W - 300)), y = Math.round(150 + Math.random() * (H - 300)); if (!inWall(x, y, 40)) return { x, y }; }
  return { x: Math.round(MAP.CX), y: Math.round(MAP.CY) };
}
function spawnSnack() {
  for (let i = 0; i < 10; i++) {
    const x = Math.round(40 + Math.random() * (W - 80)), y = Math.round(WALL + 40 + Math.random() * (H - 2 * WALL - 80));
    if (!inArea(x, y)) continue; // not in the closed-off space around the meeting room
    let k = pickKind(Math.random());
    if (ON_FLOOR_MAX[k] && snacks.filter(s => s.k === k).length >= ON_FLOOR_MAX[k]) k = LUNCH;
    if (!inWall(x, y, 24)) return snacks.push({ id: ++seq, x, y, k });
  }
}

{ // self-check
  const ps = new Map([['a', { x: 0, y: 0, z: 0 }], ['b', { x: 100, y: 5, z: 0 }], ['c', { x: 200, y: 0, z: 0 }], ['j', { x: 50, y: 0, z: 80 }]]);
  assert.strictEqual(throwStone('a', ps.get('a'), 400, 0, ps).hit, 'b');
  assert.strictEqual(throwStone('a', ps.get('a'), 0, 400, ps).hit, null);
  assert.strictEqual(throwStone('a', { x: -1000, y: 0 }, 400, 0, ps).hit, null, 'stones fall short');
  assert.strictEqual(throwStone('x', { x: -1000, y: 0 }, 400, 0, ps, RIFLE_RANGE).hit, 'a', 'bullets reach far');
  assert.strictEqual(throwStone('x', { x: -1000, y: 0 }, 400, 0, ps, RIFLE_RANGE, { h0: 34, slope: 0 }).hit, 'a', 'a level bullet hits the body');
  assert.strictEqual(throwStone('x', { x: -1000, y: 0 }, 400, 0, ps, RIFLE_RANGE, { h0: 34, slope: 0.1 }).hit, null, 'aimed high: over their head');
  assert.strictEqual(throwStone('x', { x: -1000, y: 0 }, 400, 0, ps, RIFLE_RANGE, { h0: 34, slope: -0.1 }).ex, -660, 'aimed low: into the floor');
  const far = new Map([['big', { x: 300, y: 90, z: 0 }]]);
  assert.strictEqual(throwStone('a', { x: 0, y: 0 }, 400, 0, far, RANGE, null, () => 500).hit, 'big', 'a big body is a big target');
  assert.strictEqual(throwStone('a', { x: 0, y: 0 }, 400, 0, far, RANGE, null, () => 0).hit, null);
  assert(MAP.trees.every(t => inWall(t.x, t.y, 0)), 'the wall grid finds every trunk');
  { const h0 = MAP.heightAt(MAP.CX, MAP.CY) + 34; let far = 0; for (let a = 0; a < 6.28; a += .01) far = Math.max(far, shotReach({ x: MAP.CX, y: MAP.CY }, Math.cos(a), Math.sin(a), { h0, slope: 0 }));
    assert(far > 2600, 'with no range limit some line of sight runs past the old 2600'); }
  const t0 = MAP.trees[0], r0 = MAP.rocks[0], r0top = r0.base + r0.top;
  assert(inWall(t0.x, t0.y, 0) && !inWall(MAP.CX, MAP.CY, 0) && inArea(MAP.CX, MAP.CY), 'trees block, the clearing is open');
  assert(inWallBelow(r0.x, r0.y, r0top - 5, 0) && !inWallBelow(r0.x, r0.y, r0top + 5, 0), 'over a rock, not through it');
  assert(shotReach({ x: t0.x - 100, y: t0.y }, 1, 0, { h0: t0.base + 34, slope: 0 }) < 100, 'trees stop bullets');
  assert(shotReach({ x: MAP.CX, y: MAP.CY }, 1, 0, { h0: MAP.heightAt(MAP.CX, MAP.CY) + 34, slope: -0.2 }) < 200, 'a bullet aimed down hits the ground');
  assert(hurlKg(0) === 10 && hurlKg(1) === 50 && hurlRange(1) > hurlRange(0));
  const l = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 500, y: 0 }];
  assert.strictEqual(takeNearest(l, { x: 9, y: 0 }).x, 10); assert.strictEqual(l.length, 2);
  assert.strictEqual(takeNearest(l, { x: 300, y: 0 }), null);
  const near = new Map([['a', { x: 0, y: 0, z: 0 }], ['f', { x: 60, y: 0, z: 0 }], ['b', { x: -60, y: 0, z: 0 }], ['far', { x: 300, y: 0, z: 0 }]]);
  assert.deepStrictEqual(swingBat('a', near.get('a'), 100, 0, near, () => 0).hits, ['f'], 'bat hits front only, within reach');
  assert.strictEqual(pickKind(0.01), RIFLE); assert.strictEqual(pickKind(0.3), AR); assert.strictEqual(pickKind(0.56), BAT); assert.strictEqual(pickKind(0.6), BIG_LUNCH); assert.strictEqual(pickKind(0.7), LUNCH);
  assert([0, 1, 2, 3].includes(pickKind(0.99)) && pickKind(0.83) === 0);
  { // rapid hits: weight drops step by step, death only on the hit that reaches 0, never twice; a fresh 0KG body can't die
    for (const [t, kg] of [['t1', 3], ['t2', 0]]) { profiles.set(t, { name: 't', color: COLORS[0], kg }); players.set(t, { x: 0, y: 0, z: 0 }); }
    hurt('t1', 2, 't2'); assert(kgOf('t1') === 1 && !deaths.has('t1'));
    hurt('t1', 2, 't2'); assert(kgOf('t1') === 0 && deaths.has('t1') && profiles.get('t1').d === 1 && profiles.get('t2').k === 1, 'kill and death counted');
    const t = deaths.get('t1'); hurt('t1', 2, 't2'); assert(deaths.get('t1') === t && profiles.get('t2').k === 1, 'no double death or kill');
    hurt('t2', 2); assert(!deaths.has('t2') && kgOf('t2') === 0, 'born at 0KG: not a death');
    profiles.get('t2').kg = 5; players.get('t2').safe = 1; safeUntil.set('t2', Date.now() + 1000); hurt('t2', 2); assert(kgOf('t2') === 5, 'shielded while reading the guide');
    safeUntil.set('t2', Date.now() - 1); hurt('t2', 2); assert(kgOf('t2') === 3, 'shield expires'); safeUntil.delete('t2');
    for (const t of ['t1', 't2']) { profiles.delete(t); players.delete(t); deaths.delete(t); } dirty = false;
  }
  assert.strictEqual(publicId('abc'), publicId('abc')); assert.notStrictEqual(publicId('abc'), 'abc');
}

function readJson(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 2048) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body)); } catch { cb(null); } });
}
function rateOk(id, kind, ms) {
  const a = lastAct.get(id) || {}; const now = Date.now();
  if (now - (a[kind] || 0) < ms) return false;
  a[kind] = now; lastAct.set(id, a); return true;
}
const done = (res, ok) => res.writeHead(ok ? 204 : 409).end();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && url.pathname === '/map.js') return fs.readFile(MAPJS, (err, js) => err ? res.writeHead(500).end() : res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }).end(js));
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/2d')) {
    return fs.readFile(url.pathname === '/2d' ? PAGE_2D : PAGE, (err, html) => {
      if (err) return res.writeHead(500).end();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    });
  }
  const secret = url.searchParams.get('id') || '';
  if (!/^[a-z0-9]{16,40}$/.test(secret)) return res.writeHead(400).end();
  const id = publicId(secret);
  if ((banned.get(id) || 0) > Date.now()) return res.writeHead(403).end(); // kicked: locked out of everything

  // polling instead of SSE: Cloudflare quick tunnels buffer event streams
  if (req.method === 'GET' && url.pathname === '/state') {
    lastSeen.set(id, Date.now());
    const ps = Object.fromEntries([...players].map(([pid, p]) => [pid, { ...p, kg: kgOf(pid), bat: bats.get(pid) || 0, rifle: rifles.get(pid) || 0, ar: ars.get(pid) || 0, dead: deaths.has(pid) ? 1 : 0 }]));
    const since = Number(url.searchParams.get('since')) || 0;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ you: id, myKg: kgOf(id), spawn: spawns.get(id) || null, players: ps, poops, stones, swings, shots, snacks, chairs: [...chairs].map(([cid, c]) => ({ id: cid, ...c })), hurls, ranking: ranking(id), chat: chat.filter(m => m.id > since), chatEpoch, host: isHost(req) }));
  }

  if (req.method === 'POST' && url.pathname === '/kick') {
    if (!isHost(req)) return res.writeHead(403).end();
    return readJson(req, b => {
      const target = str(b && b.target, 16), p = players.get(target);
      if (!p || target === id) return res.writeHead(400).end();
      banned.set(target, Date.now() + KICK_MS);
      players.delete(target); lastSeen.delete(target); bats.delete(target); rifles.delete(target);
      chat.push({ id: ++chatSeq, by: '', name: '알림', color: COLORS[0], text: `${p.name}님이 강퇴되었습니다`, t: Date.now() });
      done(res, true);
    });
  }

  if (req.method === 'POST' && url.pathname === '/clear-chat') { // anyone may wipe it, by request
    if (!rateOk(id, 'clear-chat', 2000)) return res.writeHead(429).end();
    chat = []; chatEpoch = Date.now();
    return done(res, true);
  }

  if (req.method === 'POST' && url.pathname === '/state') {
    if (!players.has(id) && players.size >= MAX_PLAYERS) return res.writeHead(503).end();
    return readJson(req, b => {
      if (!b) return res.writeHead(400).end();
      const p = clean(b), prof = profiles.get(id);
      if (!players.has(id)) safeUntil.set(id, Date.now() + SAFE_MS);
      players.set(id, p); lastSeen.set(id, Date.now());
      if (!prof) profiles.set(id, { name: p.name, color: p.color, kg: 0 });
      else if (prof.name !== p.name || prof.color !== p.color) { prof.name = p.name; prof.color = p.color; dirty = true; }
      res.writeHead(204).end();
    });
  }

  if (req.method === 'POST' && url.pathname === '/reset') {
    if (!rateOk(id, 'reset', 1000)) return res.writeHead(429).end();
    addKg(id, -Infinity);
    return done(res, true);
  }

  const me = players.get(id);
  if (req.method !== 'POST' || !me) return res.writeHead(404).end();
  if (deaths.has(id) && url.pathname !== '/say') return res.writeHead(409).end(); // the dead can still talk, nothing else

  if (url.pathname === '/poop') {
    if (!rateOk(id, 'poop', 800)) return res.writeHead(429).end();
    poops.push({ id: ++seq, x: me.x, y: me.y + 2, t: Date.now() });
    if (poops.length > MAX_POOPS) poops.shift();
    return done(res, true);
  }
  if (url.pathname === '/say') {
    return readJson(req, b => {
      const text = str(b && b.text, 80).trim();
      if (!text) return res.writeHead(400).end();
      if (!rateOk(id, 'say', 400)) return res.writeHead(429).end();
      chat.push({ id: ++chatSeq, by: id, name: me.name, color: me.color, text, t: Date.now() });
      if (chat.length > MAX_CHAT) chat.shift();
      done(res, true);
    });
  }
  if (url.pathname === '/clean') {
    if (!rateOk(id, 'clean', 200)) return res.writeHead(429).end();
    return done(res, takeNearest(poops, me, reachOf(id)));
  }
  if (url.pathname === '/eat') {
    if (!rateOk(id, 'eat', 200)) return res.writeHead(429).end();
    const ok = takeNearest(snacks, me, reachOf(id));
    if (ok && ok.k === BAT) bats.set(id, (bats.get(id) || 0) + BAT_USES); // picking up another one adds to what you have
    else if (ok && ok.k === RIFLE) rifles.set(id, (rifles.get(id) || 0) + RIFLE_SHOTS);
    else if (ok && ok.k === AR) ars.set(id, (ars.get(id) || 0) + AR_ROUNDS);
    else if (ok) addKg(id, ITEM_KG[ok.k] || 1);
    return done(res, ok);
  }
  if (url.pathname === '/swing') {
    return readJson(req, b => {
      if (!b) return res.writeHead(400).end();
      const left = bats.get(id) || 0;
      if (!left) return res.writeHead(409).end();
      if (!rateOk(id, 'swing', 450)) return res.writeHead(429).end();
      left > 1 ? bats.set(id, left - 1) : bats.delete(id);
      const s = swingBat(id, me, num(b.x, -W, 2 * W), num(b.y, -H, 2 * H), players, pid => kgOf(pid));
      for (const h of s.hits) hurt(h, -BAT_KG, id);
      swings.push({ id: ++seq, t: Date.now(), ...s });
      done(res, true);
    });
  }
  if (url.pathname === '/grab') { // X: pick up the chair next to you
    return readJson(req, b => {
      const cid = str(b && b.id, 20);
      if (!CHAIR_HOMES.has(cid)) return res.writeHead(400).end();
      if (!rateOk(id, 'grab', 250)) return res.writeHead(429).end();
      const c = chairAt(cid);
      if (c.held || chairHeldBy(id) || hurls.some(h => h.c === cid) || Math.hypot(c.x - me.x, c.y - me.y) > 60 + 19 * (sizeOf(kgOf(id)) - 1)) return res.writeHead(409).end();
      chairs.set(cid, { x: c.x, y: c.y, r: c.r, pose: 0, held: id, t: Date.now() });
      done(res, true);
    });
  }
  if (url.pathname === '/drop') { // X again: set it down in front of you
    const cid = chairHeldBy(id);
    if (!cid) return res.writeHead(409).end();
    const sz = sizeOf(kgOf(id)), spot = restSpot(me.x + Math.cos(me.a) * 30 * sz, me.y + Math.sin(me.a) * 30 * sz, me.x, me.y);
    chairs.set(cid, { ...spot, r: +(Math.PI / 2 - me.a).toFixed(2), pose: 0, held: null, t: Date.now() }); // set down standing
    return done(res, true);
  }
  if (url.pathname === '/hurl') { // release after winding up: the chair flies, lands, and costs whoever it hits 10-50KG
    return readJson(req, b => {
      if (!b) return res.writeHead(400).end();
      const cid = chairHeldBy(id);
      if (!cid) return res.writeHead(409).end();
      if (!rateOk(id, 'hurl', 400)) return res.writeHead(429).end();
      const pw = num(b.p, 0, 1), ax = num(b.x, -W, 2 * W) - me.x, ay = num(b.y, -H, 2 * H) - me.y, al = Math.hypot(ax, ay) || 1;
      const ux = ax / al, uy = ay / al, sl = +num(b.sl, -3, 3).toFixed(4), v = hurlV(pw), h0 = Math.round(me.z + 50 * sizeOf(kgOf(id)));
      const end = arcReach(me, ux, uy, h0, sl, v); // aim high: it flies higher and farther; aim low: it comes down sooner
      const s = throwStone(id, me, me.x + ux * end.d, me.y + uy * end.d, players, end.d, { hAt: d => arcH(h0, sl, v, d) }, kgOf, 12);
      const wall = !s.hit && end.wall ? 1 : 0;
      const dmg = hurlKg(pw);
      if (s.hit) hurt(s.hit, dmg, id);
      const back = s.hit ? 22 : wall ? 14 : 0, spot = restSpot(s.ex - ux * back, s.ey - uy * back, me.x, me.y);
      // it rarely lands standing: on either side, on its back or on its face (pose 1-4), upright only now and then (pose 0)
      const pose = Math.random() < .15 ? 0 : 1 + (Math.random() * 4 | 0);
      chairs.set(cid, { ...spot, r: +(Math.random() * 6.28).toFixed(2), pose, held: null, t: Date.now() });
      hurls.push({ id: ++seq, t: Date.now(), c: cid, p: +pw.toFixed(2), dmg, ...s, lx: spot.x, ly: spot.y, r: chairs.get(cid).r, pose, wall, h0, sl, v });
      done(res, true);
    });
  }
  if (url.pathname === '/shoot') { // TRG: a stone's hit test with the whole map as range
    return readJson(req, b => {
      if (!b) return res.writeHead(400).end();
      const left = rifles.get(id) || 0;
      if (!left) return res.writeHead(409).end();
      if (!rateOk(id, 'shoot', 700)) return res.writeHead(429).end();
      left > 1 ? rifles.set(id, left - 1) : rifles.delete(id);
      // a bullet doesn't stop where you aimed like a stone: carry the aim line out to full range
      const ax = num(b.x, -W, 2 * W) - me.x, ay = num(b.y, -H, 2 * H) - me.y, al = Math.hypot(ax, ay) || 1;
      // the bullet leaves at eye height and keeps the up/down angle you aimed with
      const shot = { h0: Math.round(me.z + 34.5 * sizeOf(kgOf(id))), slope: +num(b.sl, -3, 3).toFixed(4) };
      const reach = shotReach(me, ax / al, ay / al, shot);
      const s = { ...throwStone(id, me, me.x + ax / al * reach, me.y + ay / al * reach, players, reach, shot), h0: shot.h0, sl: shot.slope };
      if (s.hit) hurt(s.hit, -RIFLE_KG, id);
      shots.push({ id: ++seq, t: Date.now(), ...s });
      done(res, true);
    });
  }
  if (url.pathname === '/burst') { // assault rifle: one round per request, sent over and over while the button is held
    return readJson(req, b => {
      if (!b) return res.writeHead(400).end();
      const left = ars.get(id) || 0;
      if (!left) return res.writeHead(409).end();
      if (!rateOk(id, 'burst', AR_GAP)) return res.writeHead(429).end();
      left > 1 ? ars.set(id, left - 1) : ars.delete(id);
      const ax = num(b.x, -W, 2 * W) - me.x, ay = num(b.y, -H, 2 * H) - me.y, al = Math.hypot(ax, ay) || 1;
      const shot = { h0: Math.round(me.z + 34.5 * sizeOf(kgOf(id))), slope: +num(b.sl, -3, 3).toFixed(4) }; // from the gun at your chest
      const reach = Math.min(AR_RANGE, shotReach(me, ax / al, ay / al, shot));
      const s = { ...throwStone(id, me, me.x + ax / al * reach, me.y + ay / al * reach, players, reach, shot), h0: shot.h0, sl: shot.slope, ar: 1 };
      if (s.hit) hurt(s.hit, -AR_KG, id);
      shots.push({ id: ++seq, t: Date.now(), ...s });
      done(res, true);
    });
  }
  if (url.pathname === '/throw') {
    return readJson(req, b => {
      if (!b) return res.writeHead(400).end();
      if (!rateOk(id, 'throw', 350)) return res.writeHead(429).end();
      // thrown from the hand at the up/down angle you aimed: it can sail over heads, or end on the floor or ceiling
      // a real throw: leaves the hand at the up/down angle you aimed and curves down under gravity until it hits the floor,
      // a wall, the ceiling, or someone whose body it passes through
      const h0 = Math.round(me.z + 30 * sizeOf(kgOf(id))), sl = +num(b.sl, -3, 3).toFixed(4), v = STONE_V;
      const ax = num(b.x, -W, 2 * W) - me.x, ay = num(b.y, -H, 2 * H) - me.y, al = Math.hypot(ax, ay) || 1, ux = ax / al, uy = ay / al;
      const end = arcReach(me, ux, uy, h0, sl, v);
      const s = { ...throwStone(id, me, me.x + ux * end.d, me.y + uy * end.d, players, end.d, { hAt: d => arcH(h0, sl, v, d) }), h0, sl, v };
      if (s.hit) hurt(s.hit, 1, id);
      stones.push({ id: ++seq, t: Date.now(), ...s });
      done(res, true);
    });
  }

  res.writeHead(404).end();
});

// shortcut: everyone polls the whole room ~10x/s, fine for tens of players; move to WebSocket on a real host for more
setInterval(() => {
  const now = Date.now(), cutoff = now - 3000; // closed tab = stops polling = removed (weight is kept)
  for (const [id, t] of lastSeen) if (t < cutoff) { lastSeen.delete(id); players.delete(id); lastAct.delete(id); }
  for (const [id, until] of banned) if (until < now) banned.delete(id);
  for (const [id, t] of deaths) {
    if (!players.has(id)) { deaths.delete(id); continue; } // left while dead
    if (now - t < DEAD_MS) continue;
    deaths.delete(id);
    const at = spawnSpot(), p = players.get(id);
    p.x = at.x; p.y = at.y; p.z = Math.round(MAP.heightAt(at.x, at.y));
    spawns.set(id, { ...at, n: now });
  }
  for (const id of spawns.keys()) if (!players.has(id)) spawns.delete(id);
  stones = stones.filter(s => now - s.t < STONE_MS);
  swings = swings.filter(s => now - s.t < SWING_MS);
  shots = shots.filter(s => now - s.t < SHOT_MS);
  hurls = hurls.filter(h => now - h.t < HURL_MS);
  for (const [cid, c] of chairs) { // a holder who left drops it where it was; chairs left alone go home
    if (c.held && !players.has(c.held)) { c.held = null; c.t = now; }
    else if (!c.held && now - c.t > CHAIR_IDLE_MS) chairs.delete(cid);
  }
  poops = poops.filter(p => now - p.t < POOP_MS);
}, 500);
setInterval(() => { if (snacks.length < MAX_SNACKS) spawnSnack(); }, SNACK_EVERY);
setInterval(() => { // write-then-rename so a crash mid-save never corrupts the file
  if (!dirty) return;
  dirty = false;
  const keep = [...profiles].filter(([, p]) => p.kg > 0 || p.k || p.d); // nobody at 0KG without a kill or death needs remembering
  fs.writeFile(DATA + '.tmp', JSON.stringify({ profiles: Object.fromEntries(keep) }), err => {
    if (err) { dirty = true; return console.error('save failed', err); }
    fs.rename(DATA + '.tmp', DATA, e => { if (e) { dirty = true; console.error('save failed', e); } });
  });
}, 2000);

server.listen(PORT, () => console.log(`단풍숲: http://localhost:${PORT}`));
