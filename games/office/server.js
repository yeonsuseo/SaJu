// 말풍선 광장: zero-dependency realtime server (GET polls the room, POST sends your state/actions).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const PORT = process.env.PORT || 8080;
const W = 3124, H = 2315, WALL = 160, CEIL = 260, MAX_PLAYERS = 100;
const RANGE = 520, HIT_R = 26, STONE_MS = 2500, POOP_MS = 60000, MAX_POOPS = 150;
const SNACK_EVERY = 3000, MAX_SNACKS = 50, REACH = 42;
// item kinds: 0-3 snacks (+1KG), 4 lunchbox (+5KG), 5 big lunchbox (+10KG), 6 baseball bat (10 swings), 7 TRG sniper rifle (10 shots)
const LUNCH = 4, BIG_LUNCH = 5, BAT = 6, RIFLE = 7;
const ITEM_KG = { [LUNCH]: 5, [BIG_LUNCH]: 10 };
const BAT_USES = 10, BAT_KG = -5, SWING_MS = 1500;
const RIFLE_SHOTS = 10, RIFLE_KG = -20, RIFLE_RANGE = 2600, SHOT_MS = 1500;
function pickKind(r) { // r in [0,1)
  if (r < 0.08) return RIFLE;
  if (r < 0.18) return BAT;
  if (r < 0.28) return BIG_LUNCH;
  if (r < 0.60) return LUNCH;
  return ((r - 0.60) / 0.40 * 4) | 0;
}
const COLORS = ['#ff7448', '#4f8cff', '#f2c230', '#b469e0', '#26b5a3', '#ff5c8a', '#7a5cff', '#e8833a'];
// room walls [x, y, w, h]; keep in sync with WALLS in index.html
// the south half is the north half mirrored across the drawer cabinet's centre line
const MID = 1157.5, flipY = y => 2 * MID - y;
const NORTH_WALLS = [
  [300, WALL, 12, 100], [300, 360, 12, 400], [300, 860, 12, 152], [0, 1000, 312, 12], // room A, doors y 260-360 / 760-860
  [1888, WALL, 12, 100], [1888, 360, 12, 400], [1888, 860, 12, 152], [1888, 1000, 312, 12], // room B
  ...[470, 760, 1050, 1340, 1630].map(px => [px - 4, 380, 8, 520]), // desk partitions
  [560, 1135, 1300, 45], // drawer cabinet
];
// east of the office (by the two plants): a corridor through the east wall to the big meeting room (중회의실); not mirrored
const EAST_WALLS = [
  [2200, WALL, 12, 1060 - WALL], [2200, 1255, 12, flipY(WALL) - 1255], // office east wall, opening y 1060-1255
  [2200, 1048, 824, 12], // corridor north side, straight on east to x 3024
  [2200, 1255, 180, 12], [2480, 1255, 544, 12], // corridor's right (south) side = the room's north wall, door x 2380-2480
  [3012, 1048, 12, 931], // corridor end + room east wall
  [2300, 1267, 12, 700], [2300, 1967, 724, 12], // room west / south
];
const WALLS = [...NORTH_WALLS, ...NORTH_WALLS.slice(0, -1).map(([x, y, w, h]) => [x, flipY(y + h), w, h]), ...EAST_WALLS]; // the cabinet (last) is shared
// where people can be (and items can appear): office, corridor, meeting room
const AREAS = [[0, WALL, 2200, flipY(WALL) - WALL], [2212, 1060, 800, 195], [2312, 1267, 700, 700]];
// every chair in the layout the page builds (desks, meeting tables, both halves, 중회의실); id = "x_y" of its home spot
const CHAIR_HOMES = (() => {
  const PARTS = [470, 760, 1050, 1340, 1630], ROW_Y = [500, 760];
  const SEATS = [['H', 'L0', 'R0', 'R1'], ['H', 'L0', 'R0', 'L1', 'R1'], ['H', 'R0'], ['H', 'L0', 'R0', 'R1'], ['H', 'L0', 'R0', 'L1', 'R1']];
  const north = [];
  SEATS.forEach((seats, i) => seats.forEach(c => north.push(c === 'H' ? [PARTS[i], 290] : [PARTS[i] + (c[0] === 'L' ? -92 : 92), ROW_Y[+c[1]]])));
  for (const x of [150, 2050]) { for (const y of [460, 560, 660, 760, 860]) north.push([x - 90, y], [x + 90, y]); north.push([x, 378], [x, 935]); }
  const all = [...north, ...north.map(([x, y]) => [x, flipY(y)])];
  for (const x of [2600, 2880]) for (let y = 1450; y < 1860; y += 100) all.push([x - 92, y], [x + 92, y]);
  return new Map(all.map(([x, y]) => [`${x}_${y}`, { x, y }]));
})();
const CHAIR_IDLE_MS = 180000, HURL_MS = 2500;
const inArea = (x, y) => AREAS.some(([ax, ay, aw, ah]) => x > ax + 20 && x < ax + aw - 20 && y > ay + 20 && y < ay + ah - 20);
const PAGE = path.join(__dirname, 'index.html'); // read per request so page edits need no restart
const PAGE_2D = path.join(__dirname, 'index2d.html'); // the old flat version, kept at /2d
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

