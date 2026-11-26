// 야구장: zero-dependency realtime baseball server (GET /state polls, POSTs send actions). `node server.js --test` runs the self-check.
// One pitcher and one batter at a time, from two queues; batters rotate after every plate appearance, pitchers every half inning.
// Hits, outs and fouls come from contact quality (timing + how close the swing line was) rolled against probabilities.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const PORT = process.env.PORT || 8082;
const PAGE = path.join(__dirname, 'index.html'); // read per request so page edits need no restart
const WINDUP_MS = 1200;   // pitch accepted -> ball leaves the hand (the windup plays meanwhile)
const SLOW = 2.2;         // flight time vs real life, so humans over the internet can hit it
const SWING_LAG = 150;    // D pressed -> bat reaches the plate (keep in sync with CONTACT_T in index.html)
const TIMING_WIN = 110, LINE_WIN = 0.16; // ms early/late and metres off the swing line that still make contact
const GONE_MS = 6000, OVER_MS = 20000;
// brk = how far it moves at full power [x, y] (m) for a right-hander, loft = extra arc height,
// bp = how late it breaks (the break grows like u^bp along the flight: higher = sharper, later)
const PITCHES = {
  FB: { name: '직구', kmh: [140, 158], brk: [0, 0.08], loft: 0.03, bp: 2 },
  CU: { name: '커브', kmh: [98, 116], brk: [0.42, -1.12], loft: 0.5, bp: 2.4 },
  SL: { name: '슬라이더', kmh: [120, 138], brk: [0.7, -0.3], loft: 0.12, bp: 3 },
  CH: { name: '체인지업', kmh: [106, 122], brk: [-0.36, -0.64], loft: 0.16, bp: 2.7 },
  FK: { name: '포크', kmh: [116, 134], brk: [0, -1.0], loft: 0.1, bp: 3.2 },
};
// characters (keep names/order in sync with CHARS in index.html)
// batters: pw = exit velocity, acc = swing-line tolerance, tim = timing window, spd = bunt and infield hits
const BAT_CHARS = [
  { name: '강타왕 곰', pw: 1.12, acc: 0.85, tim: 0.85, spd: 0.8 },
  { name: '정확한 여우', pw: 0.97, acc: 1.25, tim: 1.2, spd: 1.0 },
  { name: '번개 치타', pw: 0.9, acc: 1.05, tim: 1.05, spd: 1.45 },
];
// pitchers: vel = speed, ctl = scatter (lower = more accurate), brk = break, stuff = how hard it is to square up
const PIT_CHARS = [
  { name: '파이어볼러', vel: 1.06, ctl: 1.3, brk: 0.85, stuff: 1.2 },
  { name: '제구 마스터', vel: 0.97, ctl: 0.6, brk: 1.0, stuff: 1.0 },
  { name: '변화구 마법사', vel: 0.95, ctl: 0.9, brk: 1.35, stuff: 1.03 },
];
const ZONE = { x: 0.215 + 0.037, y0: 0.48, y1: 1.07 }; // plate half-width + ball radius; knees to chest
const RELEASE = [-0.55, 1.85, -16.9];
const HBP_X = 0.56; // a batter stands 0.85 m from the middle of the plate; his front edge is about here

// id -> {name, seen, bat, pit, hand, team: 0 away | 1 home | null, pos: 'batter'|'pitcher', ready, inGame, req (asked to join a running game), watch}
const players = new Map();
let batters = [], pitchers = []; // derived every tick: [0] is up, then who follows
// lineup[0] = away, lineup[1] = home: who is in the game, in batting order. The batting team's batters bat in turn and the
// fielding team's pitchers take one half inning each; a team with nobody in that position uses its other players, an empty team the AI.
const lineup = [[], []], batIdx = [0, 0], onMound = [0, 0];
const events = []; let evSeq = 0; // "x joined", "x wants in" ... shown as toasts
const chat = []; let chatSeq = 0; // the last 30 lines
function note(text) { events.push({ seq: ++evSeq, text }); if (events.length > 20) events.shift(); }
let g, rec;
function newGame() {
  g = {
    inning: 1, half: 0, outs: 0, balls: 0, strikes: 0, bases: [null, null, null], score: [0, 0], line: [[0], []], hits: [0, 0], errs: [0, 0],
    phase: 'idle', started: false, pitch: null, swing: null, result: null, until: 0, overAt: 0, seq: 0, msg: '',
    ai: { bat: Math.random() * 3 | 0, pit: Math.random() * 3 | 0 }, // the AI players' characters this game
  };
  rec = { bat: {}, pit: {} };
  // back to the waiting room: picks stay, everyone readies up again
  lineup[0] = []; lineup[1] = []; batIdx.fill(0); onMound.fill(0); batters = []; pitchers = [];
  for (const p of players.values()) Object.assign(p, { ready: false, inGame: false, req: false });
}
function startGame() {
  for (const [id, p] of players) if (p.ready && !p.watch && p.team != null) { p.inGame = true; lineup[p.team].push(id); }
  g.started = true; g.phase = 'ready'; note('경기 시작! ⚾');
}
newGame();

// a player's characters and hand ('R' | 'L'); the AI is right-handed
const look = id => { const p = players.get(id); return p ? { bat: p.bat ?? 1, pit: p.pit ?? 1, hand: p.hand || 'R' } : { bat: g.ai.bat, pit: g.ai.pit, hand: 'R' }; };
const nameOf = id => AI_NAMES[id] || players.get(id)?.name || rec.bat[id]?.name || rec.pit[id]?.name || '?';
const batStat = id => rec.bat[id] ||= { name: nameOf(id), PA: 0, AB: 0, H: 0, D: 0, T: 0, HR: 0, RBI: 0, R: 0, BB: 0, HBP: 0, SO: 0 };
const pitStat = id => rec.pit[id] ||= { name: nameOf(id), NP: 0, K: 0, outs: 0, H: 0, R: 0, BB: 0, HBP: 0, HR: 0 };

function scoreRun(runner, cur) {
  g.score[g.half]++; g.line[g.half][g.inning - 1]++;
  batStat(runner.id).R++; pitStat(cur.p).R++;
  if (cur.rbi) batStat(cur.b).RBI++;
}
// hit of n bases: everyone moves n, batter ends on base n (4 = home)
function advance(n, cur, moves) {
  for (let b = 2; b >= 0; b--) {
    const r = g.bases[b]; if (!r) continue;
    g.bases[b] = null; const to = b + 1 + n;
    moves.push({ name: r.name, from: b + 1, to: Math.min(4, to) });
    if (to >= 4) scoreRun(r, cur); else g.bases[to - 1] = r;
  }
  const me = { id: cur.b, name: nameOf(cur.b) };
  moves.push({ name: me.name, from: 0, to: n });
  if (n >= 4) scoreRun(me, cur); else g.bases[n - 1] = me;
}
function walk(cur, moves) {
  const [a, b, c] = g.bases;
  if (a) { if (b) { if (c) { scoreRun(c, cur); moves.push({ name: c.name, from: 3, to: 4 }); } g.bases[2] = b; moves.push({ name: b.name, from: 2, to: 3 }); } g.bases[1] = a; moves.push({ name: a.name, from: 1, to: 2 }); }
  g.bases[0] = { id: cur.b, name: nameOf(cur.b) }; moves.push({ name: nameOf(cur.b), from: 0, to: 1 });
}
function out(n, cur) {
  g.outs += n; pitStat(cur.p).outs += n;
  if (g.outs >= 3) endHalf();
}
function endHalf() {
  g.outs = 0; g.balls = 0; g.strikes = 0; g.bases = [null, null, null];
  if ((g.half === 0 && g.inning === 9 && g.score[1] > g.score[0]) || (g.half === 1 && g.inning >= 9)) return gameOver();
  g.msg = '공수교대';
  if (g.half === 1) { g.inning++; g.half = 0; } else g.half = 1;
  g.line[g.half][g.inning - 1] = 0;
  onMound[g.half]++; // the team now batting just pitched: its next pitcher takes its next half
}
function gameOver() { g.over = true; g.msg = g.score[0] === g.score[1] ? '무승부!' : g.score[0] > g.score[1] ? '원정팀 승리!' : '홈팀 승리!'; }

