const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://oqsdpbrnfedhgytdfcwt.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Os_PWBAR9VZ1nC3euV4Gsw_By-okN9r';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Supabase 연결 초기화 및 상태 확인 ─────────────────────────
async function initDb() {
  try {
    const { data, error } = await supabase.from('maps').select('id').limit(1);
    if (error) {
      if (error.code === '42P01' || error.message.includes('does not exist') || error.message.includes('schema cache')) {
        console.warn('\n⚠️ [Supabase 주의] maps 또는 visitors 테이블이 아직 생성되지 않았습니다!');
        console.warn('   Supabase SQL Editor에서 제공해 드린 SQL 스크립트를 먼저 실행해 주십시오.\n');
      } else {
        console.error('Supabase 쿼리 오류:', error.message);
      }
    } else {
      console.log('✅ Supabase PostgreSQL 데이터베이스 연결 완료!');
    }
  } catch (err) {
    console.error('Supabase 초기화 확인 중 예외 발생:', err.message);
  }
}

// ── 짧은 ID 생성 (12자리 영문/숫자) ─────────────────────────
function generateId() {
  return uuidv4().replace(/-/g, '').substring(0, 12);
}

// 헬퍼: JSONB 필드 안전 파싱
function safeParseJson(data, field) {
  if (data && typeof data[field] === 'string') {
    try {
      data[field] = JSON.parse(data[field]);
    } catch (e) {
      // 이미 객체이거나 파싱 불가 시 유지
    }
  }
}

// ── Map 생성 ──────────────────────────────────────────────────
async function createMap({ name, gender, birth_year, birth_month, birth_day, birth_hour, birth_minute, saju_json }) {
  const id = generateId();
  const { error } = await supabase.from('maps').insert({
    id,
    name,
    gender,
    birth_year,
    birth_month,
    birth_day,
    birth_hour,
    birth_minute,
    saju_json,
  });

  if (error) {
    console.error('Supabase createMap 에러:', error);
    throw error;
  }
  return id;
}

// ── Map 조회 ──────────────────────────────────────────────────
async function getMap(id) {
  const { data, error } = await supabase
    .from('maps')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('Supabase getMap 에러:', error);
    throw error;
  }
  if (!data) return null;

  safeParseJson(data, 'saju_json');
  return data;
}

// ── 방문자 추가 ───────────────────────────────────────────────
async function addVisitor({ map_id, name, gender, birth_year, birth_month, birth_day, birth_hour, birth_minute, saju_json, score, grade, summary, detail_json }) {
  const id = generateId();
  const { error } = await supabase.from('visitors').insert({
    id,
    map_id,
    name,
    gender,
    birth_year,
    birth_month,
    birth_day,
    birth_hour,
    birth_minute,
    saju_json,
    score,
    grade,
    summary,
    detail_json
  });

  if (error) {
    console.error('Supabase addVisitor 에러:', error);
    throw error;
  }
  return id;
}

// ── 방문자 단건 조회 ──────────────────────────────────────────
async function getVisitor(id) {
  const { data, error } = await supabase
    .from('visitors')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('Supabase getVisitor 에러:', error);
    throw error;
  }
  if (!data) return null;

  safeParseJson(data, 'saju_json');
  safeParseJson(data, 'detail_json');
  return data;
}

// ── 순위 리스트 조회 (점수 내림차순, 동일점수 시 선착순) ─────
async function getRankings(map_id) {
  const { data, error } = await supabase
    .from('visitors')
    .select('id, name, gender, birth_year, score, grade, summary, created_at')
    .eq('map_id', map_id)
    .order('score', { ascending: false })
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Supabase getRankings 에러:', error);
    throw error;
  }
  return data || [];
}

// ── 방문자 수 조회 ────────────────────────────────────────────
async function getVisitorCount(map_id) {
  const { count, error } = await supabase
    .from('visitors')
    .select('*', { count: 'exact', head: true })
    .eq('map_id', map_id);

  if (error) {
    console.error('Supabase getVisitorCount 에러:', error);
    throw error;
  }
  return count || 0;
}

module.exports = {
  initDb,
  createMap,
  getMap,
  addVisitor,
  getVisitor,
  getRankings,
  getVisitorCount
};