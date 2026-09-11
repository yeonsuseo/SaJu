/**
 * 사주 계산 엔진 (四柱 — 년주·월주·일주·시주)
 * Node.js 서버용 버전
 */

// ══════════════════════════════════════════════════════════
// 기본 데이터
// ══════════════════════════════════════════════════════════

const CHEONJGAN = ['갑', '을', '병', '정', '무', '기', '경', '신', '임', '계'];
const JIJI      = ['자', '축', '인', '묘', '진', '사', '오', '미', '신', '유', '술', '해'];

// 한자
const CHEONJGAN_HJ = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
const JIJI_HJ      = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];

// 오행 (천간 인덱스 → 오행 인덱스)
// 목=0, 화=1, 토=2, 금=3, 수=4
const STEM_ELEMENT  = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]; // 갑을=목, 병정=화, 무기=토, 경신=금, 임계=수
const BRANCH_ELEMENT = [4, 2, 0, 0, 2, 1, 1, 2, 3, 3, 2, 4]; // 자=수, 축=토, 인묘=목, 진=토, 사오=화, 미=토, 신유=금, 술=토, 해=수

// 음양 (천간) 0=양, 1=음
const STEM_YY   = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
// 음양 (지지) 0=양, 1=음
const BRANCH_YY = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1];

// 오행 이름
const ELEMENT_NAME = ['목(木)', '화(火)', '토(土)', '금(金)', '수(水)'];
const ELEMENT_COLOR = ['#4CAF50', '#FF5722', '#8D6E63', '#9E9E9E', '#2196F3'];

// 12지지 동물
const JIJI_ANIMAL = ['쥐', '소', '호랑이', '토끼', '용', '뱀', '말', '양', '원숭이', '닭', '개', '돼지'];

// 12지지 시각
const HOUR_RANGES = [
  '23:00~00:59', '01:00~02:59', '03:00~04:59', '05:00~06:59',
  '07:00~08:59', '09:00~10:59', '11:00~12:59', '13:00~14:59',
  '15:00~16:59', '17:00~18:59', '19:00~20:59', '21:00~22:59'
];

// ══════════════════════════════════════════════════════════
// 核心: 四柱 계산
// ══════════════════════════════════════════════════════════

/**
 * @param {number} year
 * @param {number} month  1~12
 * @param {number} day    1~31
 * @param {number} hour   0~23
 * @param {number} minute 0~59
 * @returns {{ yearPillar, monthPillar, dayPillar, hourPillar, elements, yinYang }}
 */
function calcSaju({ year, month, day, hour, minute }) {
  const yearPillar  = calcYearPillar(year);
  const monthPillar = calcMonthPillar(year, month, day, yearPillar.stemIndex);
  const dayPillar   = calcDayPillar(year, month, day);
  const hourPillar  = calcHourPillar(hour, minute, dayPillar.stemIndex);

  const pillars = [yearPillar, monthPillar, dayPillar, hourPillar];

  // 8자 오행 분포
  const elements = [0, 0, 0, 0, 0]; // 목화토금수
  pillars.forEach(p => {
    elements[STEM_ELEMENT[p.stemIndex]]++;
    elements[BRANCH_ELEMENT[p.branchIndex]]++;
  });

  // 8자 음양 분포
  const yinYang = { yang: 0, yin: 0 };
  pillars.forEach(p => {
    STEM_YY[p.stemIndex] === 0 ? yinYang.yang++ : yinYang.yin++;
    BRANCH_YY[p.branchIndex] === 0 ? yinYang.yang++ : yinYang.yin++;
  });

  return { yearPillar, monthPillar, dayPillar, hourPillar, elements, yinYang };
}

// ── 년주 (年柱) ────────────────────────────────────────────
function calcYearPillar(year) {
  // 기준: 1984 = 갑자(0,0)
  const stemIndex   = ((year - 4) % 10 + 10) % 10;
  const branchIndex = ((year - 4) % 12 + 12) % 12;
  return makePillar(stemIndex, branchIndex, '년주');
}

