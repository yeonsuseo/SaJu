const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const db      = require('./db');
const tunnel  = require('./tunnel');
const { calcSaju, calcOwnerReading } = require('./saju_node');
const { calcCompatibility }         = require('./compat_node');

const app  = express();
const PORT = process.env.PORT || 4567;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ════════════════════════════════════════════════════════════
// API Routes
// ════════════════════════════════════════════════════════════

// POST /api/maps — Map 생성 (방장 사주풀이 및 비밀 토큰 동시 발급)
app.post('/api/maps', async (req, res) => {
  try {
    const { name, gender, birth_year, birth_month, birth_day, birth_hour, birth_minute } = req.body;

    if (!name || !gender || !birth_year || !birth_month || !birth_day) {
      return res.status(400).json({ error: '필수 항목이 누락되었습니다.' });
    }

    const saju = calcSaju({
      year: birth_year, month: birth_month, day: birth_day,
      hour: birth_hour !== undefined ? birth_hour : 12,
      minute: birth_minute !== undefined ? birth_minute : 0
    });

    // 방장 전용 4대 비밀 사주풀이 (성향, 연애, 과거, 미래)
    const reading = calcOwnerReading(saju, gender, name);
    // 방장만 인증할 수 있는 고유 비밀 토큰
    const ownerToken = uuidv4().replace(/-/g, '');

    // 사주 데이터에 안전하게 보관 (일반 조회 시에는 마스킹됨)
    const storedSaju = {
      ...saju,
      _owner_token: ownerToken,
      _reading: reading
    };

    const mapId = await db.createMap({
      name,
      gender,
      birth_year,
      birth_month,
      birth_day,
      birth_hour:   birth_hour !== undefined ? birth_hour : 12,
      birth_minute: birth_minute !== undefined ? birth_minute : 0,
      saju_json: storedSaju
    });

    res.json({
      mapId,
      shareUrl: `/map.html?id=${mapId}`,
      ownerToken, // 방장에게만 1회 즉시 전달
      reading     // 방장 전용 비밀 사주풀이
    });
  } catch (err) {
    console.error('Map 생성 오류:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/maps/:id — Map + 순위 + 사주풀이 조회 (모두가 열람 가능)
app.get('/api/maps/:id', async (req, res) => {
  try {
    const map = await db.getMap(req.params.id);
    if (!map) return res.status(404).json({ error: '존재하지 않는 Map입니다.' });

    // 4대 사주풀이 (모든 방문자가 재미있게 볼 수 있도록 제공)
    const reading = (map.saju_json && map.saju_json._reading)
      ? map.saju_json._reading
      : calcOwnerReading(map.saju_json, map.gender, map.name);

    const safeSaju = { ...map.saju_json };
    delete safeSaju._owner_token;
    delete safeSaju._reading;
    map.saju_json = safeSaju;

    const [rankings, visitorCount] = await Promise.all([
      db.getRankings(req.params.id),
      db.getVisitorCount(req.params.id)
    ]);
    const rankedList = rankings.map((v, i) => ({ rank: i + 1, ...v }));

    res.json({ map, reading, rankings: rankedList, visitorCount });
  } catch (err) {
    console.error('Map 조회 오류:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/maps/:id/reading — 방장 본인 전용 비밀 사주풀이 조회 (보안 토큰 필수)
app.get('/api/maps/:id/reading', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) {
      return res.status(401).json({ error: '방장 인증 토큰이 필요합니다.' });
    }

    const map = await db.getMap(req.params.id);
    if (!map) return res.status(404).json({ error: '존재하지 않는 Map입니다.' });

    const rawSaju = map.saju_json;
    if (!rawSaju || rawSaju._owner_token !== token) {
      return res.status(403).json({ error: '방장 본인만 열람할 수 있는 비밀 사주풀이입니다.' });
    }

    // 저장된 풀이가 없으면 즉시 동적 생성 (이전 데이터 호환)
    const reading = rawSaju._reading || calcOwnerReading(rawSaju, map.gender, map.name);

    res.json({
      name: map.name,
      reading
    });
  } catch (err) {
    console.error('사주풀이 조회 오류:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/maps/:id/visit — 방문자 사주 제출 & 궁합 계산
app.post('/api/maps/:id/visit', async (req, res) => {
  try {
    const mapId = req.params.id;
    const map   = await db.getMap(mapId);
    if (!map) return res.status(404).json({ error: '존재하지 않는 Map입니다.' });

    const { name, gender, birth_year, birth_month, birth_day, birth_hour, birth_minute } = req.body;

    if (!name || !gender || !birth_year || !birth_month || !birth_day) {
      return res.status(400).json({ error: '필수 항목이 누락되었습니다.' });
    }

    const visitorSaju = calcSaju({
      year: birth_year, month: birth_month, day: birth_day,
      hour: birth_hour !== undefined ? birth_hour : 12,
      minute: birth_minute !== undefined ? birth_minute : 0
    });

    const result = calcCompatibility(map.saju_json, visitorSaju, map.gender, gender);

    const visitorId = await db.addVisitor({
      map_id: mapId,
      name,
      gender,
      birth_year,
      birth_month,
      birth_day,
      birth_hour:   birth_hour !== undefined ? birth_hour : 12,
      birth_minute: birth_minute !== undefined ? birth_minute : 0,
      saju_json:   visitorSaju,
      score:       result.score,
      grade:       result.grade,
      summary:     result.summary,
      detail_json: result.detail
    });

    const rankings = await db.getRankings(mapId);
    const myRank   = rankings.findIndex(v => v.id === visitorId) + 1;

    res.json({
      visitorId,
      score:        result.score,
      grade:        result.grade,
      gradeLabel:   result.gradeLabel,
      summary:      result.summary,
      detail:       result.detail,
      myRank,
      totalVisitors: rankings.length
    });
  } catch (err) {
    console.error('방문자 처리 오류:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/maps/:id/rankings — 순위표만 조회
app.get('/api/maps/:id/rankings', async (req, res) => {
  try {
    const map = await db.getMap(req.params.id);
    if (!map) return res.status(404).json({ error: '존재하지 않는 Map입니다.' });

    const rankings   = await db.getRankings(req.params.id);
    const rankedList = rankings.map((v, i) => ({ rank: i + 1, ...v }));

    res.json({ rankings: rankedList });
  } catch (err) {
    console.error('순위표 조회 오류:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/visitors/:id — 방문자 결과 조회
app.get('/api/visitors/:id', async (req, res) => {
  try {
    const visitor = await db.getVisitor(req.params.id);
    if (!visitor) return res.status(404).json({ error: '존재하지 않는 결과입니다.' });
    if (visitor.detail_json) {
      visitor.pros = visitor.detail_json.pros || [];
      visitor.cons = visitor.detail_json.cons || [];
    }
    res.json(visitor);
  } catch (err) {
    console.error('방문자 조회 오류:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/system/info — 터널 URL 및 서버 정보
app.get('/api/system/info', (req, res) => {
  res.json({
    tunnelUrl: tunnel.getTunnelUrl(),
    port: PORT
  });
});

// 나머지 모든 라우트 → index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── 서버 시작 (DB 초기화 후) ─────────────────────────────
db.initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🌌 사주 궁합 서버가 시작되었습니다!`);
    console.log(`   👉 접속 포트: ${PORT}`);
    if (!process.env.RENDER && process.env.NODE_ENV !== 'production') {
      tunnel.startTunnel(PORT);
    }
  });
}).catch(err => {
  console.error('DB 초기화 실패:', err);
  process.exit(1);
});