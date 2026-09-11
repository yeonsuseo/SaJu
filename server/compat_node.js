/**
 * 궁합 점수 & 해석 엔진
 * Node.js 서버용 버전
 *
 * 총점 100점:
 *   일간 천간합충 25점
 *   오행 조화     25점
 *   지지 합충형   30점
 *   음양 균형     20점
 */

const { STEM_ELEMENT, BRANCH_ELEMENT } = require('./saju_node');

// ══════════════════════════════════════════════════════════
// 지지 관계 데이터
// ══════════════════════════════════════════════════════════

// 삼합 (三合) — 세 지지가 모이면 강한 오행 생성
const SAMHAP = [
  [2, 6, 10],   // 인오술 → 화(火)
  [11, 3, 7],   // 해묘미 → 목(木)
  [8, 0, 4],    // 신자진 → 수(水)
  [5, 9, 1],    // 사유축 → 금(金)
];

// 육합 (六合) — 두 지지 조합
const YUGHAP = [
  [0, 1],   // 자축 → 토
  [2, 11],  // 인해 → 목
  [3, 10],  // 묘술 → 화
  [4, 9],   // 진유 → 금
  [5, 8],   // 사신 → 수
  [6, 7],   // 오미 → 토
];

// 충 (沖) — 정반대 충돌
const CHUNG = [
  [0, 6],   // 자오충
  [1, 7],   // 축미충
  [2, 8],   // 인신충
  [3, 9],   // 묘유충
  [4, 10],  // 진술충
  [5, 11],  // 사해충
];

// 형 (刑) — 서로 형벌 관계
const HYEONG = [
  [2, 5, 8],  // 인사신 삼형
  [1, 4, 10], // 축술미 삼형
  [0, 3],     // 자묘 무례지형
  [6, 6],     // 오 자형
  [11, 11],   // 해 자형
  [7, 7],     // 미 자형 (중복이라 실제론 단독)
];

// 해 (害) — 서로 해치는 관계
const HAE = [
  [0, 11],  // 자해 — 자와해
  [1, 10],  // 축술 — 원진
  [2, 9],   // 인유
  [3, 8],   // 묘신
  [4, 7],   // 진미
  [5, 6],   // 사오
];

// 오행 상생 (生) — [생하는 오행, 생받는 오행]
// 목생화, 화생토, 토생금, 금생수, 수생목
const SAENGSEANG = [[0,1],[1,2],[2,3],[3,4],[4,0]];

// 오행 상극 (剋) — [극하는 오행, 극받는 오행]
// 목극토, 토극수, 수극화, 화극금, 금극목
const SANGGEUK = [[0,2],[2,4],[4,1],[1,3],[3,0]];

// ══════════════════════════════════════════════════════════
// 메인 함수
// ══════════════════════════════════════════════════════════

/**
 * @param {object} ownerSaju  - calcSaju 결과
 * @param {object} visitorSaju - calcSaju 결과
 * @param {string} ownerGender
 * @param {string} visitorGender
 * @returns {{ score, grade, gradeLabel, summary, detail }}
 */
function calcCompatibility(ownerSaju, visitorSaju, ownerGender, visitorGender) {
  const d1 = calcDayGanScore(ownerSaju, visitorSaju);     // 일간합충 25점
  const d2 = calcElementScore(ownerSaju, visitorSaju);    // 오행조화 25점
  const d3 = calcBranchScore(ownerSaju, visitorSaju);     // 지지합충 30점
  const d4 = calcYinYangScore(ownerSaju, visitorSaju);    // 음양균형 20점

  const score = Math.min(100, Math.max(0,
    d1.score + d2.score + d3.score + d4.score
  ));

  const { grade, gradeLabel, emoji } = getGrade(score);
  const summary = makeSummary(score, d1, d2, d3, d4, emoji);

  // 종합 장점 및 주의할 점 (장단점)
  const pros = [
    ...(d1.pros || []).slice(0, 2),
    ...(d2.pros || []).slice(0, 2),
    ...(d3.pros || []).slice(0, 1),
    ...(d4.pros || []).slice(0, 1)
  ];

  const cons = [
    ...(d1.cons || []).slice(0, 2),
    ...(d2.cons || []).slice(0, 2),
    ...(d3.cons || []).slice(0, 1),
    ...(d4.cons || []).slice(0, 1)
  ];

  return {
    score,
    grade,
    gradeLabel,
    summary,
    pros,
    cons,
    detail: {
      dayGan:   d1,
      element:  d2,
      branch:   d3,
      yinYang:  d4,
      pros,
      cons
    }
  };
}