// shortcut: sorts every saved profile on each poll, fine for a few thousand; cache it if the file gets huge
function ranking(me) {
  const rows = [...profiles].filter(([id, p]) => p.kg > 0 || players.has(id))
    .map(([id, p]) => ({ id, name: p.name, color: p.color, kg: p.kg || 0, online: players.has(id) }))
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
    x: Math.round(num(b.x, 0, W)), y: Math.round(num(b.y, 0, H)), z: Math.round(num(b.z, 0, 400)),
    f: b.f === -1 ? -1 : 1,
    ai: b.ai === 1 ? 1 : 0, a: +num(b.a, -4, 4).toFixed(2), // rifle aim: on/off and angle, so others see the laser
    ch: +num(b.ch, 0, 1).toFixed(2), // how far a held chair is wound up for a throw
    say: str(b.say, 80), sayAt: num(b.sayAt, 0, 9e15),
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
    if (id === byId || (!shot && p.z > 50)) continue;
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
    if (h <= 0) return { d, wall: 0 };
  }
  return { d: 3000, wall: 0 };
}
function takeNearest(list, p, reach = REACH) {
  let bi = -1, bd = reach;
  list.forEach((o, i) => { const d = Math.hypot(o.x - p.x, o.y - p.y); if (d < bd) { bd = d; bi = i; } });
  return bi < 0 ? null : list.splice(bi, 1)[0];
}

// how tall each wall is: desk partitions (8 wide) 73, the drawer cabinet (45 deep) 84, room walls up to the ceiling
const wallTop = w => w[2] === 8 ? 73 : w[3] === 45 ? 84 : CEIL;
const inWallBelow = (x, y, h, m) => WALLS.some(w => h < wallTop(w) && x > w[0] - m && x < w[0] + w[2] + m && y > w[1] - m && y < w[1] + w[3] + m);
const inWall = (x, y, m) => WALLS.some(([wx, wy, ww, wh]) => x > wx - m && x < wx + ww + m && y > wy - m && y < wy + wh + m);
// a bat hits everyone in front of the swinger within reach; bigger players reach further and are easier to hit
function swingBat(byId, from, tx, ty, others, kgOfId) {
  let dx = tx - from.x, dy = ty - from.y; const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
  const hits = [];
  for (const [id, p] of others) {
    if (id === byId || p.z > 50) continue;
    const vx = p.x - from.x, vy = p.y - from.y;
    if (vx * dx + vy * dy < -10) continue; // behind the swinger
    if (Math.hypot(vx, vy) < 45 + 20 * sizeOf(kgOfId(byId)) + 15 * sizeOf(kgOfId(id))) hits.push(id);
  }
  return { by: byId, x: from.x, y: from.y, dx: +dx.toFixed(3), dy: +dy.toFixed(3), hits };
}