// applies one outcome to the count/bases/score/records. kind: ball|strike|miss|foul|GO|FO|LO|PO|1B|2B|3B|HR
function settle(kind, cur, rnd = Math.random) {
  const B = batStat(cur.b), P = pitStat(cur.p), moves = [];
  let text = '', endPA = true;
  P.NP++;
  cur.rbi = true;
  if (cur.play) return settlePlay(kind, cur, B, P);
  if (kind === 'ball') {
    if (++g.balls < 4) { text = '볼'; endPA = false; }
    else { text = '볼넷!'; B.PA++; B.BB++; P.BB++; walk(cur, moves); }
  } else if (kind === 'HBP') {
    text = '몸에 맞는 공!'; B.PA++; B.HBP++; P.HBP++; walk(cur, moves);
  } else if (kind === 'strike' || kind === 'miss') {
    if (++g.strikes < 3) { text = kind === 'miss' ? '헛스윙!' : '스트라이크!'; endPA = false; }
    else { text = '삼진 아웃!'; B.PA++; B.AB++; B.SO++; P.K++; out(1, cur); }
  } else if (kind === 'foul') {
    if (g.strikes < 2) g.strikes++;
    text = '파울!'; endPA = false;
  } else if (kind === 'GO') {
    B.PA++; B.AB++;
    if (g.bases[0] && g.outs < 2 && rnd() < 0.45) { // double play: runner from first and the batter
      text = '병살타!'; g.bases[0] = null;
      if (g.outs + 2 < 3) for (const b of [2, 1]) if (g.bases[b - 1] && !g.bases[b]) { // others move up one
        const r = g.bases[b - 1]; g.bases[b - 1] = null; cur.rbi = false;
        if (b === 2) { scoreRun(r, cur); moves.push({ name: r.name, from: 3, to: 4 }); } else { g.bases[b] = r; moves.push({ name: r.name, from: 2, to: 3 }); }
      }
      moves.push({ name: nameOf(cur.b), from: 0, to: 1, out: true });
      out(2, cur);
    } else {
      text = '땅볼 아웃';
      if (g.outs + 1 < 3) for (let b = 2; b >= 0; b--) { // productive out: runners move up one
        const r = g.bases[b]; if (!r) continue; g.bases[b] = null;
        moves.push({ name: r.name, from: b + 1, to: b + 2 });
        if (b === 2) scoreRun(r, cur); else g.bases[b + 1] = r;
      }
      moves.push({ name: nameOf(cur.b), from: 0, to: 1, out: true });
      out(1, cur);
    }
  } else if (kind === 'SAC') { // bunt fielded and thrown to first: runners move up, batter out
    B.PA++; text = g.bases.some(Boolean) && g.outs < 2 ? '희생번트 성공!' : '번트 아웃';
    if (text === '번트 아웃') B.AB++;
    if (g.outs + 1 < 3) for (let b = 2; b >= 0; b--) {
      const r = g.bases[b]; if (!r) continue; g.bases[b] = null;
      moves.push({ name: r.name, from: b + 1, to: b + 2 });
      if (b === 2) scoreRun(r, cur); else g.bases[b + 1] = r;
    }
    moves.push({ name: nameOf(cur.b), from: 0, to: 1, out: true });
    out(1, cur);
  } else if (kind === 'FO' || kind === 'LO' || kind === 'PO') {
    B.PA++;
    text = { FO: '플라이 아웃', LO: '라인드라이브 아웃', PO: '팝플라이 아웃' }[kind];
    if (kind === 'FO' && g.bases[2] && g.outs < 2 && rnd() < 0.6) { // sacrifice fly: no at-bat
      const r = g.bases[2]; g.bases[2] = null; scoreRun(r, cur); moves.push({ name: r.name, from: 3, to: 4 });
      text = '희생플라이!';
    } else B.AB++;
    out(1, cur);
  } else { // hits
    const n = { '1B': 1, '2B': 2, '3B': 3, HR: 4 }[kind];
    B.PA++; B.AB++; B.H++; P.H++; g.hits[g.half]++;
    if (n === 2) B.D++; if (n === 3) B.T++; if (n === 4) { B.HR++; P.HR++; }
    text = { 1: '안타!', 2: '2루타!!', 3: '3루타!!', 4: '홈런!!!' }[n];
    advance(n, cur, moves);
  }
  if (endPA) { g.balls = 0; g.strikes = 0; }
  if (g.half === 1 && g.inning >= 9 && g.score[1] > g.score[0] && !g.over) { gameOver(); g.msg = '끝내기! ' + g.msg; }
  return { kind, text, moves, endPA };
}

// a ball in play run by runPlay: the box score follows what happened on the field
const BASE_KO = ['홈', '1루', '2루', '3루', '홈'];
function settlePlay(kind, cur, B, P) {
  const pl = cur.play, bat = pl.runs.find(r => r.from === 0), outsAfter = g.outs + pl.made;
  const scored = pl.runs.filter(r => pl.scored.includes(r.id));
  const adv = pl.runs.some(r => r.from > 0 && r.to > r.from && !r.out);
  const err = pl.errs.length > 0, errText = pl.errs.map(e => e + ' 실책').join(' · ');
  const safe = bat && (!bat.out || bat.to > 1); // reached first (even if thrown out going for more)
  const fly = ['FO', 'LO', 'PO'].includes(kind);
  let text, k = kind, ab = true;
  B.PA++;
  if (pl.catch) {
    text = { FO: '플라이 아웃', LO: '라인드라이브 아웃', PO: '팝플라이 아웃' }[kind];
    if (kind === 'FO' && scored.length) { text = '희생플라이!'; ab = false; }
  } else if (safe && (fly || ((kind === 'GO' || kind === 'SAC') && err && !pl.made))) { k = 'E'; text = errText + '으로 출루!'; } // he'd have been out without the error
  else if (safe && pl.made && kind !== '1B' && !(bat.out && bat.to > 1)) { k = 'FC'; text = '야수 선택'; } // on a hit through the infield it stays a hit even if a runner is thrown out
  else if (safe) { // a hit: the bases he made cleanly (an error, or being thrown out going for more, doesn't add to it)
    const n = kind === '1B' && !err ? (bat.out ? bat.to - 1 : bat.to) : 1;
    k = ['1B', '2B', '3B'][n - 1]; B.H++; P.H++; g.hits[g.half]++; if (n === 2) B.D++; if (n === 3) B.T++;
    text = cur.bunt ? '번트 안타!' : kind === 'GO' || pl.dive ? '내야 안타!' : { 1: '안타!', 2: '2루타!!', 3: '3루타!!' }[n];
    if (bat.out) text += ` 하지만 ${BASE_KO[bat.to]}에서 태그 아웃`;
  } else if (cur.bunt || kind === 'SAC') { k = 'SAC'; ab = !(adv && pl.made === 1); text = ab ? '번트 아웃' : '희생번트 성공!'; }
  else { k = 'GO'; text = (pl.dive ? '다이빙 캐치! ' : '') + (pl.made >= 2 ? '병살타!' : '땅볼 아웃'); }
  if (err && k !== 'E') text += ' + ' + errText;
  for (const r of pl.runs) if (r.out && r.tag && r.from > 0) text += ` · ${r.name} ${BASE_KO[r.to]}에서 태그 아웃`;
  if (ab) B.AB++;
  g.errs[1 - g.half] += pl.errs.length;
  cur.rbi = pl.made < 2 && !err;
  if (outsAfter < 3) {
    const nb = [null, null, null];
    for (const r of pl.runs) if (!r.out && r.to >= 1 && r.to <= 3) nb[r.to - 1] = { id: r.id, name: r.name };
    g.bases = nb;
  }
  for (const r of scored) scoreRun(r, cur); // before the third out (a tag) they count
  if (pl.made) out(pl.made, cur);
  g.balls = 0; g.strikes = 0;
  if (g.half === 1 && g.inning >= 9 && g.score[1] > g.score[0] && !g.over) { gameOver(); g.msg = '끝내기! ' + g.msg; }
  const moves = pl.runs.filter(r => r.legs.length || r.out).map(({ id, ...m }) => m);
  return { kind: k, text, moves, endPA: true };
}

