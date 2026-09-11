const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./db');
const tunnel  = require('./tunnel');
const { calcSaju }          = require('./saju_node');
const { calcCompatibility } = require('./compat_node');

const app  = express();
const PORT = process.env.PORT || 4567;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ════════════════════════════════════════════════════════════
// API Routes
// ════════════════════════════════════════════════════════════

// POST /api/maps — Map 생성
app.post('/api/maps', (req, res) => {
  try {
    const { name, gender, birth_year, birth_month, birth_day, birth_hour, birth_minute } = req.body;

    if (!name || !gender || !birth_year || !birth_month || !birth_day) {
      return res.status(400).json({ error: '필수 항목이 누락되었습니다.' });
    }

    const saju = calcSaju({
      year: birth_year, month: birth_month, day: birth_day,
      hour: birth_hour || 12, minute: birth_minute || 0
    });

    const mapId = db.createMap({
      name, gender,
      birth_year, birth_month, birth_day,
      birth_hour:   birth_hour   || 12,
      birth_minute: birth_minute || 0,
      saju_json: saju
    });

    res.json({ mapId, shareUrl: `/map.html?id=${mapId}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/maps/:id — Map + 순위 조회
app.get('/api/maps/:id', (req, res) => {
  try {
    const map = db.getMap(req.params.id);
    if (!map) return res.status(404).json({ error: '존재하지 않는 Map입니다.' });

    const rankings     = db.getRankings(req.params.id);
    const visitorCount = db.getVisitorCount(req.params.id);
    const rankedList   = rankings.map((v, i) => ({ rank: i + 1, ...v }));

    res.json({ map, rankings: rankedList, visitorCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/maps/:id/visit — 방문자 사주 제출 & 궁합 계산
app.post('/api/maps/:id/visit', (req, res) => {
  try {
    const mapId = req.params.id;
    const map   = db.getMap(mapId);
    if (!map) return res.status(404).json({ error: '존재하지 않는 Map입니다.' });

    const { name, gender, birth_year, birth_month, birth_day, birth_hour, birth_minute } = req.body;

    if (!name || !gender || !birth_year || !birth_month || !birth_day) {
      return res.status(400).json({ error: '필수 항목이 누락되었습니다.' });
    }

    const visitorSaju = calcSaju({
      year: birth_year, month: birth_month, day: birth_day,
      hour: birth_hour || 12, minute: birth_minute || 0
    });

    const result = calcCompatibility(map.saju_json, visitorSaju, map.gender, gender);

    const visitorId = db.addVisitor({
      map_id: mapId, name, gender,
      birth_year, birth_month, birth_day,
      birth_hour:   birth_hour   || 12,
      birth_minute: birth_minute || 0,
      saju_json:   visitorSaju,
      score:       result.score,
      grade:       result.grade,
      summary:     result.summary,
      detail_json: result.detail
    });

    const rankings = db.getRankings(mapId);
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
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/maps/:id/rankings — 순위표만 조회
app.get('/api/maps/:id/rankings', (req, res) => {
  try {
    const map = db.getMap(req.params.id);
    if (!map) return res.status(404).json({ error: '존재하지 않는 Map입니다.' });

    const rankings   = db.getRankings(req.params.id);
    const rankedList = rankings.map((v, i) => ({ rank: i + 1, ...v }));

    res.json({ rankings: rankedList });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/visitors/:id — 방문자 결과 조회
app.get('/api/visitors/:id', (req, res) => {
  try {
    const visitor = db.getVisitor(req.params.id);
    if (!visitor) return res.status(404).json({ error: '존재하지 않는 결과입니다.' });
    if (visitor.detail_json) {
      visitor.pros = visitor.detail_json.pros || [];
      visitor.cons = visitor.detail_json.cons || [];
    }
    res.json(visitor);
  } catch (err) {
    console.error(err);
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
    // 로컬 환경일 때만 Cloudflare 임시 터널링 가동
    if (!process.env.RENDER && process.env.NODE_ENV !== 'production') {
      tunnel.startTunnel(PORT);
    }
  });
}).catch(err => {
  console.error('DB 초기화 실패:', err);
  process.exit(1);
});