// ── 1. 일간 천간 합충 (25점) ──────────────────────────────
function calcDayGanScore(ownerSaju, visitorSaju) {
  const s1 = ownerSaju.dayPillar.stemIndex;
  const s2 = visitorSaju.dayPillar.stemIndex;

  let score = 12;
  let relation = '그냥 평범';
  let desc = '둘 일간이 딱히 붙지도 싸우지도 않고 무난무난하다.';
  let pros = ['서로 크게 안 건드리는 편안한 사이', '싸울 일 없이 자연스럽게 지낼 수 있다'];
  let cons = ['운명처럼 팍 꽂히는 맛은 쫌 약하다', '친해지려면 니가 먼저 말 걸고 그래라'];

  // 천간 합 (|s1-s2| == 5 이면 합)
  if (Math.abs(s1 - s2) === 5) {
    score = 25;
    const hapElements = ['토(土)', '금(金)', '수(水)', '목(木)', '화(火)'];
    const hapIdx = Math.min(s1, s2);
    relation = `천간합 뙇! → ${hapElements[hapIdx]} 기운 생성`;
    desc = `둘 일간이 자석맹키로 촥 달라붙어가 ${hapElements[hapIdx]} 기운을 새로 맹글어낸다. 질긴 인연의 끈으로 묶인 사이다!`;
    pros = ['본능적으로 서로한테 확 끌리는 자석 같은 케미', '같이 있으면 억수로 편안하면서도 설렌다', '둘이 뭉치면 새로운 시너지가 팍팍 터진다'];
    cons = ['너무 찰떡이라 서로한테 지나치게 집착할 수 있다', '주변 사람들 눈에 지들끼리만 노는 걸로 보일 수 있다'];
  }
  // 천간 충 (|s1-s2| == 6 이면 충)
  else if (Math.abs(s1 - s2) === 6) {
    score = 5;
    relation = '천간충 (정면충돌)';
    desc = '둘 일간이 정면으로 팍 부딪힌다! 처음엔 티격태격하겠지만 서로 다른 점 인정해주면 확 큰다.';
    pros = ['서로 자극 팍팍 주면서 불꽃 튀는 역동적인 사이', '심심할 틈이 전혀 없는 스펙터클한 케미'];
    cons = ['별것도 아닌 일에 핏대 세우고 싸울 수 있다', '상대방 방식 인정 안 해주면 맨날 피터진다', '감정 소모 심하니까 말 한마디도 곱게 해라'];
  }
  // 오행 상생
  else {
    const e1 = STEM_ELEMENT[s1];
    const e2 = STEM_ELEMENT[s2];
    const isSaeng = SAENGSEANG.some(([a,b]) => (a===e1&&b===e2) || (a===e2&&b===e1));
    const isGeuk  = SANGGEUK.some(([a,b]) => (a===e1&&b===e2) || (a===e2&&b===e1));

    if (isGeuk) {
      score = 8;
      relation = '오행 상극 (기운 밀어냄)';
      desc = '둘 타고난 일간 기운이 서로 극하는 사이다. 에너지 쏘는 방향이 달라서 쫌 조율해야 된다.';
      pros = ['성향이 180도 달라서 신기하고 호기심 생기는 사이', '상대방 통해서 내 모난 구석을 돌아보고 성장한다'];
      cons = ['마음 씀씀이가 달라서 "와 저러노?" 소리 절로 나온다', '서로 쥐고 흔들라고(통제) 하면 바로 파탄 난다', '초반에 쫌 어색하고 불편할 수 있다'];
    } else if (isSaeng) {
      score = 20;
      relation = '오행 상생 (찰떡 보완)';
      desc = '둘 오행이 서로 기운을 북돋아주는 상생 사이다. 같이 붙어있을수록 기운이 펄펄 난다!';
      pros = ['함께할수록 시너지가 팍팍 붙는 축복받은 관계', '말 안 해도 자연스럽게 챙겨주고 도와주게 된다', '오래 보면 볼수록 진국이고 편안하다'];
      cons = ['한 놈만 일방적으로 퍼주는 호구 될 수도 있다', '상대가 다 해주니까 혼자선 게을러질 수 있다'];
    }
    // 같은 오행
    else if (e1 === e2) {
      score = 16;
      relation = '같은 오행 (동족의 피)';
      desc = '둘 일간 오행이 똑같다! 서로 속마음은 기가 막히게 잘 아는데, 비슷한 고집 땜에 부딪힐 때 있다.';
      pros = ['말 길게 안 해도 "아 저놈 왜 저러는지 알겠다" 딱 통한다', '관심사랑 생활 리듬이 비슷해서 같이 놀기 좋다'];
      cons = ['둘 다 단점까지 똑같아서 서로 못 고쳐준다', '너무 닮아서 거울 보는 것 같아 가끔 질릴 수 있다'];
    }
  }

  return {
    score,
    maxScore: 25,
    category: '일간 천간 궁합',
    relation,
    desc,
    pros,
    cons,
    ownerStem: ownerSaju.dayPillar.stem + ' (' + ownerSaju.dayPillar.stemHJ + ')',
    visitorStem: visitorSaju.dayPillar.stem + ' (' + visitorSaju.dayPillar.stemHJ + ')',
  };
}

