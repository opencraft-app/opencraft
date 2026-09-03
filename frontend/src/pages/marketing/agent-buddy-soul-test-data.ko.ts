import type {
  PersonalityLevel,
  PersonalityQuestion,
  PrefQuestion,
  PrefTag,
  SoulTestQuestion,
} from "@/pages/marketing/agent-buddy-soul-test-data";
import { shuffleArray } from "@/pages/marketing/agent-buddy-soul-test-data";
import {
  englishPersonalityQuestions,
  englishPrefQuestions,
} from "@/pages/marketing/agent-buddy-soul-test-data.en";

const PERSONALITY_COPY = [
  [
    "그리고 저는 멋진 옷을 입고, 큰 소리로 노래하며 걷는 사람들을 보았습니다.",
    "정말 좋네요. 저도 그렇게 자유로워졌으면 좋겠어요.",
    "무슨 일이 벌어졌는지 모르겠네요",
    "공공장소에서는 주변을 둘러싼 사람들의 관심을 가져야 한다고 생각합니다.",
  ],
  [
    "내일은 마지막 날입니다. 하지만 화면은 흰색이고, 다른 쪽으로 향합니다.",
    "밤새 걸려도 계속 걸고 잘 다룰 수 있어",
    "우리는 우리가 할 수 있는 모든 것을 하고, 그 결과를 받아들이고 있습니다.",
    "내일은 건강이 좋지 않겠나?",
  ],
  [
    "다른 사람들과 함께 식사를 할 때, 여러분은 어떻게 일하죠?",
    "저는 제 이야기를 나눌 수 있고, 다른 사람들과 대화를 나누고 있습니다.",
    "그리고 그 때, 저는 가끔 대화에 참여합니다.",
    "그리고 그 모든 것을 볼 수 있습니다.",
  ],
  [
    "그리고, 어떤 것들이 인간과의 관계에서 가장 가까운가요?",
    "그는 부드럽고 공감하고, 다른 사람의 감정을 잘 알고 있습니다.",
    "하지만, 저는 그 경계를 제대로 그리는 것을 걱정합니다.",
    "이성적이고 솔직한 사람이면,",
  ],
  [
    "인터넷에서 저를 비웃고, 저를 비웃었습니다.",
    "- 괜찮아요. - 모든 게 아닌데요.",
    "왜 그 사람이 결정해야 할까요?",
    "잠깐만요, 정말 못생긴 거 같아?",
  ],
] as const;

const PREF_COPY = [
  ["만약 여러분이 한 가지를 선택한다면, 어느 쪽이 가장 가까운가요?", "부드럽지만, 빠르게 움직일 수 있습니다.", "밤의 경주", "그리고 그 작은 불꽃은", "어둠 속에서 조용히 지켜보는 관찰자"],
  ["팀에서 어떤 역할을 할 수 있을까요?", "이 사람이 압력을 가해", "그리고 그 사람들은", "공기를 청소하는 사람이죠", "그리고 그 사람들은"],
  ["가장 공감하는 단어는 무엇일까요?", "모든 것에 대한 적절한 시기가 있습니다.", "사람들이 좋아할 필요는 없어요.", "- 내가 할 수 있는 일은", "먼저 분석, 그리고 계획"],
  ["멋진 아이디어를 생각해보면, 주변에서 무엇을 찾나요?", "바로 그 모양을 만드는 데 도움이 되길 바랍니다.", "먼저 칭찬하고, 힘을 내기 위해", "그리고 저는 여러분들이 함께 더 재미있게 만들고 싶었습니다.", "그리고 저는 이것이 실제로 가능할까요?"],
  ["만약 여러분이 압박감을 느끼면, 인공지능 동료에게 무엇을 원하시겠습니까?", "저는 여러분이 판단하고 행동하도록 이끌어내기를 원합니다.", "저는 여러분들이 편안하고 부담을 덜어주기를 바랍니다.", "유머와 놀이를 하면서 잠시 쉬는게 좋겠습니다.", "그리고 저는 여러분께 명확한 분석과 위험 평가를 보여드리고 싶습니다."],
  ["어떤 이야기가 가장 마음에 들어요?", "사랑, 신화, 미술,", "코미디, 용기 있는 생각, 즐거운 상상력", "미스터리, 논리, 논리 퍼즐", "모험, 행동, 탐구"],
  ["만약 여러분이 여러분의 파트너를 선택한다면, 어떤 존재가 가장 좋을까요?", "그리고 그 모든 것이", "그리고 그 기분을 더듬고,", "재미있고, 살아있으며, 함께하고, 즐겁게", "이 모든 것이 매우 정밀하고 이해하기 쉬운 것입니다."],
  ["연구나 일을 할 때 인공지능과 함께하는 것이 어떨까요?", "저는 여러분이 계획을 세우고,", "저는 여러분들이 격려하고 안심하고", "저는 여러분께 아이디어를 내리고,", "그리고 제가 여러분께 분석과 방법을 보여드리겠습니다."],
  ["휴식이나 여가생활에서 가장 좋아하는 것은 무엇일까요?", "전략, 통제, 속도", "그리고 저는 이 모든 것을", "웃음, 우연, 비범한 아이디어", "이 모든 것이 논리적이고 규칙적이고"],
  ["만약 여러분이 인공지능 동료로부터 조언을 구한다면, 왜 그렇게 하시겠습니까?", "그리고 제가 다음을 어떻게 해야 할지 분명히 말씀드리겠습니다.", "자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자", "저는 여러분께 재미있게 제안하거나,", "저는 이 문제를 논리적으로, 근거적으로, 그리고 위험성으로 평가해보고 싶습니다."],
] as const;