function spawnSnack() {
  for (let i = 0; i < 10; i++) {
    const x = Math.round(40 + Math.random() * (W - 80)), y = Math.round(WALL + 40 + Math.random() * (H - 2 * WALL - 80));
    if (!inArea(x, y)) continue; // not in the closed-off space around the meeting room
    let k = pickKind(Math.random());
    if ((k === BAT || k === RIFLE) && snacks.filter(s => s.k === k).length >= 2) k = LUNCH; // at most two bats and two rifles lying around
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
  assert.strictEqual(CHAIR_HOMES.size, 108); assert(CHAIR_HOMES.has('470_290') && CHAIR_HOMES.has('1722_760') && CHAIR_HOMES.has('60_1855') && CHAIR_HOMES.has('2972_1850'), 'chair homes match the page');
  assert(wallReach({ x: 1765, y: 760 }, 0, -1, 600) < 590 && wallReach({ x: 1000, y: 1000 }, 0, 1, 600) < 140 && wallReach({ x: 1000, y: 1000 }, 1, 0, 300) === 300, 'chairs stop at the cabinet');
  assert(arcReach({ x: 1200, y: 1000 }, 0, -1, 50, 0, hurlV(1)).d < arcReach({ x: 1200, y: 1000 }, 0, -1, 50, 0.25, hurlV(1)).d, 'aiming up throws farther');
  assert(arcReach({ x: 1200, y: 1000 }, 0, -1, 50, 1.5, hurlV(1)).wall === 1, 'aiming very high hits the ceiling');
  assert(Math.abs(arcReach({ x: 1200, y: 1000 }, 0, -1, 30, 0.3, STONE_V).d - RANGE) < 40, 'a lobbed stone lands about RANGE away');
  assert(arcReach({ x: 1000, y: 1000 }, 0, 1, 120, 0.2, 40).d > 200 && arcReach({ x: 1000, y: 1000 }, 0, 1, 30, 0, 40).wall === 1, 'high throws clear the cabinet, low ones hit it');
  assert(hurlKg(0) === 10 && hurlKg(1) === 50 && hurlRange(1) > hurlRange(0));
  assert(inArea(2900, 1157) && inArea(2700, 1600) && !inArea(2700, 1000) && inWall(2205, 600, 0) && !inWall(2205, 1157, 0) && !inWall(2430, 1261, 0) && inWall(2600, 1261, 0) && inWall(3016, 1157, 0), 'corridor runs east, meeting room door on its right wall');
  const l = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 500, y: 0 }];
  assert.strictEqual(takeNearest(l, { x: 9, y: 0 }).x, 10); assert.strictEqual(l.length, 2);
  assert.strictEqual(takeNearest(l, { x: 300, y: 0 }), null);
  assert(inWall(306, 500, 0) && inWall(1050, 600, 0) && !inWall(306, 310, 0) && !inWall(1050, 1020, 0), 'walls block, doors open');
  assert(inWall(306, flipY(500), 0) && inWall(1050, flipY(600), 0) && !inWall(306, flipY(310), 0) && !inWall(1050, 1300, 0), 'mirrored half: walls block, doors open');
  const near = new Map([['a', { x: 0, y: 0, z: 0 }], ['f', { x: 60, y: 0, z: 0 }], ['b', { x: -60, y: 0, z: 0 }], ['far', { x: 300, y: 0, z: 0 }]]);
  assert.deepStrictEqual(swingBat('a', near.get('a'), 100, 0, near, () => 0).hits, ['f'], 'bat hits front only, within reach');
  assert.strictEqual(pickKind(0.01), RIFLE); assert.strictEqual(pickKind(0.1), BAT); assert.strictEqual(pickKind(0.2), BIG_LUNCH); assert.strictEqual(pickKind(0.5), LUNCH);
  assert([0, 1, 2, 3].includes(pickKind(0.99)) && pickKind(0.6) === 0);
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
    const ps = Object.fromEntries([...players].map(([pid, p]) => [pid, { ...p, kg: kgOf(pid), bat: bats.get(pid) || 0, rifle: rifles.get(pid) || 0 }]));
    const since = Number(url.searchParams.get('since')) || 0;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ you: id, myKg: kgOf(id), players: ps, poops, stones, swings, shots, snacks, chairs: [...chairs].map(([cid, c]) => ({ id: cid, ...c })), hurls, ranking: ranking(id), chat: chat.filter(m => m.id > since), chatEpoch, host: isHost(req) }));
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
      for (const h of s.hits) addKg(h, BAT_KG);
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
      if (s.hit) addKg(s.hit, -dmg);
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
      const s = { ...throwStone(id, me, me.x + ax / al * RIFLE_RANGE, me.y + ay / al * RIFLE_RANGE, players, RIFLE_RANGE, shot), h0: shot.h0, sl: shot.slope };
      if (s.hit) addKg(s.hit, RIFLE_KG);
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
      if (s.hit) addKg(s.hit, -1);
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
  const keep = [...profiles].filter(([, p]) => p.kg > 0); // nobody at 0KG needs remembering
  fs.writeFile(DATA + '.tmp', JSON.stringify({ profiles: Object.fromEntries(keep) }), err => {
    if (err) { dirty = true; return console.error('save failed', err); }
    fs.rename(DATA + '.tmp', DATA, e => { if (e) { dirty = true; console.error('save failed', e); } });
  });
}, 2000);

server.listen(PORT, () => console.log(`말풍선 광장: http://localhost:${PORT}`));
