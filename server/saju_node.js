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
  const stemIndex   = ((year - 4) % 10 + 10) % 10;
  const branchIndex = ((year - 4) % 12 + 12) % 12;
  return makePillar(stemIndex, branchIndex, '년주');
}

// ── 월주 (月柱) ────────────────────────────────────────────
function calcMonthPillar(year, month, day, yearStemIndex) {
  const branchIndex = ((month + 1) % 12 + 12) % 12;
  const monthStemStarts = [2, 4, 6, 8, 0];
  const startStem = monthStemStarts[yearStemIndex % 5];
  const stemIndex = (startStem + month - 1) % 10;
  return makePillar(stemIndex, branchIndex, '월주');
}

// ── 일주 (日柱) ────────────────────────────────────────────
function calcDayPillar(year, month, day) {
  const jdn = dateToJDN(year, month, day);
  const ganjiIdx = ((jdn - 2451545 + 16) % 60 + 60) % 60;
  const stemIndex   = ganjiIdx % 10;
  const branchIndex = ganjiIdx % 12;
  return makePillar(stemIndex, branchIndex, '일주');
}

// ── 시주 (時柱) ────────────────────────────────────────────
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

function dateToJDN(year, month, day) {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y +
    Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

// ══════════════════════════════════════════════════════════
// 👑 방장 전용 4대 비밀 사주풀이 (성향 · 연애 · 과거 · 미래)
// ══════════════════════════════════════════════════════════

const DAY_STEM_TRAITS = [
  // 0: 갑(甲) 목
  {
    symbol: '우뚝 솟은 거목(大木)',
    personality: '니는 척 봐도 대장 기질이 뚝뚝 묻어난다! 굽히는 거 제일 싫어하고 한 번 마음먹은 일은 끝장을 봐야 직성이 풀린다 아이가. 겉으로는 듬직하고 리더십 쩔어 보여도, 남모르게 속으로 부담감도 팍팍 지고 사는 편이다. 황소고집만 쫌 줄이면 어디 가도 우두머리 소리 듣는데이!',
    love: '좋아하는 사람 생기면 빙빙 안 돌리고 직진하는 불도저 사랑꾼이다! 든든하게 챙겨주는 건 1등인데, 표현이 쫌 투박해서 상대방이 서운해할 때가 있다. 잔소리보다는 다정한 칭찬 한마디 얹어주면 상대가 니한테서 평생 못 빠져나온다!',
    past: '어릴 때부터 내 뜻대로 안 풀리면 속에서 천불이 났제? 남들한테 아쉬운 소리 하기 싫어가꼬 혼자 끙끙 앓으며 이 악물고 버텨온 세월이 길었다. 그 뚝심 하나로 여기까지 온 기다.',
    future: '뿌리를 깊게 내린 나무는 결국 거목이 되는 법이다! 30대 중후반 넘어가면서 니 판이 딱 깔릴 기다. 내 고집만 너무 세우지 말고 주변에 물 주는 귀인들 말만 잘 챙겨들으면 재물과 명예가 줄줄이 따라붙는다!',
    tags: ['#리더기질', '#황소고집', '#불도저직진', '#대기만성']
  },
  // 1: 을(乙) 목
  {
    symbol: '끈질긴 생명력의 화초/넝쿨',
    personality: '겉은 순둥순둥 유해보여도 속은 억수로 독하고 끈질기다! 밟혀도 다시 일어나는 잡초 같은 생명력이라 어딜 갖다 놔도 살아남는다. 눈치 빠르고 처세술이 기가 막혀서 주변 사람들 비위도 잘 맞추는데, 혼자 있을 때 속앓이하고 기운 빠지는 게 흠이다.',
    love: '정이 억수로 많아가꼬 한 번 맘 주면 간이고 쓸개고 다 빼줄라 칸다. 헌신적인 사랑꾼인데, 상대방이 내 맘 몰라주면 속으로 꽁~해가꼬 혼자 토라질 수 있다. 연애할 때 밀당 너무 당해주지 말고 가끔은 튕겨도 된다!',
    past: '남들 보기엔 편하게 산 것 같아도, 속으로는 오만 풍파 다 겪으면서 남몰래 눈물 훔친 날이 많았다. 그래도 유연하게 굽힐 줄 알았기 땜에 크게 안 부러지고 여기까지 잘 버텼다.',
    future: '주변에 든든한 큰 나무나 벽을 타고 올라가 마침내 꽃을 활짝 피울 운이다! 인맥 타고 좋은 기회가 굴러들어오니 사람 관리 잘 해둬라. 말년에 인복과 재복이 쌍으로 터질 팔자다!',
    tags: ['#외유내강', '#불사조멘탈', '#헌신적사랑', '#인복대폭발']
  },
  // 2: 병(丙) 화
  {
    symbol: '하늘에 뜬 태양(太陽)',
    personality: '화끈하고 뒤끝 없는 성격 하나는 대한민국 1등이다! 거짓말이나 답답한 꼴은 죽어도 못 보고, 기분 좋으면 온 동네 사람들 다 챙겨먹이는 분위기 메이커다. 근데 성미가 쫌 급해가꼬 욱하는 기운이 불쑥 튀어나오는 건 조심해야 된데이!',
    love: '사랑할 때도 태양처럼 뜨겁게 불타오른다! 밀당 같은 거 젬병이고 "니 내 좋아하나? 내는 니 좋다!" 바로 들이대는 스타일이다. 단, 불이 너무 뜨거우면 상대방이 데일 수 있으니 쫌만 온도를 낮추고 은근하게 다가가 봐라!',
    past: '하고 싶은 건 꼭 해야 직성이 풀려서 좌충우돌 사건사고도 꽤 많았제? 손해도 화끈하게 보고 맘고생도 팍팍 했지만, 특유의 긍정 에너지로 털고 일어난 의지의 인간이다.',
    future: '니 기운은 어둠 속에 묻혀 있을 수가 없다. 반드시 세상 밖으로 드러나서 빛을 발할 팔자다! 특히 사람들 앞에 나서거나 내 이름 걸고 하는 일에서 대박 터질 기운이 팍팍 들어온다!',
    tags: ['#태양열정', '#뒤끝제로', '#화끈한직진', '#자수성가']
  },
  // 3: 정(丁) 화
  {
    symbol: '어둠을 밝히는 등불/촛불',
    personality: '속정이 깊고 예의 바르며 은근한 카리스마가 장난 아니다! 겉으로는 차분하고 얌전해 보여도 속에는 뜨거운 불씨를 품고 있어서, 한 번 집중하면 무서운 집중력을 발휘한다. 생각과 고민이 쫌 많아서 밤에 잠 못 들 때가 있는 게 흠이다.',
    love: '은근하게 사람 마음 홀리는 매력 덩어리다! 상대방 세심하게 챙겨주는 배려심이 최고라 감동 주는 연애를 한다. 다만 서운한 걸 바로 말 안 하고 속으로 차곡차곡 적립해두다 폭발하면 감당 안 되니 제때제때 풀어라!',
    past: '남들 고민 다 들어주고 챙겨주느라 정작 내 속은 시커멓게 탄 적이 많았제? 마음고생 혼자 도맡아 하면서 내면의 심지가 억수로 단단해졌다.',
    future: '밤하늘에 등불 켜듯, 어두운 시기를 지나 니 진가를 알아봐 주는 사람들이 몰려온다. 전문 분야나 기술, 자격증 쪽으로 파고들면 크게 한자리 차지하고 존경받을 운세다!',
    tags: ['#은근카리스마', '#세심한배려', '#속정부자', '#전문가기운']
  },
  // 4: 무(戊) 토
  {
    symbol: '장엄하고 묵직한 큰 산(大山)',
    personality: '산처럼 듬직하고 무게감 있는 사람이다! 입이 무겁고 비밀도 잘 지켜서 친구들이 믿고 의지하는 큰형님/왕언니 스타일이다. 포용력은 바다만 한데, 고집부리기 시작하면 탱크로 밀어도 안 움직이는 고집불통 모드가 발동하니 융통성을 쫌 챙겨라!',
    love: '한 번 사랑에 빠지면 변치 않는 해바라기 순정파다! 바람피우는 짓은 상상도 못 하고 상대방을 든든하게 지켜준다. 근데 표현력이 영 무뚝뚝해가꼬 상대가 "니 내 사랑하긴 하나?" 묻게 만드니 애정표현 팍팍 해라!',
    past: '우직하게 제자리를 지키느라 남들이 던진 짐까지 혼자 짊어지고 낑낑댔던 기억이 많을 기다. 억울한 일도 많았겠지만 그 무게를 버텨냈기에 지금의 니가 있는 거다.',
    future: '산에는 온갖 보물과 나무가 자라는 법이다! 나이 먹을수록 자산과 안정이 단단하게 굳어지는 대기만성형 팔자다. 조급해하지 말고 니 페이스대로 뚜벅뚜벅 걸어가면 무조건 이긴다!',
    tags: ['#믿음직한산', '#해바라기순정', '#황소고집', '#대기만성부자']
  },
  // 5: 기(己) 토
  {
    symbol: '만물을 길러내는 비옥한 논밭(田園)',
    personality: '사람 참 부드럽고 싹싹하며 실속 챙기는 눈치가 백단이다! 누구하고도 모나지 않게 두루두루 잘 어울리고 다정다감해서 주변에 사람이 끊이질 않는다. 겉으론 다 맞춰주는 척해도 속으로는 계산이 딱딱 서 있는 똑순이/똑돌이다.',
    love: '상대방 밥 챙겨주고 건강 챙겨주는 모성애/부성애 넘치는 연애를 한다. 같이 있으면 세상 편안한 안식처 같은 사람이다. 근데 가끔 속마음을 너무 안 털어놔서 상대가 답답해할 수 있으니 속얘기 쫌 해라!',
    past: '이리저리 남 챙기다 보니 정작 내 밥그릇 못 챙겨서 손해 본 적이 많았제? 착한아이 콤플렉스 때문에 거절 못 하고 속앓이했던 지난날이 있었다.',
    future: '씨앗을 뿌리면 무조건 곡식이 풍성하게 여무는 비옥한 땅이다! 재물 모으는 재주가 탁월해서 푼돈 모아 목돈 만드는 기운이 아주 좋다. 중년 이후에는 남부럽지 않게 곳간 채우고 산다!',
    tags: ['#다정다감', '#실속파똑순이', '#편안한안식처', '#곳간빵빵']
  },
  // 6: 경(庚) 금
  {
    symbol: '단단한 무쇠바위/명검(名劍)',
    personality: '의리 빼면 시체고, 칼로 무 자르듯 맺고 끊음이 확실한 상남자/걸크러쉬다! 불의를 보면 못 참는 정의파라 남을 도와주다 앞장서는 경우가 많다. 결단력과 추진력은 끝내주는데, 말이 쫌 직설적이라 의도치 않게 남한테 상처 줄 때가 있으니 쿠션어 좀 써라!',
    love: '화끈하고 뒤끝 없는 쿨한 연애를 선호한다! 찌질하게 굴거나 구질구질하게 구는 건 질색팔색이다. 내 사람이다 싶으면 목숨 걸고 지키는데, 가끔 상대방 자존심 긁는 말실수만 조심하면 최고의 연인이 된다!',
    past: '불속에 들어가 두들겨 맞아야 명검이 되듯이, 인생에서 뼈아픈 시련과 단련의 시간을 통과해 왔다. 남들은 나가떨어졌을 고난도 악으로 깡으로 버텨낸 상위 1% 멘탈이다.',
    future: '용광로를 거쳐 마침내 천하를 벨 명검으로 완성되는 시기가 눈앞이다! 직장이나 사업에서 굵직한 한 방을 터뜨려 큰 성취를 이룰 팔자니 니 칼날을 믿고 밀어붙여라!',
    tags: ['#의리파명검', '#걸크러쉬', '#강철멘탈', '#인생대역전']
  },
  // 7: 신(辛) 금
  {
    symbol: '영롱하게 빛나는 보석/다이아몬드',
    personality: '자존심과 품격이 생명인 깔끔쟁이 완벽주의자다! 미적 감각이나 센스가 남다르고 두뇌 회전도 영특하다. 매사에 꼼꼼하고 빈틈이 없는데, 그만큼 예민하고 스트레스를 쉽게 받는 편이다. 작은 흠집 하나에도 속상해하는 유리멘탈 기운이 쫌 있다.',
    love: '외모나 분위기, 센스를 은근히 많이 보는 편이다! 로맨틱하고 특별한 대우를 받는 연애를 꿈꾼다. 상대방의 사소한 말투나 배려 부족에 상처를 잘 받으니, 너무 꽁해있지 말고 편하게 툭 털어놓는 게 상책이다!',
    past: '남들은 겉모습만 보고 편하게 사는 줄 알았겠지만, 그 보석 같은 빛을 내기 위해 속으로 얼마나 많은 스트레스와 완벽주의의 무게를 견뎠는지 모른다.',
    future: '흙먼지를 털어내고 마침내 세상 사람들의 찬사를 받는 보석의 운이다! 니만의 독창적인 재능이나 감각이 제대로 인정받아 빛을 발하는 황금기가 곧 도래한다!',
    tags: ['#자존심보석', '#센스천재', '#로맨틱완벽주의', '#인정받는삶']
  },
  // 8: 임(壬) 수
  {
    symbol: '끝없이 펼쳐진 망망대해(大海)',
    personality: '스케일이 크고 머리가 비상하며 융통성이 장난 아니다! 바다처럼 속이 깊어 웬만한 일에는 끄떡도 안 하고 모든 걸 품어준다. 자유로운 영혼이라 얽매이는 건 딱 질색이다. 근데 속을 도무지 알 수가 없어서 주변 사람들이 "니 무슨 생각하노?" 하고 갸우뚱할 때가 많다.',
    love: '흘러가는 강물처럼 자연스럽고 티키타카 잘 맞는 연애를 좋아한다! 집착하거나 구속하면 뒤도 안 돌아보고 떠나는 타입이다. 편안하게 친구처럼 지내면서도 결정적일 때 깊은 사랑을 보여주는 매력 부자다!',
    past: '인생의 큰 파도를 여러 번 맞았제? 남들 같으면 침몰했을 풍파 속에서도 물길을 찾아 유연하게 흘러나온 지혜로운 사람이다.',
    future: '모든 강물이 결국 큰 바다로 모이듯이, 니가 뿌려놓은 노력들이 거대한 결실로 모여들 운세다! 해외나 타지, 혹은 새로운 영역에서 큰 판을 벌려 대성할 기운이 뻗쳐있다!',
    tags: ['#바다같은도량', '#두뇌회전갑', '#자유로운영혼', '#큰판벌릴운']
  },
  // 9: 계(癸) 수
  {
    symbol: '만물을 적시는 촉촉한 봄비/옹달샘',
    personality: '머리가 비상하고 눈치가 백단이며 감수성이 억수로 풍부하다! 조용조용하게 스며들듯 주변 사람들을 편안하게 해주는 매력이 있다. 기획력과 창의력이 뛰어나 아이디어 뱅크 소리를 듣는데, 생각이 너무 꼬리를 물면 우울해질 수 있으니 멘탈 관리가 필수다.',
    love: '섬세하고 감성적인 로맨스를 즐기는 다정한 사랑꾼이다! 상대방 기분 파악을 귀신같이 잘해서 맞춤형 연애를 해준다. 근데 너무 예민해져서 혼자 소설 쓰거나 오해하는 것만 조심하면 사랑 듬뿍 받는 연애를 한다!',
    past: '속으로 혼자 눈물 삼키며 고민하던 날들이 많았제? 마음이 여려 남의 아픔까지 내 짐처럼 짊어지고 사느라 감정 소모가 꽤나 심했을 기다.',
    future: '가뭄 끝에 단비가 내리듯, 꽉 막혔던 일들이 시원하게 풀리는 해갈의 시기가 찾아온다! 니 창의력과 섬세한 재주가 귀인을 만나 날개를 달고 높이 날아오를 팔자다!',
    tags: ['#총명한봄비', '#아이디어뱅크', '#다정다감사랑꾼', '#단비같은성공']
  }
];

/**
 * 방장 전용 4대 비밀 사주풀이 생성 함수
 */
function calcOwnerReading(saju, gender, name) {
  const dayStemIdx = saju.dayPillar.stemIndex;
  const trait = DAY_STEM_TRAITS[dayStemIdx] || DAY_STEM_TRAITS[0];
  const dayAnimal = saju.dayPillar.animal;
  const yearAnimal = saju.yearPillar.animal;
  const genderWord = gender === '남' ? '머스마' : '가시나';

  // 오행 중 가장 강한 기운과 부족한 기운 분석
  const elements = saju.elements; // [목, 화, 토, 금, 수]
  let maxIdx = 0, minIdx = 0;
  for (let i = 1; i < 5; i++) {
    if (elements[i] > elements[maxIdx]) maxIdx = i;
    if (elements[i] < elements[minIdx]) minIdx = i;
  }
  const elementNames = ['나무(木)', '불(火)', '흙(土)', '쇠(金)', '물(水)'];
  const strongEl = elementNames[maxIdx];
  const weakEl   = elementNames[minIdx];

  // 성향 추가 코멘트
  const personalityAdd = ` 특히 니 사주에는 **${strongEl} 기운**이 억수로 왕성해서 그 특유의 에너지가 뿜뿜한기라! ${weakEl} 기운이 쫌 모자란 편이니, ${weakEl} 기운 채워주는 차분하고 편안한 사람들 곁에 두면 기운이 딱 맞춰진다.`;

  // 연애 추가 코멘트
  const loveAdd = ` 띠는 **${yearAnimal}띠**에 태어난 날은 **${dayAnimal}의 기운**을 타고났으니, 겉모습은 쿨한 척해도 내 사람한테는 억수로 맘 약해지는 츤데레 매력이 있다!`;

  return {
    symbol: trait.symbol,
    genderWord,
    tags: trait.tags,
    personality: {
      title: `🧠 ${name} 니 타고난 본성과 성향`,
      sub: `오행의 중심: ${trait.symbol}`,
      content: trait.personality + personalityAdd
    },
    love: {
      title: `💖 니 연애 스타일 & 끌리는 짝꿍`,
      sub: `연애 모드: ${trait.tags[2] || '#직진순정'}`,
      content: trait.love + loveAdd
    },
    past: {
      title: `⏳ 니가 버텨온 과거와 겪은 시련`,
      sub: `멘탈 강도: ${trait.tags[1] || '#강철멘탈'}`,
      content: trait.past
    },
    future: {
      title: `🚀 앞으로 터질 미래 대운과 황금기`,
      sub: `운명 흐름: ${trait.tags[3] || '#대기만성'}`,
      content: trait.future
    }
  };
}

// ── 내보내기 ──────────────────────────────────────────────
module.exports = {
  calcSaju,
  calcOwnerReading,
  CHEONJGAN, JIJI, CHEONJGAN_HJ, JIJI_HJ,
  STEM_ELEMENT, BRANCH_ELEMENT, ELEMENT_NAME, ELEMENT_COLOR,
  STEM_YY, BRANCH_YY, JIJI_ANIMAL
};