// ── 2. 오행 조화 (25점) ──────────────────────────────────
function calcElementScore(ownerSaju, visitorSaju) {
  // 두 사람 8자 오행 합산
  const combined = [0, 0, 0, 0, 0];
  for (let i = 0; i < 5; i++) {
    combined[i] = ownerSaju.elements[i] + visitorSaju.elements[i];
  }

  const total = combined.reduce((a, b) => a + b, 0); // 16
  const maxEl = Math.max(...combined);
  const minEl = Math.min(...combined);

  // 균형도: 최대와 최소의 차이가 적을수록 좋음
  const diff = maxEl - minEl;
  // diff: 0~16 → score: 25~5
  const balanceScore = Math.max(5, 25 - diff * 2);

  // 상생 관계 카운트
  let saengCount = 0;
  const ownerPillars = [ownerSaju.yearPillar, ownerSaju.monthPillar, ownerSaju.dayPillar, ownerSaju.hourPillar];
  const visPillars   = [visitorSaju.yearPillar, visitorSaju.monthPillar, visitorSaju.dayPillar, visitorSaju.hourPillar];

  ownerPillars.forEach(op => {
    visPillars.forEach(vp => {
      const e1 = STEM_ELEMENT[op.stemIndex];
      const e2 = STEM_ELEMENT[vp.stemIndex];
      if (SAENGSEANG.some(([a,b]) => (a===e1&&b===e2)||(a===e2&&b===e1))) saengCount++;
    });
  });

  const score = Math.min(25, Math.round(balanceScore));

  // 부족한 오행 / 넘치는 오행 찾기
  const ELEM_NAMES = ['목(木)', '화(火)', '토(土)', '금(金)', '수(水)'];
  const minIdx = combined.indexOf(minEl);
  const maxIdx = combined.indexOf(maxEl);

  const desc = diff <= 2
    ? `목화토금수 오행이 억수로 골고루 들어차 있다. 서로 부족한 기운을 기가 막히게 채워준다!`
    : diff <= 4
    ? `전체적으로 기운 배치가 조화롭다. ${ELEM_NAMES[minIdx]} 기운이 쫌 아쉽지만 큰 탈은 없다.`
    : `${ELEM_NAMES[maxIdx]} 기운이 넘쳐흐르고 ${ELEM_NAMES[minIdx]} 기운이 바닥이다. 서로 쫌 맞춰가는 노력이 필요하데이.`;

  const elPros = diff <= 2
    ? ['오행 밸런스가 황금비율이라 같이 있으면 일상이 든든하다', '서로 기운이 맞물려 들어가서 어떤 일도 거뜬히 헤쳐나간다', '안정감이 억수로 뛰어난 조합']
    : diff <= 4
    ? ['전반적으로 무난하고 편안한 오행 조합', `${ELEM_NAMES[minIdx]} 기운만 서로 챙겨주면 더 바랄 게 없다`]
    : [`${ELEM_NAMES[maxIdx]}의 화끈한 에너지로 밀어붙이는 불도저 케미`, '부족한 기운을 의식하고 챙기면 둘 다 성장한다'];

  const elCons = diff <= 2
    ? ['너무 안정적이라 가끔 지루하게 느껴질 수 있다', '스릴이나 짜릿한 맛은 쫌 부족하다']
    : diff <= 4
    ? [`${ELEM_NAMES[minIdx]} 기운이 약해가 피곤할 때 텐션 떨어질 수 있다`]
    : [`${ELEM_NAMES[maxIdx]} 과잉으로 한 성격 할 때 브레이크가 안 걸린다`, `${ELEM_NAMES[minIdx]} 기운이 부족해서 생활 리듬 엇박자 날 수 있다`, '기운 쏠림 땜에 감정 기복 조심해야 된다'];

  return {
    score,
    maxScore: 25,
    category: '오행 조화',
    combined,
    elementNames: ELEM_NAMES,
    dominantElement: ELEM_NAMES[maxIdx],
    weakElement: ELEM_NAMES[minIdx],
    desc,
    pros: elPros,
    cons: elCons,
  };
}