const gauss = rnd => (rnd() + rnd() + rnd() - 1.5) / 0.5; // ~N(0,1), good enough
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// signed distance from the ball's crossing point to the swing line; + = ball above the line (bat goes under it)
function lineDist([bx, by], [x1, y1, x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
  const t = clamp(((bx - x1) * dx + (by - y1) * dy) / (L * L), 0, 1);
  const px = x1 + dx * t, py = y1 + dy * t, d = Math.hypot(bx - px, by - py);
  return by >= py ? d : -d;
}
const fenceAt = sprayDeg => 100 + 22 * Math.cos(sprayDeg * Math.PI / 90); // 100 m down the lines, 122 m to center

// the swing met the ball: decide what happened, and the batted ball's flight for the animation
function contact(p, s, rnd = Math.random) {
  const bc = BAT_CHARS[p.bchar ?? 1], tw = TIMING_WIN * bc.tim, lw = LINE_WIN * bc.acc / (p.stuff || 1);
  const err = s.at + SWING_LAG - p.arriveAt, sd = lineDist(p.T, s.line);
  const tq = 1 - Math.abs(err) / tw, dq = 1 - Math.abs(sd) / lw;
  if (tq <= 0 || dq <= 0) return { kind: 'miss', err: Math.round(err) };
  const q = tq * dq / (p.stuff || 1), pw = s.power; // a heavy ball (pitcher power) is harder to square up
  const ev = (95 + 85 * q * (0.45 + 0.55 * pw)) * bc.pw / (p.stuff || 1); // exit velocity km/h
  const la = clamp(12 + sd * 260 + gauss(rnd) * 16, -15, 75); // launch angle
  // early = pulled: to left field (-) for a right-handed batter, to right field (+) for a lefty
  let spray = (p.bhand === 'L' ? -1 : 1) * (clamp(err / tw * 40, -42, 42) + (rnd() - 0.5) * 14);
  const v = ev / 3.6, rad = la * Math.PI / 180;
  let kind, dist, hang;
  if (rnd() < 0.6 * (1 - tq) + 0.2 * (1 - dq) || Math.abs(spray) > 45) { // foul
    kind = 'foul'; spray = (spray < 0 ? -1 : 1) * (52 + rnd() * 50);
    dist = la < 10 ? 25 : clamp(v * v * Math.sin(2 * Math.max(rad, 0.3)) / 9.8 * 0.5, 15, 70);
  } else if (la < 10) { // ground ball
    dist = rnd() < 0.1 + 0.25 * q + (bc.spd - 1) * 0.15 ? 55 : 33; // fast runners get more grounders through
    kind = dist > 40 ? '1B' : 'GO';
  } else { // hits are '1B' here; runPlay decides how many bases from the fielding
    dist = v * v * Math.sin(2 * rad) / 9.8 * 0.62;
    if (la >= 50) kind = rnd() < 0.05 ? '1B' : 'PO';
    else if (la < 25) kind = rnd() < 0.35 + 0.3 * q ? '1B' : 'LO';
    else if (dist >= fenceAt(spray)) kind = 'HR';
    else kind = rnd() < 0.1 + 0.25 * q ? '1B' : 'FO';
  }
  if (kind === 'HR') dist = Math.max(dist, fenceAt(spray) + 8);
  hang = la < 10 ? clamp(dist / v * 1600, 600, 2200) : clamp(2 * v * Math.sin(Math.max(rad, 0.15)) / 9.8 * 850, 700, 5000);
  const apex = la < 10 ? 0.4 : clamp(v * v * Math.sin(rad) ** 2 / 19.6 * 0.6, 1.5, 55);
  const c = { kind, err: Math.round(err), ev: Math.round(ev), la: Math.round(la), spray: Math.round(spray), dist: Math.round(dist), hang: Math.round(hang), apex: +apex.toFixed(1) };
  return c;
}

// Plays in real time (seconds after contact): a fielder gets the ball (pickup) and throws at once to where he can get an out;
// every runner runs only as far as he is sure to make it before a throw could, except that a forced runner has to go.
// An out happens when the ball reaches the base before the runner does. index.html animates the same timings.
const D2R = Math.PI / 180;
const FIELD = [[28, 38], [40, 15], [40, -15], [28, -38], [85, -28], [95, 0], [85, 28]].map(([d, a]) => [Math.sin(a * D2R) * d, -Math.cos(a * D2R) * d]); // 1B 2B SS 3B LF CF RF, as in index.html
const BASE_XZ = [[0, 0], [19.4, -19.4], [0, -38.8], [-19.4, -19.4]], BASE_LEN = 27.43, LEAD = 3.5; // runners take a 3.5 m lead
const throwS = d => d / 26 + (d > 50 ? 0.6 : 0); // a long throw needs a crow hop or a relay
const xz = b => BASE_XZ[b % 4], dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const runSpeed = spd => 6.9 + 0.7 * spd; // m/s
// who gets the ball, where, and when (s); catch = caught in the air
function pickup(c, rnd = Math.random) {
  const v = c.ev / 3.6, a = c.spray * D2R, dir = [Math.sin(a), -Math.cos(a)], on = d => [dir[0] * d, dir[1] * d];
  const nearest = (at, from = 0) => { let w = from; for (let i = from; i < 7; i++) if (dist2(FIELD[i], at) < dist2(FIELD[w], at)) w = i; return w; };
  if (['FO', 'LO', 'PO'].includes(c.kind)) { const at = on(c.dist); return { who: nearest(at), at, pick: c.hang / 1000, catch: true }; }
  if (c.kind === '1B' && c.la < 10) { // a grounder through the infield: an infielder who can get to it dives, and sometimes comes up with it
    for (const i of [0, 1, 2, 3]) {
      const f = FIELD[i], along = clamp(f[0] * dir[0] + f[1] * dir[1], 8, 42), at = on(along), tb = along / (v * 0.8);
      const reach = Math.max(0, tb - 0.3) * 7 + 1.8; // run, then the dive
      if (dist2(f, at) <= reach && rnd() < 0.6) return { who: i, at, tb, pick: tb + 0.9, dive: true }; // 0.9 s to get up
    }
  }
  if (c.bunt) { const at = on(c.dist), who = c.spray < 0 ? 3 : 0; return { who, at, pick: c.dead ? 3.4 : 1.3 + c.dist * 0.03 }; } // the corner man charges on the bunt
  if (c.kind === 'GO') { // an infielder cuts it off on its way out
    let best = null;
    for (const i of [0, 1, 2, 3]) {
      const f = FIELD[i], d = clamp(f[0] * dir[0] + f[1] * dir[1], 8, 42), at = on(d), t = Math.max(d / (v * 0.8), 0.3 + dist2(f, at) / 7) + 0.15;
      if (!best || t < best.pick) best = { who: i, at, pick: t };
    }
    return best;
  }
  // through the infield or in the air: it rolls to a stop (down the line into the corner) and the nearest fielder runs it down
  const roll = c.la < 10 ? 0.3 * v * (Math.abs(c.spray) > 33 ? 1.8 : 1) : 0.3 * v + 6;
  const rest = Math.min(c.dist + roll, fenceAt(c.spray) - 1.5), at = on(rest);
  const who = nearest(at, rest > 45 ? 4 : 0); // past the infield: an outfielder gets it
  return { who, at, pick: Math.max(0.6 + dist2(FIELD[who], at) / 7, c.hang / 1000 + roll / (0.5 * v + 1)) };
}
// who takes a throw at a base: 1B / 2B or SS / 3B, the catcher at home ('C'); someone else when that one fielded it
function coverer(b, who, spray) {
  if (b % 4 === 0) return 'C';
  let c = b === 1 ? 0 : b === 2 ? (spray < 0 ? 1 : 2) : 3;
  if (c === who) c = b === 1 ? 1 : b === 2 ? 3 - c : 2;
  return c;
}
// bases: [r1, r2, r3] ({id, name} or null); rsOf(id) = running speed. Returns each runner's legs (times in ms), the throws, outs and errors.
// Runners judge the throw by eye (a quarter second either way), so now and then one takes a chance and is tagged out.
// Errors: a bobble or a dropped fly costs the fielder time; a wild throw gets past the base and everyone moves up while it is chased.
const TAG = 0.15; // reaching for the runner after the catch
function runPlay(c, pu, bases, outs, batter, rsOf, rnd = Math.random) {
  const ms = x => Math.round(x * 1000), errs = [];
  let caught = !!pu.catch, pick = pu.pick, dropped = false;
  if (caught && rnd() < 0.012) { caught = false; dropped = true; errs.push('낙구'); pick += 1 + rnd() * 0.6; }
  else if (!caught && rnd() < (c.kind === 'GO' || c.bunt ? 0.03 : 0.012)) { errs.push('포구'); pick += 0.7 + rnd() * 0.8; }
  const rel0 = pick + (caught ? 0.6 : pu.who < 4 ? 0.35 : 0.8);
  const ballAt = (from, t0, b) => t0 + throwS(dist2(from, xz(b)));
  const judge = () => gauss(rnd) * 0.25;
  const occ = b => b === 0 ? !caught : !!bases[b - 1];
  const list = [];
  for (let b = 3; b >= 1; b--) if (bases[b - 1]) list.push({ ...bases[b - 1], from: b });
  if (!caught) list.push({ ...batter, from: 0 });
  // each runner, lead first, goes base by base while he thinks he beats a throw from where the ball is (forced: the first base he must)
  const advance = (r, pos, t, from, t0, cap) => {
    while (pos < cap) {
      const arr = t + BASE_LEN / r.rs - (pos === r.from && r.lead ? LEAD / r.rs : 0);
      if (!(r.forced && pos === r.from) && !(arr + 0.1 + judge() < ballAt(from, t0, pos + 1))) break;
      if (pos === r.from) r.first = arr;
      pos++; t = arr;
    }
    return [pos, t];
  };
  const runs = []; let limit = 4;
  for (const r0 of list) {
    const r = { ...r0, rs: rsOf(r0.id), forced: !caught && [...Array(r0.from + 1).keys()].every(occ), lead: !caught && !dropped && r0.from > 0 };
    // on the ground they go on contact; on a catch they tag up first; on a dropped fly they go when it hits the ground
    const start = caught ? pick + 0.15 : dropped && r.from ? pu.pick + 0.2 : r.from === 0 ? 0.25 : 0.1;
    const [pos, t] = advance(r, r.from, start, pu.at, rel0, Math.min(limit, r.from === 0 ? 3 : 4));
    r.first ??= start + BASE_LEN / r.rs;
    r.legs = pos > r.from ? [{ from: r.from, to: pos, start, arr: t }] : [];
    Object.assign(r, { to: pos, arr: t, out: false });
    limit = pos === 4 ? 4 : pos - 1;
    runs.push(r);
  }
  // the fielder throws as soon as he has it, to the runner he can get (force, or a tag on one who is going for it):
  // the lead one when it is sure, the surest one with two outs; then the relay. A throw can get away (error).
  let made = caught ? 1 : 0, holder = pu.who, from = pu.at, t0 = rel0;
  const throws = [], outsAt = caught ? [{ t: pick, force: true }] : [];
  for (let k = 0; k < 3 && outs + made < 3; k++) {
    const cand = [];
    for (const r of runs) {
      if (r.out || (!r.legs.length && !r.forced)) continue;
      if (r.forced) { const tb = ballAt(from, t0, r.from + 1); if (tb < r.first) { cand.push({ r, b: r.from + 1, tb, arr: r.first, force: true }); continue; } }
      if (r.to > r.from && !(r.forced && r.to === r.from + 1)) { const tb = ballAt(from, t0, r.to) + TAG; if (tb < r.arr) cand.push({ r, b: r.to, tb, arr: r.arr, force: false }); }
    }
    if (!cand.length) break;
    const score = x => (outs + made < 2 && x.arr - x.tb > 0.25 ? 10 + x.b : 0) + x.arr - x.tb;
    const x = cand.sort((a, b) => score(b) - score(a))[0], rcv = coverer(x.b, holder, c.spray);
    const th = { by: holder, rcv, to: x.b, rel: t0, arr: x.tb - (x.force ? 0 : TAG) };
    throws.push(th);
    if (rnd() < (dist2(from, xz(x.b)) > 45 ? 0.04 : 0.025)) { // wild throw: past the base, everyone takes what he can while it is chased down
      errs.push('송구');
      if (rnd() < 0.5) { // into the dugout or the stands: dead ball, two bases from where each runner was when it was thrown
        for (const r of runs) {
          if (r.out) continue;
          const st = r.legs[0]?.start ?? th.rel, was = Math.min(r.to, r.from + Math.max(0, Math.floor((th.rel - st) * r.rs / BASE_LEN))), to = Math.min(4, was + 2);
          if (to > r.to) { const go = Math.max(r.arr, th.arr + 0.3); r.legs.push({ from: r.to, to, start: go, arr: go + (to - r.to) * BASE_LEN / (r.rs * 0.75) }); r.to = to; r.arr = r.legs.at(-1).arr; }
        }
        Object.assign(th, { err: true, dead: true, loose: [+(xz(x.b)[0] * 1.6).toFixed(1), +(xz(x.b)[1] * 1.6 + 6).toFixed(1)] });
        holder = null; break;
      }
      const dir = [xz(x.b)[0] - from[0], xz(x.b)[1] - from[1]], L = Math.hypot(...dir) || 1, d = 15 + rnd() * 15;
      const loose = [xz(x.b)[0] + dir[0] / L * d, xz(x.b)[1] + dir[1] / L * d];
      let fetch = 0; FIELD.forEach((f, i) => { if (i !== holder && dist2(f, loose) < dist2(FIELD[fetch], loose)) fetch = i; });
      const back = th.arr + 1.4 + rnd() * 1.4;
      Object.assign(th, { err: true, loose: loose.map(v => +v.toFixed(1)), fetch, back });
      let lim = 4;
      for (const r of runs) {
        if (r.out) continue;
        const go = Math.max(r.arr, th.arr + 0.2), [pos, t] = advance({ ...r, forced: false, lead: false, from: -1 }, r.to, go, loose, back + 0.4, Math.min(lim, r.from === 0 ? 3 : 4));
        if (pos > r.to) { r.legs.push({ from: r.to, to: pos, start: go, arr: t }); r.to = pos; r.arr = t; }
        lim = r.to === 4 ? 4 : r.to - 1;
      }
      holder = fetch; from = loose; t0 = back + 0.4;
      continue;
    }
    const r = x.r;
    if (x.force) { r.legs = r.legs.length ? [{ ...r.legs[0], to: x.b, arr: r.first }] : [{ from: r.from, to: x.b, start: r.from ? 0.1 : 0.25, arr: r.first }]; r.to = x.b; r.arr = r.first; }
    Object.assign(r, { out: true, outAt: x.tb, tag: !x.force }); made++; outsAt.push({ t: x.tb, force: x.force });
    holder = rcv; from = xz(x.b); t0 = x.tb + (x.force ? 0.75 : 0.6);
  }
  const moving = runs.filter(r => r.legs.length && !r.out);
  if (holder != null && (!throws.length || throws[throws.length - 1].err) && (moving.length || !caught)) { // nobody to get: throw ahead of the lead runner to hold him there
    const b = moving.length ? Math.max(...moving.map(r => r.to)) : 2, rcv = coverer(b, holder, c.spray);
    throws.push({ by: holder, rcv, to: b, rel: t0, arr: ballAt(from, t0, b) });
  }
  // runs count unless the third out is a force (or the catch); on a tag for the third out, only the ones home before it
  outsAt.sort((a, b) => a.t - b.t);
  const third = outs + made >= 3 ? outsAt[2 - outs] : null;
  const scored = runs.filter(r => !r.out && r.to === 4 && (!third || (!third.force && r.arr < third.t)));
  const end = Math.max(pick, ...runs.map(r => r.out ? r.outAt : r.arr), ...throws.map(x => x.back ?? x.arr));
  return {
    who: pu.who, dive: !!pu.dive, at: pu.at.map(v => +v.toFixed(2)), pick: ms(pick), catch: caught, dropped, made, end: ms(end), errs, scored: scored.map(r => r.id),
    runs: runs.map(r => ({ id: r.id, name: r.name, from: r.from, to: r.to, out: r.out, tag: !!r.tag, outAt: r.out ? ms(r.outAt) : undefined,
      legs: r.legs.map(l => ({ from: l.from, to: l.to, start: ms(l.start), arr: ms(l.arr) })) })),
    throws: throws.map(x => ({ by: x.by, rcv: x.rcv, to: x.to, rel: ms(x.rel), arr: ms(x.arr), ...(x.err ? { err: true, dead: !!x.dead, loose: x.loose, fetch: x.fetch, back: x.back != null ? ms(x.back) : undefined } : {}) })),
  };
}

// a bunt: no timing, the bat just has to be at the ball's height; it dribbles 9-17 m up a base line
function bunt(p, s, rnd = Math.random) {
  const sd = lineDist(p.T, s.line), spd = BAT_CHARS[p.bchar ?? 1].spd;
  if (Math.abs(sd) > 0.12) return { kind: 'miss', bunt: true };
  if (rnd() < 0.22 + Math.abs(sd) * 2) return { kind: 'foul', bunt: true, ev: 40, la: 30, spray: Math.round((rnd() < 0.5 ? -1 : 1) * (60 + rnd() * 30)), dist: 6, hang: 900, apex: 1.5 };
  const pop = rnd() < 0.08, kind = pop ? 'PO' : rnd() < 0.12 * spd ? '1B' : 'SAC';
  const c = { kind, bunt: true, ev: 40, la: pop ? 60 : 0, spray: Math.round((rnd() < 0.5 ? -1 : 1) * (18 + rnd() * 22)), dist: Math.round(pop ? 8 : 9 + rnd() * 8), hang: pop ? 1700 : 1500, apex: pop ? 6 : 0.4 };
  if (kind === '1B') c.dead = true; // a bunt that dies on the grass: fielded too late to get anyone
  return c;
}

function throwPitch(id, b, now) {
  const P = PITCHES[b.type], pw = clamp(+b.power || 0, 0, 1);
  const pl = look(id), bl = look(batters[0]), pc = PIT_CHARS[pl.pit], hs = pl.hand === 'L' ? -1 : 1; // a lefty mirrors everything in x
  const kmh = Math.round((P.kmh[0] + (P.kmh[1] - P.kmh[0]) * pw) * pc.vel), sig = (0.03 + 0.11 * pw * pw) * pc.ctl;
  const T = [clamp(+b.ax || 0, -0.7, 0.7) + gauss(Math.random) * sig, clamp(+b.ay || 0.8, 0.15, 1.5) + gauss(Math.random) * sig].map(v => +v.toFixed(3));
  const k = (0.6 + 0.4 * pw) * pc.brk, A = [+(T[0] - P.brk[0] * k * hs).toFixed(3), +(T[1] - P.brk[1] * k).toFixed(3)];
  const releaseAt = now + WINDUP_MS, arriveAt = Math.round(releaseAt + 18.44 / (kmh / 3.6) * 1000 * SLOW);
  const inZone = Math.abs(T[0]) <= ZONE.x && T[1] >= ZONE.y0 - 0.037 && T[1] <= ZONE.y1 + 0.037;
  const hbp = (bl.hand === 'L' ? T[0] > HBP_X : T[0] < -HBP_X) && T[1] > 0.2 && T[1] < 1.65; // crosses where the batter's body is
  g.pitch = { id: ++g.seq, type: b.type, name: P.name, kmh, R: [RELEASE[0] * hs, RELEASE[1], RELEASE[2]], A, T, loft: P.loft, bp: P.bp,
    startAt: now, releaseAt, arriveAt, inZone, hbp, pitcher: id, batter: batters[0], hand: pl.hand, bhand: bl.hand, pchar: pl.pit, bchar: bl.bat, stuff: pc.stuff };
  if (batters[0] === AI_B) g.pitch.aiSwing = aiSwingPlan(g.pitch);
  g.swing = null; g.result = null; g.phase = 'pitch'; g.started = true; g.msg = '';
}

// AI players: ids no browser can have (real ids are 16 hex chars)
const AI_P = 'ai-pitcher', AI_B = 'ai-batter', AI_NAMES = { [AI_P]: 'AI 투수', [AI_B]: 'AI 타자' };
function aiPitch(now) {
  const types = Object.keys(PITCHES), strike = Math.random() < 0.62;
  throwPitch(AI_P, {
    type: types[Math.random() * types.length | 0], power: 0.45 + Math.random() * 0.45,
    ax: strike ? (Math.random() - 0.5) * 0.36 : (Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 0.25),
    ay: strike ? 0.58 + Math.random() * 0.4 : Math.random() < 0.5 ? 0.3 : 1.25,
  }, now);
}
// the AI batter decides at the pitch: swing more at strikes, with human-like timing and aim errors
function aiSwingPlan(p, rnd = Math.random) {
  const twoK = g.strikes === 2;
  if (g.outs === 0 && !twoK && (g.bases[0] || g.bases[1]) && !g.bases[2] && rnd() < 0.3) // sacrifice bunt
    return { bunt: true, at: p.arriveAt - SWING_LAG, power: 0, line: [p.T[0] - 0.45, p.T[1] + gauss(rnd) * 0.05, p.T[0] + 0.45, p.T[1]].map(v => +v.toFixed(3)) };
  if (rnd() > (p.inZone ? (twoK ? 0.85 : 0.68) : (twoK ? 0.35 : 0.22))) return null;
  const y = p.T[1] + gauss(rnd) * 0.07;
  return { at: Math.round(p.arriveAt - SWING_LAG + gauss(rnd) * 55), power: 0.5 + rnd() * 0.5, line: [p.T[0] - 0.45, +y.toFixed(3), p.T[0] + 0.45, +y.toFixed(3)] };
}

function resolve(now) {
  const p = g.pitch, s = g.swing, cur = { b: p.batter, p: p.pitcher };
  const c = !s ? { kind: p.hbp ? 'HBP' : p.inZone ? 'strike' : 'ball' } : s.bunt ? bunt(p, s) : contact(p, s);
  if (s?.bunt && c.kind === 'foul' && g.strikes === 2) c.kind = 'miss'; // a two-strike foul bunt is strike three
  const inPlay = !['ball', 'strike', 'miss', 'foul', 'HBP'].includes(c.kind);
  if (inPlay && c.kind !== 'HR') { // the fielding decides the rest
    const pu = pickup(c);
    if (c.kind === 'GO' || pu.dive) { c.dist = Math.round(Math.hypot(...pu.at)); c.hang = Math.round((pu.tb ?? pu.pick - 0.12) * 1000); } // rolls straight to the fielder
    cur.play = c.pl = runPlay(c, pu, g.bases, g.outs, { id: cur.b, name: nameOf(cur.b) }, id => runSpeed(BAT_CHARS[look(id).bat].spd));
    cur.bunt = !!c.bunt;
  }
  const r = settle(c.kind, cur);
  if (s?.bunt && r.text === '헛스윙!') r.text = '번트 실패!';
  const contactAt = s ? s.at + SWING_LAG : p.arriveAt;
  const showAt = c.kind === 'foul' ? contactAt + 700 : inPlay ? contactAt + Math.max(c.hang, c.pl?.end || 0) + 150 : c.kind === 'HBP' ? p.arriveAt + 900 : p.arriveAt + 150;
  g.result = { ...c, ...r, pitchId: p.id, contactAt, showAt, swung: !!s, kmh: p.kmh, name: p.name };
  g.phase = 'result';
  g.until = showAt + (inPlay ? (c.kind === 'HR' ? 4500 : 2600) : c.kind === 'foul' ? 1400 : 1300) + (g.msg ? 1500 : 0);
  g.until = Math.max(g.until, p.startAt + 3700); // let the pitcher finish walking back to the rubber (PITCH_END in index.html)
  const bt = lineup.findIndex(l => l.includes(p.batter));
  if (r.endPA && bt >= 0) batIdx[bt]++;
  if (g.over) g.phase = 'over', g.overAt = g.until;
}

function tick(now) {
  for (const [id, p] of players) if (now - p.seen > GONE_MS) players.delete(id);
  for (const t of [0, 1]) lineup[t] = lineup[t].filter(id => players.get(id)?.inGame);
  if (!g.started) { // waiting room: starts when everyone who picked a team is ready
    const want = [...players.values()].filter(p => !p.watch && p.team != null);
    if (want.length && want.every(p => p.ready)) startGame();
  } else if (!g.over && !lineup[0].length && !lineup[1].length) newGame(); // everyone in the game left
  if (g.started) {
    const order = (t, pos) => { const L = lineup[t], c = L.filter(id => players.get(id).pos === pos); return c.length ? c : L; };
    const rot = (a, k) => a.map((_, i) => a[(k + i) % a.length]);
    const B = order(g.half, 'batter'), F = order(1 - g.half, 'pitcher');
    batters = B.length ? rot(B, batIdx[g.half]) : [AI_B];
    pitchers = F.length ? rot(F, onMound[1 - g.half]) : [AI_P];
  } else batters = pitchers = [];
  if (g.phase === 'pitch') {
    if (g.pitch.batter !== batters[0] || g.pitch.pitcher !== pitchers[0]) { g.pitch = null; g.phase = 'ready'; } // someone left mid-pitch
    else {
      const plan = g.pitch.aiSwing;
      if (plan && !g.swing && now >= (plan.bunt ? g.pitch.releaseAt : plan.at - 60)) g.swing = { at: plan.at, power: plan.power, line: plan.line, bunt: !!plan.bunt };
      if (now > g.pitch.arriveAt + 500 || (g.swing && now >= g.swing.at + SWING_LAG)) resolve(now);
    }
  }
  if (g.phase === 'result' && now > g.until) g.phase = 'ready', g.msg = '';
  if (g.phase === 'ready' && pitchers[0] === AI_P) {
    g.aiAt ||= now + 1800 + Math.random() * 1500; // a breath between pitches
    if (now >= g.aiAt) { g.aiAt = 0; aiPitch(now); }
  } else g.aiAt = 0;
  if (g.phase === 'over' && now > g.overAt + OVER_MS) newGame(); // the queues stay
  if (g.phase === 'idle' || g.phase === 'ready') g.phase = g.started ? 'ready' : 'idle';
}

const publicId = secret => crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
const str = (v, n) => typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) : '';
function readJson(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch { cb(null); } });
}
const ok = res => res.writeHead(204).end();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    return fs.readFile(PAGE, (err, html) => {
      if (err) return res.writeHead(500).end();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
    });
  }
  const secret = url.searchParams.get('id') || '';
  if (!/^[a-z0-9]{16,40}$/.test(secret)) return res.writeHead(400).end();
  const id = publicId(secret), me = players.get(id), now = Date.now();
  if (me) me.seen = now;

  if (req.method === 'GET' && url.pathname === '/state') {
    const list = [...players].map(([pid, p]) => ({ id: pid, name: p.name, bat: p.bat, pit: p.pit, hand: p.hand, team: p.team, pos: p.pos, ready: !!p.ready, inGame: !!p.inGame, req: !!p.req, watch: !!p.watch }));
    if (pitchers[0] === AI_P) list.push({ id: AI_P, name: AI_NAMES[AI_P], team: 1 - g.half, pos: 'pitcher', inGame: true, ai: true, ...look(AI_P) });
    if (batters[0] === AI_B) list.push({ id: AI_B, name: AI_NAMES[AI_B], team: g.half, pos: 'batter', inGame: true, ai: true, ...look(AI_B) });
    const subbed = !!me && me.subG === g && me.subInn === g.inning;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ now, you: id, me: me ? { name: me.name, subbed } : null, players: list, batters, pitchers, lineup, events, chat, g, rec }));
  }
  if (req.method !== 'POST') return res.writeHead(404).end();
  return readJson(req, b => {
    if (!b) return res.writeHead(400).end();
    if (url.pathname === '/join') {
      const name = str(b.name, 10);
      if (!name) return res.writeHead(400).end();
      const pick = v => [0, 1, 2].includes(v) ? v : 1;
      const changed = me && (me.bat !== pick(b.bat) || me.pit !== pick(b.pit) || me.hand !== (b.hand === 'L' ? 'L' : 'R'));
      // a player in the game may change character or hand once per inning
      const playing = me?.inGame && g.started && !g.over;
      if (changed && playing && me.subG === g && me.subInn === g.inning) return res.writeHead(409).end();
      if (changed && playing) Object.assign(me, { subG: g, subInn: g.inning });
      if (!me) note(`${name}님이 들어와서 대기 중이에요`);
      players.set(id, { team: null, pos: 'batter', ...(me || {}), name, seen: now, bat: pick(b.bat), pit: pick(b.pit), hand: b.hand === 'L' ? 'L' : 'R' });
      return ok(res);
    }
    if (!me) return res.writeHead(403).end();
    if (url.pathname === '/say') {
      const text = str(b.text, 80);
      if (!text || now - (me.saidAt || 0) < 400) return res.writeHead(429).end();
      me.saidAt = now; chat.push({ seq: ++chatSeq, name: me.name, team: me.team, text });
      if (chat.length > 30) chat.shift();
      return ok(res);
    }
    if (url.pathname === '/pick') { // team / position / just watch; not while playing in a running game
      if (me.inGame && g.started && !g.over) return res.writeHead(409).end();
      me.team = [0, 1].includes(b.team) ? b.team : null; me.pos = b.pos === 'pitcher' ? 'pitcher' : 'batter'; me.watch = !!b.watch;
      me.ready = false; me.req = false;
      return ok(res);
    }
    if (url.pathname === '/ready') {
      if (g.started || me.watch || me.team == null) return res.writeHead(409).end();
      me.ready = !!b.ready; tick(now);
      return ok(res);
    }
    if (url.pathname === '/request') { // ask the players of a running game to let me in
      if (!g.started || g.over || me.inGame || me.watch || me.team == null || me.req) return res.writeHead(409).end();
      me.req = true; note(`${me.name}님이 같이하고 싶어해요 (${me.team ? '홈' : '원정'}팀 ${me.pos === 'pitcher' ? '투수' : '타자'})`);
      return ok(res);
    }
    if (url.pathname === '/accept') { // a player in the game lets a requester in (or not)
      const t = players.get(b.id);
      if (!me.inGame || !g.started || !t?.req) return res.writeHead(409).end();
      t.req = false;
      if (b.ok) { t.inGame = true; lineup[t.team].push(b.id); note(`${t.name}님이 경기에 들어왔어요 (${me.name}님이 수락)`); }
      else note(`${me.name}님이 ${t.name}님의 요청을 거절했어요`);
      return ok(res);
    }
    if (url.pathname === '/end') { // force-end: anyone taking part can stop the game; a new one starts a few seconds later
      if (!me.inGame || !g.started || g.over) return res.writeHead(409).end();
      Object.assign(g, { over: true, phase: 'over', msg: `${me.name}님이 경기를 종료했어요`, pitch: null, swing: null, result: null, overAt: now - OVER_MS + 5000 });
      return ok(res);
    }
    if (url.pathname === '/pitch') {
      if (g.phase !== 'ready' || pitchers[0] !== id || !PITCHES[b.type]) return res.writeHead(409).end();
      throwPitch(id, b, now);
      return ok(res);
    }
    if (url.pathname === '/swing') {
      const p = g.pitch;
      if (g.phase !== 'pitch' || batters[0] !== id || g.swing || !p) return res.writeHead(409).end();
      const at = clamp(+b.at || now, p.releaseAt, now + 50); // a swing can't be timed in the future or before the release
      const line = Array.isArray(b.line) && b.line.length === 4 ? b.line.map((v, i) => clamp(+v || 0, i % 2 ? 0 : -1, i % 2 ? 1.6 : 1)) : [-0.4, 0.8, 0.4, 0.8];
      if (b.bunt === true) { // squaring to bunt commits now; the bat meets the ball when it arrives
        if (now > p.arriveAt - 80) return res.writeHead(409).end();
        g.swing = { at: p.arriveAt - SWING_LAG, power: 0, line, bunt: true };
        return ok(res);
      }
      g.swing = { at: Math.round(at), power: clamp(+b.power || 0, 0, 1), line };
      return ok(res);
    }
    res.writeHead(404).end();
  });
});

