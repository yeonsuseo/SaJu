const path = require('path');
const fs   = require('fs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, 'saju.db');

// ── sql.js 초기화 (동기식 래퍼) ─────────────────────────
let db;
let SQL;

async function initDb() {
  const initSqlJs = require('sql.js');
  SQL = await initSqlJs();

  // 기존 DB 파일이 있으면 로드
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  // 테이블 생성
  db.run(`
    CREATE TABLE IF NOT EXISTS maps (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      gender       TEXT NOT NULL,
      birth_year   INTEGER NOT NULL,
      birth_month  INTEGER NOT NULL,
      birth_day    INTEGER NOT NULL,
      birth_hour   INTEGER NOT NULL,
      birth_minute INTEGER NOT NULL,
      saju_json    TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS visitors (
      id           TEXT PRIMARY KEY,
      map_id       TEXT NOT NULL,
      name         TEXT NOT NULL,
      gender       TEXT NOT NULL,
      birth_year   INTEGER NOT NULL,
      birth_month  INTEGER NOT NULL,
      birth_day    INTEGER NOT NULL,
      birth_hour   INTEGER NOT NULL,
      birth_minute INTEGER NOT NULL,
      saju_json    TEXT NOT NULL,
      score        INTEGER NOT NULL,
      grade        TEXT NOT NULL,
      summary      TEXT NOT NULL,
      detail_json  TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );
  `);

  persist();
  console.log('✅ 데이터베이스 준비 완료');
}

// DB를 파일에 저장
function persist() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ── 헬퍼: SELECT 결과를 객체 배열로 변환 ─────────────────
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function run(sql, params = []) {
  db.run(sql, params);
  persist();
}

// ── Map 생성 ──────────────────────────────────────────────────
function createMap({ name, gender, birth_year, birth_month, birth_day, birth_hour, birth_minute, saju_json }) {
  const id  = generateId();
  const now = new Date().toISOString();
  run(
    `INSERT INTO maps (id, name, gender, birth_year, birth_month, birth_day, birth_hour, birth_minute, saju_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, gender, birth_year, birth_month, birth_day, birth_hour, birth_minute, JSON.stringify(saju_json), now]
  );
  return id;
}

// ── Map 조회 ──────────────────────────────────────────────────
function getMap(id) {
  const map = queryOne('SELECT * FROM maps WHERE id = ?', [id]);
  if (!map) return null;
  map.saju_json = JSON.parse(map.saju_json);
  return map;
}

// ── 방문자 추가 ───────────────────────────────────────────────
function addVisitor({ map_id, name, gender, birth_year, birth_month, birth_day, birth_hour, birth_minute, saju_json, score, grade, summary, detail_json }) {
  const id  = generateId();
  const now = new Date().toISOString();
  run(
    `INSERT INTO visitors
      (id, map_id, name, gender, birth_year, birth_month, birth_day, birth_hour, birth_minute, saju_json, score, grade, summary, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, map_id, name, gender, birth_year, birth_month, birth_day, birth_hour, birth_minute,
     JSON.stringify(saju_json), score, grade, summary, JSON.stringify(detail_json), now]
  );
  return id;
}

// ── 방문자 단건 조회 ──────────────────────────────────────────
function getVisitor(id) {
  const v = queryOne('SELECT * FROM visitors WHERE id = ?', [id]);
  if (!v) return null;
  v.saju_json   = JSON.parse(v.saju_json);
  v.detail_json = JSON.parse(v.detail_json);
  return v;
}

// ── 순위 리스트 조회 (점수 내림차순) ─────────────────────────
function getRankings(map_id) {
  return queryAll(
    `SELECT id, name, gender, birth_year, score, grade, summary, created_at
     FROM visitors WHERE map_id = ? ORDER BY score DESC`,
    [map_id]
  );
}

// ── 방문자 수 조회 ────────────────────────────────────────────
function getVisitorCount(map_id) {
  const row = queryOne('SELECT COUNT(*) as cnt FROM visitors WHERE map_id = ?', [map_id]);
  return row ? row.cnt : 0;
}

// ── 짧은 ID 생성 ─────────────────────────────────────────────
function generateId() {
  return uuidv4().replace(/-/g, '').substring(0, 12);
}

module.exports = { initDb, createMap, getMap, addVisitor, getVisitor, getRankings, getVisitorCount };