// ── 3. 지지 합충형해 (30점) ──────────────────────────────
function calcBranchScore(ownerSaju, visitorSaju) {
  const ownerBranches   = [ownerSaju.yearPillar, ownerSaju.monthPillar, ownerSaju.dayPillar, ownerSaju.hourPillar].map(p => p.branchIndex);
  const visitorBranches = [visitorSaju.yearPillar, visitorSaju.monthPillar, visitorSaju.dayPillar, visitorSaju.hourPillar].map(p => p.branchIndex);

  let score = 15;
  const events = [];

  ownerBranches.forEach(ob => {
    visitorBranches.forEach(vb => {
      SAMHAP.forEach(trio => {
        if (trio.includes(ob) && trio.includes(vb) && ob !== vb) {
          score += 5;
          events.push({ type: '삼합', score: +5, desc: `${JIJI_NAMES[ob]}-${JIJI_NAMES[vb]} 삼합(대통합)` });
        }
      });
      YUGHAP.forEach(pair => {
        if ((pair[0]===ob && pair[1]===vb) || (pair[0]===vb && pair[1]===ob)) {
          score += 4;
          events.push({ type: '육합', score: +4, desc: `${JIJI_NAMES[ob]}-${JIJI_NAMES[vb]} 육합(찰떡결합)` });
        }
      });
      CHUNG.forEach(pair => {
        if ((pair[0]===ob && pair[1]===vb) || (pair[0]===vb && pair[1]===ob)) {
          score -= 5;
          events.push({ type: '충', score: -5, desc: `${JIJI_NAMES[ob]}-${JIJI_NAMES[vb]} 충(쾅 부딪힘)` });
        }
      });
      HAE.forEach(pair => {
        if ((pair[0]===ob && pair[1]===vb) || (pair[0]===vb && pair[1]===ob)) {
          score -= 3;
          events.push({ type: '해', score: -3, desc: `${JIJI_NAMES[ob]}-${JIJI_NAMES[vb]} 해(은근히 긁힘)` });
        }
      });
    });
  });

  score = Math.min(30, Math.max(0, score));

  const positiveEvents = events.filter(e => e.score > 0);
  const negativeEvents = events.filter(e => e.score < 0);

  let desc, pros, cons;
  if (positiveEvents.length > negativeEvents.length) {
    desc = `현실 지지에서 합(${positiveEvents.map(e=>e.type).join(', ')})이 촥촥 붙는다! 둘이 일상에서 호흡이 억수로 잘 맞다.`;
    pros = ['지지의 합이 많아가 일상생활 리듬이 찰떡이다', '같이 밥 먹고 놀 때 쿵짝이 기가 막히게 맞는다', '둘이 붙어있으면 든든하고 힘이 난다'];
    cons = ['너무 쿵짝이 잘 맞아가 딴 사람 말 안 들을 수 있다', '서로에 대한 기대가 커질수록 삐지기도 쉽다'];
  } else if (negativeEvents.length > positiveEvents.length) {
    desc = `지지에서 충돌(${negativeEvents.map(e=>e.type).join(', ')})이 쫌 보인다. 서로 생활 방식이나 말버릇 이해해주려는 노력이 필수다!`;
    pros = ['부딪히는 만큼 서로한테 강렬한 인상을 남긴다', '팽팽한 긴장감이 있어 관계가 절대 안 처진다'];
    cons = ['생활 습관이나 가치관 차이로 마찰이 잦을 수 있다', '한 번 감정 상하면 뒤끝 생기기 쉬우니 주의해라', '있는 그대로의 모습을 받아들이는 연습이 필요하다'];
  } else if (events.length === 0) {
    desc = '지지 간에 큰 합도 충도 없이 무난~하다. 편안하고 평화로운 사이다.';
    pros = ['큰 풍파 없이 잔잔하고 편안하게 오래 간다', '서로 사생활 터치 안 하고 쿨하게 지낸다'];
    cons = ['불꽃 튀는 로맨스나 스펙터클함은 쫌 덜하다', '서로 더 살갑게 다가가려는 노력이 필요하다'];
  } else {
    desc = `합치기도 하고 부딪히기도 하는 롤러코스터 케미다! 끌릴 땐 미치게 끌리다가도 싸울 땐 화끈하다.`;
    pros = ['애증이 공존하는 치명적인 매력의 케미', '늘 새롭고 지루할 틈이 없는 흥미진진한 사이'];
    cons = ['좋을 때와 싸울 때의 텐션 차이가 롤러코스터급이다', '서로 감정 컨트롤 잘해야 오래 간다'];
  }

  return {
    score,
    maxScore: 30,
    category: '지지 합충 관계',
    events: events.slice(0, 5),
    desc,
    pros,
    cons,
  };
}