if (process.argv.includes('--test')) {
  const cur = { b: 'b1', p: 'p1' }, never = () => 0.99;
  players.set('b1', { name: '타자', role: 'batter', seen: 0 });
  for (let i = 0; i < 3; i++) settle('ball', cur);
  assert.equal(g.balls, 3);
  settle('ball', cur); assert.deepEqual([g.balls, g.bases[0]?.name], [0, '타자']); // walk
  for (let i = 0; i < 8; i++) settle('ball', cur);
  assert.equal(g.score[0], 0); assert.ok(g.bases.every(Boolean), 'bases loaded');
  for (let i = 0; i < 4; i++) settle('ball', cur);
  assert.equal(g.score[0], 1, 'bases-loaded walk forces in a run');
  const before = g.score[0]; settle('HBP', cur); assert.equal(g.score[0], before + 1, 'HBP with bases loaded forces a run'); assert.equal(rec.bat.b1.HBP, 1);
  settle('foul', cur); settle('foul', cur); settle('foul', cur); assert.equal(g.strikes, 2, 'foul never makes strike three');
  settle('miss', cur); assert.equal(g.outs, 1);
  settle('HR', cur); assert.equal(g.score[0], 6, 'grand slam'); assert.deepEqual(g.bases, [null, null, null]);
  settle('FO', cur, never); settle('PO', cur); assert.deepEqual([g.half, g.inning, g.outs], [1, 1, 0], 'three outs switch sides');
  assert.equal(rec.bat.b1.RBI, 6); assert.equal(rec.pit.p1.R, 6);
  while (!g.over) settle('PO', cur);
  assert.deepEqual([g.inning, g.half, g.msg], [9, 1, '원정팀 승리!'], 'away ahead: bottom 9 is played, then it ends');
  newGame(); g.inning = 9; g.half = 1; g.score = [0, 0]; g.line = [[0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0]];
  settle('HR', cur); assert.ok(g.over && g.msg.startsWith('끝내기'), 'walk-off');
  newGame();
  assert.equal(lineDist([0, 1], [-1, 0.8, 1, 0.8]).toFixed(2), '0.20');
  assert.equal(contact({ arriveAt: 1000, T: [0, 0.8] }, { at: 600, line: [-1, 0.8, 1, 0.8], power: 1 }).kind, 'miss', 'way early misses');
  const kinds = {}; for (let i = 0; i < 2000; i++) { const k = contact({ arriveAt: 1000, T: [0, 0.8] }, { at: 850 + (Math.random() - 0.5) * 60, line: [-0.4, 0.78, 0.4, 0.82], power: Math.random() }).kind; kinds[k] = (kinds[k] || 0) + 1; }
  console.log('good-contact outcomes over 2000 swings:', kinds);
  assert.ok(kinds.HR && kinds['1B'] && kinds.foul, 'good swings give a mix');
  // plays: decided by who gets where first
  const rs = () => runSpeed(1), B0 = { id: 'b1', name: '타자' }, R = n => ({ id: 'r' + n, name: '주자' + n });
  const sure = () => 0.5; // rnd: no errors, runners judge exactly (gauss(0.5 x3) = 0)
  const play = (c, bases, outs = 0, rnd = sure) => runPlay(c, pickup(c, rnd), bases, outs, B0, rs, rnd);
  // a grounder in the hole: the shortstop can dive for it (rnd low = he gets it), stays down a moment, throws to first
  const hole = { kind: '1B', ev: 130, la: 3, spray: -20, dist: 55 }, dv = pickup(hole, () => 0.1);
  assert.ok(dv.dive && dv.who === 2 && dv.pick > dv.tb, 'shortstop dives for the ball in the hole');
  assert.ok(!pickup(hole, () => 0.9).dive, 'or it gets through');
  const dvp = runPlay(hole, dv, [null, null, null], 0, B0, rs, sure);
  assert.ok(dvp.dive && dvp.throws[0]?.to === 1, 'after the dive he throws to first');
  const gap = play({ kind: '1B', ev: 150, la: 20, spray: -40, dist: 80, hang: 2500 }, [null, null, null]);
  assert.deepEqual([gap.runs[0].to, gap.who, gap.throws[0].to], [2, 4, 2], 'ball in the left-field corner: a double, the left fielder throws to second');
  const mid = play({ kind: '1B', ev: 120, la: 0, spray: 0, dist: 55, hang: 1500 }, [null, null, null]);
  assert.equal(mid.runs[0].to, 1, 'grounder up the middle: a single');
  // the user's case: runner on third, hard grounder to third. He would be out at home, so he holds; the batter is thrown out at first
  const g3 = play({ kind: 'GO', ev: 140, la: 0, spray: -25, dist: 33, hang: 1300 }, [null, null, R(3)]);
  assert.deepEqual(g3.runs.map(r => [r.from, r.to, r.out]), [[3, 3, false], [0, 1, true]], 'runner on third holds, batter out at first');
  // a grounder to the shortstop playing deep: the throw home would be late, so he goes and scores
  const slow = play({ kind: 'GO', ev: 100, la: 0, spray: -15, dist: 33, hang: 1300 }, [null, null, R(3)]);
  assert.deepEqual(slow.runs[0].to, 4, 'deep short: the runner from third scores');
  // runner on first, grounder to short: force at second, relay to first = double play
  const dp = play({ kind: 'GO', ev: 150, la: 0, spray: -12, dist: 33, hang: 1200 }, [R(1), null, null]);
  assert.deepEqual([dp.made, dp.throws.map(x => x.to)], [2, [2, 1]], '6-4-3 double play');
  // the throw goes to the base, and the out is whoever gets there second: ball arrives before the runner
  for (const r of dp.runs.filter(r => r.out)) assert.ok(r.outAt < r.legs[0].arr, 'out: ball beats the runner');
  // deep fly with a runner on third: he tags up and scores; shallow one: he stays
  const deep = runPlay({ kind: 'FO', spray: 0 }, { who: 5, at: [0, -90], pick: 4, catch: true }, [null, null, R(3)], 0, B0, rs, sure);
  const shallow = runPlay({ kind: 'FO', spray: 0 }, { who: 5, at: [0, -55], pick: 3, catch: true }, [null, null, R(3)], 0, B0, rs, sure);
  // tag play: a runner who misjudges (rnd high = thinks he is faster) goes for home from second on a single and is thrown out
  const bold = (() => { const q = [0.5, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]; let i = 0; return () => q[i++] ?? 0.5; })(); // no error, then the runner from second reads it 0.7 s too rosy
  const tag = runPlay({ kind: '1B', spray: 0 }, { who: 5, at: [0, -62], pick: 2.85 }, [null, R(2), null], 0, B0, rs, bold);
  const r2 = tag.runs.find(r => r.from === 2);
  assert.ok(r2.to === 4 && r2.out && r2.tag && r2.outAt < r2.legs[0].arr, 'runner sent home is tagged out: ball beat him');
  // errors: a wild throw to first gets away and the batter takes second
  const wild = (() => { const q = [0.5, 0.5, 0.5, 0.5, 0.001, 0.001]; let i = 0; return () => q[i++] ?? 0.5; })();
  const we = runPlay({ kind: 'GO', ev: 140, la: 0, spray: -25 }, pickup({ kind: 'GO', ev: 140, la: 0, spray: -25 }), [null, null, null], 0, B0, rs, wild);
  assert.deepEqual([we.errs, we.made, we.runs[0].to, we.runs[0].out], [['송구'], 0, 2, false], 'wild throw into the dugout: batter awarded second');
  assert.deepEqual([deep.runs[0].to, shallow.runs[0].to], [4, 3], 'sacrifice fly only when it is deep enough');
  // settle uses it: the runner from third holds, one out
  newGame(); g.bases = [null, null, R(3)];
  const st = settle('GO', { b: 'b1', p: 'p1', play: g3 });
  assert.deepEqual([st.text, g.outs, g.score[0], g.bases[2]?.name], ['땅볼 아웃', 1, 0, '주자3']);
  newGame(); const se = settle('GO', { b: 'b1', p: 'p1', play: we });
  assert.deepEqual([se.kind, se.text, g.bases[1]?.name, g.errs, rec.bat.b1.H], ['E', '송구 실책으로 출루!', '타자', [0, 1], 0], 'reached on an error: no hit');
  newGame(); g.bases = [null, R(2), null]; const sg = settle('1B', { b: 'b1', p: 'p1', play: tag });
  assert.ok(sg.text.includes('홈에서 태그 아웃') && g.outs === 1 && g.score[0] === 0, 'tag out at home shows in the result');
  newGame();
  const hk = {}; for (let i = 0; i < 4000; i++) { const c = contact({ arriveAt: 1000, T: [0, 0.8], bchar: i % 3 }, { at: 850 + (Math.random() - 0.5) * 120, line: [-0.4, 0.75, 0.4, 0.85], power: Math.random() });
    if (c.kind === 'HR') hk.HR = (hk.HR || 0) + 1;
    else if (c.kind === '1B') { const p = runPlay(c, pickup(c), [null, null, null], 0, B0, rs), b = p.runs[0]; const k = p.errs.length ? 'E' : b.out ? 'out' : ['1B', '2B', '3B'][b.to - 1]; hk[k] = (hk[k] || 0) + 1; } }
  console.log('hits:', hk);
  // bunts: a sacrifice moves the runner up, the batter is out without an at-bat
  newGame(); g.bases[0] = { id: 'r1', name: '주자' }; settle('SAC', cur);
  assert.deepEqual([g.outs, g.bases[1]?.name, rec.bat.b1.AB, rec.bat.b1.PA], [1, '주자', 0, 1], 'sacrifice bunt');
  const bk = {}; for (let i = 0; i < 500; i++) { const k = bunt({ T: [0, 0.8], bchar: 2 }, { line: [-0.4, 0.8, 0.4, 0.8] }).kind; bk[k] = (bk[k] || 0) + 1; }
  assert.ok(bk.SAC > bk['1B'] && bk.foul && !bk.miss, 'bunt on the ball: mostly sacrifices, some fouls and bunt hits');
  assert.equal(bunt({ T: [0, 0.8] }, { line: [-0.4, 0.5, 0.4, 0.5] }).kind, 'miss', 'bat 30 cm under the ball misses');
  // left-handers: release from the other side, slider breaks the other way, pulled balls go to right field
  players.set('lp', { name: '좌투', role: 'pitcher', seen: 0, bat: 1, pit: 1, hand: 'L' }); batters = ['b1'];
  throwPitch('lp', { type: 'SL', power: 1, ax: 0, ay: 0.8 }, 0);
  assert.ok(g.pitch.R[0] > 0 && g.pitch.A[0] > g.pitch.T[0], 'lefty slider starts right and breaks left');
  assert.ok(contact({ arriveAt: 1000, T: [0, 0.8], bhand: 'L' }, { at: 800, line: [-0.4, 0.8, 0.4, 0.8], power: 1 }, () => 0.9).spray > 0, 'lefty pulls to right field');
  // waiting room -> game: everyone ready starts it; away bats first; sides swap; each team's pitchers take turns
  players.clear(); newGame();
  const add = (id, team, pos) => players.set(id, { name: id, seen: 1e15, team, pos, ready: false });
  add('a1', 0, 'batter'); add('a2', 0, 'pitcher'); add('h1', 1, 'batter'); add('h2', 1, 'pitcher'); add('w', null, 'batter');
  tick(1e15); assert.ok(!g.started, 'nobody ready yet');
  for (const id of ['a1', 'a2', 'h1']) players.get(id).ready = true; tick(1e15); assert.ok(!g.started, 'h2 not ready');
  players.get('h2').ready = true; tick(1e15); assert.ok(g.started && !players.get('w').inGame, 'all ready: game on, the one without a team waits');
  assert.deepEqual([batters, pitchers], [['a1'], ['h2']], 'top: away batter vs home pitcher');
  for (let i = 0; i < 3; i++) settle('PO', { b: batters[0], p: pitchers[0] });
  tick(1e15); assert.deepEqual([batters, pitchers], [['h1'], ['a2']], 'bottom: home batter vs away pitcher');
  players.delete('a2'); tick(1e15); assert.deepEqual(pitchers, ['a1'], 'no pitcher left on the team: a teammate pitches');
  players.delete('h1'); players.delete('h2'); tick(1e15); assert.deepEqual(batters, [AI_B], 'empty team: the AI');
  players.delete('a1'); tick(1e15); assert.ok(!g.started, 'everyone gone: back to the waiting room');
  console.log('self-check ok');
  process.exit(0);
}

setInterval(() => tick(Date.now()), 50);
server.listen(PORT, () => console.log(`야구장: http://localhost:${PORT}`));