// ── 월주 (月柱) ────────────────────────────────────────────
// 오호둔월법(五虎遁月法): 년간에 따라 인월(1월)의 월간 결정
// 갑/기→병인, 을/경→무인, 병/신→경인, 정/임→임인, 무/계→갑인
function calcMonthPillar(year, month, day, yearStemIndex) {
  // 월지: 인(2) = 1월 기준, 절기 간소화로 양력 월 사용
  // 실제론 절기 경계에서 바뀌지만, 간략화
  const branchIndex = ((month + 1) % 12 + 12) % 12; // 1월→인(2), 11월→자(0), 12월→축(1)

  // 인월 시작 월간 (갑기=2병, 을경=4무, 병신=6경, 정임=8임, 무계=0갑)
  const monthStemStarts = [2, 4, 6, 8, 0];
  const startStem = monthStemStarts[yearStemIndex % 5];
  const stemIndex = (startStem + month - 1) % 10;

  return makePillar(stemIndex, branchIndex, '월주');
}

// ── 일주 (日柱) ────────────────────────────────────────────
// 율리우스적일수(JDN) 이용
// 기준: 2000-01-01 = JDN 2451545 = 경진일(ganji index 16)
function calcDayPillar(year, month, day) {
  const jdn = dateToJDN(year, month, day);
  const ganjiIdx = ((jdn - 2451545 + 16) % 60 + 60) % 60;
  const stemIndex   = ganjiIdx % 10;
  const branchIndex = ganjiIdx % 12;
  return makePillar(stemIndex, branchIndex, '일주');
}

// ── 시주 (時柱) ────────────────────────────────────────────
// 오자둔시법(五子遁時法): 일간에 따라 자시의 시간 결정
// 갑/기→갑자, 을/경→병자, 병/신→무자, 정/임→경자, 무/계→임자
function calcHourPillar(hour, minute, dayStemIndex) {
  // 시지 결정 (자시=23:00~00:59)
  let branchIndex;
  if (hour === 23) {
    branchIndex = 0; // 자시
  } else {
    branchIndex = Math.floor((hour + 1) / 2);
  }
  branchIndex = branchIndex % 12;

  // 시간 시작 천간 (갑기=0갑, 을경=2병, 병신=4무, 정임=6경, 무계=8임)
  const hourStemStarts = [0, 2, 4, 6, 8];
  const startStem = hourStemStarts[dayStemIndex % 5];
  const stemIndex = (startStem + branchIndex) % 10;

  return makePillar(stemIndex, branchIndex, '시주');
}

// ── 공통 기둥 객체 생성 ────────────────────────────────────
function makePillar(stemIndex, branchIndex, label) {
  return {
    label,
    stemIndex,
    branchIndex,
    stem:       CHEONJGAN[stemIndex],
    branch:     JIJI[branchIndex],
    stemHJ:     CHEONJGAN_HJ[stemIndex],
    branchHJ:   JIJI_HJ[branchIndex],
    element:    ELEMENT_NAME[STEM_ELEMENT[stemIndex]],
    elementIdx: STEM_ELEMENT[stemIndex],
    branchElement: ELEMENT_NAME[BRANCH_ELEMENT[branchIndex]],
    branchElementIdx: BRANCH_ELEMENT[branchIndex],
    animal:     JIJI_ANIMAL[branchIndex],
    yinYang:    STEM_YY[stemIndex] === 0 ? '양(陽)' : '음(陰)',
    ganji:      CHEONJGAN[stemIndex] + JIJI[branchIndex],
    ganjiHJ:    CHEONJGAN_HJ[stemIndex] + JIJI_HJ[branchIndex],
  };
}

// ── 율리우스 적일수 계산 ──────────────────────────────────
function dateToJDN(year, month, day) {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y +
    Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

// ── 내보내기 ──────────────────────────────────────────────
module.exports = {
  calcSaju,
  CHEONJGAN, JIJI, CHEONJGAN_HJ, JIJI_HJ,
  STEM_ELEMENT, BRANCH_ELEMENT, ELEMENT_NAME, ELEMENT_COLOR,
  STEM_YY, BRANCH_YY, JIJI_ANIMAL
};