export const koreanPersonalityQuestions: PersonalityQuestion[] = englishPersonalityQuestions.map(
  (question, index) => ({
    ...question,
    text: PERSONALITY_COPY[index]![0],
    options: question.options.map((option, optionIndex) => ({
      ...option,
      text: PERSONALITY_COPY[index]![optionIndex + 1]!,
    })),
  }),
);

export const koreanPrefQuestions: PrefQuestion[] = englishPrefQuestions.map((question, index) => ({
  ...question,
  text: PREF_COPY[index]![0],
  options: question.options.map((option, optionIndex) => ({
    ...option,
    text: PREF_COPY[index]![optionIndex + 1]!,
  })),
}));

const KOREAN_PERSONALITY_PHRASES: Record<string, Record<PersonalityLevel, string>> = {
  Openness: {
    low: "우리는 우리가 익숙한 틀과 안정적인 환경을",
    mid: "우리는 새로운 것을 쉽게 받아들이고,",
    high: "새로운 것, 상상력, 미지의 가능성을",
  },
  Conscientiousness: {
    low: "우리는 어깨를 뻗어 나가고, 필요에 따라 즉흥적으로 움직일 수 있습니다.",
    mid: "이 모든 것을 할 수 있습니다.",
    high: "그리고 우리는 이 모든 것을 잘 정리하고",
  },
  Extraversion: {
    low: "그리고 그 모든 것을 볼 수 있습니다.",
    mid: "그리고 우리는 그 원격감을",
    high: "그리고 우리는 이 모든 것을",
  },
  Agreeableness: {
    low: "저는 솔직하고, 과잉으로 움직이지 않는 것을 좋아합니다.",
    mid: "우리는 우리의 경계선을 지키고,",
    high: "저는 이 모든 것을 알고 있습니다.",
  },
  "Emotional Stability": {
    low: "감정의 안테나는 날카롭기 때문에, 우리는 말을 깊이 받아들이기도 합니다.",
    mid: "한 번씩 압력을 받으면 다시 속도를 낼 수 있습니다.",
    high: "그리고 압력에 대해 좀 더 안정적이고 합리적으로 대처할 수 있습니다.",
  },
};

export const KOREAN_PREF_TAG_LABELS: Record<PrefTag, string> = {
  主导性: "주력",
  安抚性: "안심한 느낌",
  活跃性: "활발한 것 같네요",
  玩趣性: "놀이",
  锋利性: "날카로운",
  严谨性: "은 거",
  浪漫性: "로맨틱한",
  行动力: "행동 능력",
};

export function buildKoreanQuestions(): SoulTestQuestion[] {
  return [...shuffleArray(koreanPersonalityQuestions), ...shuffleArray(koreanPrefQuestions)];
}

export function generateKoreanPersonalityProfile(answers: Record<string, string>): string {
  const phrases: string[] = [];
  for (const question of koreanPersonalityQuestions) {
    const selectedKey = answers[question.id];
    const option = question.options.find((item) => item.key === selectedKey);
    if (!option) continue;
    const phrase = KOREAN_PERSONALITY_PHRASES[question.dimension]?.[option.level];
    if (phrase) phrases.push(phrase);
  }
  return phrases.join("");
}