// 지지 이름
const JIJI_NAMES = ['자(子)', '축(丑)', '인(寅)', '묘(卯)', '진(辰)', '사(巳)', '오(午)', '미(未)', '신(申)', '유(酉)', '술(戌)', '해(亥)'];

// ── 4. 음양 균형 (20점) ──────────────────────────────────
function calcYinYangScore(ownerSaju, visitorSaju) {
  const o = ownerSaju.yinYang;    // { yang, yin }
  const v = visitorSaju.yinYang;

  // 합산 음양
  const totalYang = o.yang + v.yang;
  const totalYin  = o.yin  + v.yin;

  // 이상적: 양8~9 : 음7~8 (약간 양이 많은 것이 좋음)
  const diff = Math.abs(totalYang - totalYin);
  // diff: 0~16 → score: 20~5
  const score = Math.max(5, 20 - diff * 2);

  let desc, pros, cons;
  if (diff <= 2) {
    desc = '음과 양이 황금 밸런스를 이룬다! 둘의 에너지가 조화롭게 섞여든다.';
    pros = ['음양이 고르게 분포돼서 밀당 없이 자연스럽다', '서로의 에너지가 톱니바퀴처럼 딱 맞아떨어진다', '외향과 내향의 밸런스가 훌륭하다'];
    cons = ['너무 안정적이라 가끔 변화가 필요할 수 있다'];
  } else if (totalYang > totalYin + 4) {
    desc = '양(陽)의 기운이 펄펄 넘친다! 화끈하고 활동적이지만, 가끔은 차분하게 캄다운할 필요가 있데이.';
    pros = ['둘이 모이면 텐션 폭발하고 추진력 장난 아니다', '시원시원하고 뒤끝 없는 화끈한 커플'];
    cons = ['둘 다 욱하고 충동적으로 일 저지를 수 있다', '서로 차분하게 속마음 듣는 시간이 부족하다', '너무 질주하다가 지칠 수 있다'];
  } else if (totalYin > totalYang + 4) {
    desc = '음(陰)의 기운이 묵직하다. 섬세하고 생각은 깊은데, 겉으로 표현을 팍팍 해야 오해가 안 쌓인다.';
    pros = ['서로 감정을 세심하게 챙겨주는 사려 깊은 사이', '둘만의 비밀이나 깊은 속마음 나누기 좋다', '차분하고 정적인 편안함'];
    cons = ['둘 다 속으로 삭히다가 오해 키울 수 있다', '먼저 결정 안 하고 서로 미루기 십상이다', '야외 활동이나 신나는 데이트가 부족할 수 있다'];
  } else {
    desc = '음양 균형이 꽤 괜찮다. 둘 에너지가 무난하게 섞여드는 사이제.';
    pros = ['생활 리듬이 비슷해서 일상에서 부딪힘이 적다', '강약 조절이 자연스럽게 되는 조합'];
    cons = ['특별히 튀는 시너지는 덜할 수 있다', '자기 개성을 더 솔직하게 드러내봐라'];
  }

  return {
    score: Math.round(score),
    maxScore: 20,
    category: '음양 균형',
    totalYang,
    totalYin,
    ownerYang: o.yang,
    ownerYin: o.yin,
    visitorYang: v.yang,
    visitorYin: v.yin,
    desc,
    pros,
    cons,
  };
}

