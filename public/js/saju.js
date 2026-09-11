/**
 * 사주 계산 엔진 — 브라우저 클라이언트 버전
 * (서버의 saju_node.js와 동일한 로직)
 */

const CHEONJGAN = ['갑', '을', '병', '정', '무', '기', '경', '신', '임', '계'];
const JIJI      = ['자', '축', '인', '묘', '진', '사', '오', '미', '신', '유', '술', '해'];
const CHEONJGAN_HJ = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
const JIJI_HJ      = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];

// 오행: 목=0, 화=1, 토=2, 금=3, 수=4
const STEM_ELEMENT   = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4];
const BRANCH_ELEMENT = [4, 2, 0, 0, 2, 1, 1, 2, 3, 3, 2, 4];
const STEM_YY        = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
const BRANCH_YY      = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
const ELEMENT_NAME   = ['목(木)', '화(火)', '토(土)', '금(金)', '수(水)'];
const JIJI_ANIMAL    = ['쥐', '소', '호랑이', '토끼', '용', '뱀', '말', '양', '원숭이', '닭', '개', '돼지'];

/**
 * 四柱 계산 메인 함수
 */
function calcSaju({ year, month, day, hour, minute }) {
  const yearPillar  = calcYearPillar(year);
  const monthPillar = calcMonthPillar(year, month, day, yearPillar.stemIndex);
  const dayPillar   = calcDayPillar(year, month, day);
  const hourPillar  = calcHourPillar(hour, minute, dayPillar.stemIndex);

  const pillars = [yearPillar, monthPillar, dayPillar, hourPillar];

  const elements = [0, 0, 0, 0, 0];
  pillars.forEach(p => {
    elements[STEM_ELEMENT[p.stemIndex]]++;
    elements[BRANCH_ELEMENT[p.branchIndex]]++;
  });

  const yinYang = { yang: 0, yin: 0 };
  pillars.forEach(p => {
    STEM_YY[p.stemIndex] === 0 ? yinYang.yang++ : yinYang.yin++;
    BRANCH_YY[p.branchIndex] === 0 ? yinYang.yang++ : yinYang.yin++;
  });

  return { yearPillar, monthPillar, dayPillar, hourPillar, elements, yinYang };
}

function calcYearPillar(year) {
  const stemIndex   = ((year - 4) % 10 + 10) % 10;
  const branchIndex = ((year - 4) % 12 + 12) % 12;
  return makePillar(stemIndex, branchIndex, '년주');
}

function calcMonthPillar(year, month, day, yearStemIndex) {
  const branchIndex = ((month + 1) % 12 + 12) % 12;
  const monthStemStarts = [2, 4, 6, 8, 0];
  const startStem = monthStemStarts[yearStemIndex % 5];
  const stemIndex = (startStem + month - 1) % 10;
  return makePillar(stemIndex, branchIndex, '월주');
}

function calcDayPillar(year, month, day) {
  const jdn = dateToJDN(year, month, day);
  const ganjiIdx = ((jdn - 2451545 + 16) % 60 + 60) % 60;
  const stemIndex   = ganjiIdx % 10;
  const branchIndex = ganjiIdx % 12;
  return makePillar(stemIndex, branchIndex, '일주');
}

function calcHourPillar(hour, minute, dayStemIndex) {
  let branchIndex;
  if (hour === 23) {
    branchIndex = 0;
  } else {
    branchIndex = Math.floor((hour + 1) / 2);
  }
  branchIndex = branchIndex % 12;
  const hourStemStarts = [0, 2, 4, 6, 8];
  const startStem = hourStemStarts[dayStemIndex % 5];
  const stemIndex = (startStem + branchIndex) % 10;
  return makePillar(stemIndex, branchIndex, '시주');
}

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

function dateToJDN(year, month, day) {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y +
    Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

/**
 * 사주 四柱 HTML 렌더링
 */
function renderSajuPillars(saju) {
  const pillars = [saju.yearPillar, saju.monthPillar, saju.dayPillar, saju.hourPillar];
  return pillars.map(p => `
    <div class="pillar-card">
      <div class="pillar-label">${p.label}</div>
      <div class="pillar-ganji-kr">${p.stem}${p.branch}</div>
      <div class="pillar-ganji-hj">${p.stemHJ}${p.branchHJ}</div>
      <div class="pillar-element">${p.element}</div>
    </div>
  `).join('');
}