// ── 등급 ──────────────────────────────────────────────────
function getGrade(score) {
  if (score >= 90) return { grade: 'S', gradeLabel: '천생연분이다 아이가!', emoji: '🌟' };
  if (score >= 75) return { grade: 'A', gradeLabel: '찰떡궁합이네!', emoji: '✨' };
  if (score >= 60) return { grade: 'B', gradeLabel: '그럭저럭 살만하다', emoji: '🌙' };
  if (score >= 45) return { grade: 'C', gradeLabel: '쫌 삐걱거리겠는데?', emoji: '⚡' };
  return { grade: 'D', gradeLabel: '와이라노... 전생에 웬수?', emoji: '🌀' };
}

// ── 한줄 요약 ─────────────────────────────────────────────
function makeSummary(score, d1, d2, d3, d4, emoji) {
  const templates = {
    S: [
      `${emoji} 와 대박이다! 하늘이 점지해준 짝꿍 아이가! 기운이 억수로 잘 맞아떨어진다.`,
      `${emoji} 전생에 나라를 구했나? 둘이 사주 합이 찰떡궁합 그 자체다!`,
    ],
    A: [
      `${emoji} 이 정도면 억수로 좋은 인연이다. 같이 지낼수록 시너지 팍팍 난다!`,
      `${emoji} 좋은 기운이 솔솔 분다! 서로 부족한 거 딱딱 채워주는 이상적인 사이제.`,
    ],
    B: [
      `${emoji} 뭐 쏘쏘하네! 서로 성질만 안 부리면 편안~하이 오래 갈 사이다.`,
      `${emoji} 무난무난한 궁합이다. 니 하기 나름이니까 서로 양보 쫌 하고 그래라.`,
    ],
    C: [
      `${emoji} 어라? 성격 쫌 부딪히겠는데? 지 고집만 피우면 싸움 난다 조심해라!`,
      `${emoji} 달라도 너무 다르다 아이가! 속 끓이지 말고 솔직하게 털어놔라.`,
    ],
    D: [
      `${emoji} 와이라노 진짜... 전생에 서로 뺨 때린 웬수였나 ㄷㄷ 배려 억수로 필요하다.`,
      `${emoji} 사주 기운이 정반대로 튄다! 진짜 찐사랑 아니면 쫌 힘들 수도 있데이.`,
    ],
  };

  const { grade } = getGrade(score);
  const list = templates[grade];
  return list[Math.floor(Math.random() * list.length)];
}

module.exports = { calcCompatibility };
