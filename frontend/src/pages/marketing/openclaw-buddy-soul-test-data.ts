/**
 * Soul 人格测试题目与匹配算法。
 *
 * 数据与规则对齐 SkillHub:
 * `client/src/components/OpenClaw/SoulTest/data.ts`
 */

export type PersonalityLevel = "high" | "mid" | "low";

export interface PersonalityOption {
  key: string;
  text: string;
  level: PersonalityLevel;
  score: number;
}

export interface PersonalityQuestion {
  id: string;
  dimension: string;
  text: string;
  options: PersonalityOption[];
}

export type PrefTag =
  | "主导性"
  | "安抚性"
  | "活跃性"
  | "玩趣性"
  | "锋利性"
  | "严谨性"
  | "浪漫性"
  | "行动力";

export interface PrefOption {
  key: string;
  text: string;
  primary: PrefTag;
  secondary: PrefTag;
}

export interface PrefQuestion {
  id: string;
  text: string;
  options: PrefOption[];
}

export type SoulTestQuestion = PersonalityQuestion | PrefQuestion;
export type SoulWeight = Record<PrefTag, number>;
export type PrefCategory = "high" | "mid" | "low";

export const personalityQuestions: PersonalityQuestion[] = [
  {
    id: "p1",
    dimension: "开放性",
    text: "街上有人穿着奇装异服，还放声高歌，您会如何看待？",
    options: [
      { key: "A", text: "哇塞，太酷了吧！我也想这么自由！", level: "high", score: 2 },
      { key: "B", text: "ta这样做一定有ta的道理", level: "mid", score: 1 },
      { key: "C", text: "这个人应当注意公序良俗。", level: "low", score: 0 },
    ],
  },
  {
    id: "p2",
    dimension: "责任心",
    text: "明天就要交付任务了，现在你的电脑还一片空白，并且非常困，怎么办？",
    options: [
      { key: "A", text: "哪怕通宵也要完美交付！", level: "high", score: 2 },
      { key: "B", text: "事已至此，能做成啥样是啥样吧", level: "mid", score: 1 },
      { key: "C", text: "干脆明天装病算了", level: "low", score: 0 },
    ],
  },
  {
    id: "p3",
    dimension: "外向性",
    text: "在饭桌上，你通常？",
    options: [
      { key: "A", text: "主动交流，与他人互动", level: "high", score: 2 },
      { key: "B", text: "偶尔参与互动", level: "mid", score: 1 },
      { key: "C", text: "低调且安静地咀嚼", level: "low", score: 0 },
    ],
  },
  {
    id: "p4",
    dimension: "宜人性",
    text: "您认为您对他人的态度倾向是？",
    options: [
      { key: "A", text: "温柔体贴，容易理解他人情绪", level: "high", score: 2 },
      { key: "B", text: "偶尔关心，但保持界限", level: "mid", score: 1 },
      { key: "C", text: "理性或直接，他人与自己无关", level: "low", score: 0 },
    ],
  },
  {
    id: "p5",
    dimension: "情绪稳定性",
    text: "有人在网上恶意抨击你的长相，并评价你为\"普信人士\"，你内心更偏向？",
    options: [
      { key: "A", text: "无所谓，长相又不能当饭吃", level: "high", score: 2 },
      { key: "B", text: "心里略有难受，外人凭什么评判我？", level: "mid", score: 1 },
      { key: "C", text: "我真的是什么很丑的人吗？", level: "low", score: 0 },
    ],
  },
];

const personalityPhrases: Record<string, Record<PersonalityLevel, string>> = {
  开放性: {
    low: "您可能偏向保守，喜欢熟悉和稳定，",
    mid: "您对新鲜事物有着开放的态度，但同时保持谨慎，",
    high: "您可能爱探索新奇事物，脑洞丰富，喜欢创新，",
  },
  责任心: {
    low: "喜欢偏随意些，处理事情随性，",
    mid: "能够根据情况调整处事方法，",
    high: "较多情况下条理清晰，执行力强，",
  },
  外向性: {
    low: "性子安静内敛，像一个冷静的观察者，",
    mid: "社交态度能够随环境而动，",
    high: "对社交保持开放的态度，也收获了朋友们的喜爱，",
  },
  宜人性: {
    low: "更喜欢理性直接，讨厌多余的废话，",
    mid: "懂得适度关心他人，但保持界限，",
    high: "您温柔体贴，容易理解他人情绪，",
  },
  情绪稳定性: {
    low: "情绪感知力较高，可能内心比较敏感。",
    mid: "遇到事时偶尔紧张，但能自我调整。",
    high: "同时情绪稳定，冷静理智应对压力。",
  },
};

export const prefQuestions: PrefQuestion[] = [
  {
    id: "q1",
    text: "如果必须选择一种动物，您觉得您更像？",
    options: [
      { key: "A", text: "兔子", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "狼", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "小猫", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "猫头鹰", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q2",
    text: "在一个团队中，您更偏向哪种角色？",
    options: [
      { key: "A", text: "摆烂者", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "推进者", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "管理者", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "规划者", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q3",
    text: "您更认同以下哪句？",
    options: [
      { key: "A", text: "一切都是最好的安排。", primary: "主导性", secondary: "锋利性" },
      { key: "B", text: "不必讨好世界，我自有我的秩序", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "活跃气氛制造者", primary: "活跃性", secondary: "玩趣性" },
      { key: "D", text: "分析、规划型", primary: "严谨性", secondary: "行动力" },
    ],
  },
  {
    id: "q4",
    text: "当你有了一个绝妙的、无与伦比的点子时，你希望别人？",
    options: [
      { key: "A", text: "快立刻帮我落地！", primary: "行动力", secondary: "主导性" },
      { key: "B", text: "先先夸夸我！", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "和我一起开脑洞！", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "给我分析一下可行性", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q5",
    text: "困难或压力出现时，你希望AI/朋友？",
    options: [
      { key: "A", text: "拍板推进，带你行动", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "安抚情绪、降低压力", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "用幽默和趣味分散注意", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "提供清晰分析、风险评估", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q6",
    text: "你最喜欢哪类影视或文学作品？",
    options: [
      { key: "A", text: "古风/修仙/浪漫爱情", primary: "安抚性", secondary: "浪漫性" },
      { key: "B", text: "喜剧/幽默/脑洞奇幻", primary: "玩趣性", secondary: "活跃性" },
      { key: "C", text: "悬疑/推理/逻辑类", primary: "锋利性", secondary: "严谨性" },
      { key: "D", text: "冒险/动作/探索类", primary: "行动力", secondary: "主导性" },
    ],
  },
  {
    id: "q7",
    text: "如果让你选一个理想的伴侣，你希望ta？",
    options: [
      { key: "A", text: "决策果断，主导节奏", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "温暖细腻，关心氛围", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "幽默搞笑，活跃互动", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "严谨分析，条理清晰", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q8",
    text: "当你学习或工作时，你希望AI如何陪伴？",
    options: [
      { key: "A", text: "主动安排计划、指导流程", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "提供鼓励和安慰", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "提供趣味点子、调节气氛", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "提供分析和方法论", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q9",
    text: "你在娱乐休闲中偏好？",
    options: [
      { key: "A", text: "追求掌控节奏或策略类游戏", primary: "主导性", secondary: "锋利性" },
      { key: "B", text: "享受温暖陪伴类体验", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "喜欢搞笑、脑洞或随机性玩法", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "偏好逻辑推理或规则严谨的体验", primary: "严谨性", secondary: "行动力" },
    ],
  },
  {
    id: "q10",
    text: "当AI/朋友提出建议时，你希望？",
    options: [
      { key: "A", text: "拍板推进，直接告诉下一步", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "先关心你的感受再建议", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "以趣味或幽默方式提出建议", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "给出逻辑分析和风险评估", primary: "严谨性", secondary: "锋利性" },
    ],
  },
];

export const soulWeights: Record<string, SoulWeight> = {
  YYDS: { 主导性: 5, 安抚性: 1, 活跃性: 3, 玩趣性: 2, 锋利性: 4, 严谨性: 3, 浪漫性: 1, 行动力: 5 },
  HHHH: { 主导性: 2, 安抚性: 2, 活跃性: 5, 玩趣性: 4, 锋利性: 2, 严谨性: 1, 浪漫性: 1, 行动力: 3 },
  MIAO: { 主导性: 1, 安抚性: 1, 活跃性: 4, 玩趣性: 5, 锋利性: 1, 严谨性: 1, 浪漫性: 1, 行动力: 4 },
  MUM: { 主导性: 1, 安抚性: 5, 活跃性: 2, 玩趣性: 1, 锋利性: 1, 严谨性: 2, 浪漫性: 3, 行动力: 2 },
  "OH-NO": { 主导性: 2, 安抚性: 2, 活跃性: 1, 玩趣性: 1, 锋利性: 2, 严谨性: 5, 浪漫性: 1, 行动力: 2 },
  WHY: { 主导性: 2, 安抚性: 1, 活跃性: 1, 玩趣性: 1, 锋利性: 3, 严谨性: 5, 浪漫性: 1, 行动力: 2 },
  GRASS: { 主导性: 4, 安抚性: 1, 活跃性: 2, 玩趣性: 1, 锋利性: 5, 严谨性: 3, 浪漫性: 1, 行动力: 4 },
  MONK: { 主导性: 1, 安抚性: 4, 活跃性: 1, 玩趣性: 1, 锋利性: 1, 严谨性: 4, 浪漫性: 3, 行动力: 1 },
  MALO: { 主导性: 1, 安抚性: 2, 活跃性: 5, 玩趣性: 5, 锋利性: 1, 严谨性: 1, 浪漫性: 1, 行动力: 4 },
  GOOD: { 主导性: 1, 安抚性: 4, 活跃性: 1, 玩趣性: 1, 锋利性: 1, 严谨性: 2, 浪漫性: 2, 行动力: 3 },
  GOGO: { 主导性: 2, 安抚性: 1, 活跃性: 4, 玩趣性: 3, 锋利性: 2, 严谨性: 1, 浪漫性: 1, 行动力: 5 },
  "LOVE-R": { 主导性: 1, 安抚性: 4, 活跃性: 2, 玩趣性: 1, 锋利性: 1, 严谨性: 1, 浪漫性: 5, 行动力: 1 },
  "WORK-er": { 主导性: 2, 安抚性: 1, 活跃性: 1, 玩趣性: 1, 锋利性: 2, 严谨性: 2, 浪漫性: 1, 行动力: 5 },
  ZZZZ: { 主导性: 1, 安抚性: 3, 活跃性: 1, 玩趣性: 1, 锋利性: 1, 严谨性: 4, 浪漫性: 1, 行动力: 2 },
  FAKE: { 主导性: 2, 安抚性: 3, 活跃性: 4, 玩趣性: 2, 锋利性: 1, 严谨性: 3, 浪漫性: 2, 行动力: 2 },
  SOLO: { 主导性: 1, 安抚性: 5, 活跃性: 1, 玩趣性: 1, 锋利性: 1, 严谨性: 2, 浪漫性: 4, 行动力: 1 },
};

export const PREF_TAGS: PrefTag[] = [
  "主导性",
  "安抚性",
  "活跃性",
  "玩趣性",
  "锋利性",
  "严谨性",
  "浪漫性",
  "行动力",
];

export function isPersonalityQuestion(question: SoulTestQuestion): question is PersonalityQuestion {
  return question.id.startsWith("p");
}

export function calculatePrefScores(answers: Record<string, string>): Record<PrefTag, number> {
  const scores: Record<PrefTag, number> = {
    主导性: 0,
    安抚性: 0,
    活跃性: 0,
    玩趣性: 0,
    锋利性: 0,
    严谨性: 0,
    浪漫性: 0,
    行动力: 0,
  };

  for (const question of prefQuestions) {
    const selectedKey = answers[question.id];
    if (!selectedKey) continue;
    const option = question.options.find((item) => item.key === selectedKey);
    if (!option) continue;
    scores[option.primary] += 2;
    scores[option.secondary] += 1;
  }

  return scores;
}

export function calculateMatchedSoul(answers: Record<string, string>): string {
  const userVector = toVector(calculatePrefScores(answers));
  let bestSoulId = "YYDS";
  let bestSimilarity = -1;

  for (const [soulId, weights] of Object.entries(soulWeights)) {
    const similarity = cosineSimilarity(userVector, toVector(weights));
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestSoulId = soulId;
    }
  }

  return bestSoulId;
}

export function generatePersonalityProfile(answers: Record<string, string>): string {
  const phrases: string[] = [];

  for (const question of personalityQuestions) {
    const selectedKey = answers[question.id];
    if (!selectedKey) continue;
    const option = question.options.find((item) => item.key === selectedKey);
    if (!option) continue;
    const phrase = personalityPhrases[question.dimension]?.[option.level];
    if (phrase) phrases.push(phrase);
  }

  return phrases.join("");
}

export function categorizePrefScores(scores: Record<PrefTag, number>): Record<PrefTag, PrefCategory> {
  const result = {} as Record<PrefTag, PrefCategory>;

  for (const tag of PREF_TAGS) {
    const ratio = scores[tag] / 20;
    if (ratio >= 0.6) {
      result[tag] = "high";
    } else if (ratio >= 0.3) {
      result[tag] = "mid";
    } else {
      result[tag] = "low";
    }
  }

  return result;
}

export function shuffleArray<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const current = shuffled[i];
    const replacement = shuffled[j];
    if (current === undefined || replacement === undefined) continue;
    shuffled[i] = replacement;
    shuffled[j] = current;
  }
  return shuffled;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index++) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dotProduct += left * right;
    normA += left * left;
    normB += right * right;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

function toVector(scores: Record<PrefTag, number>): number[] {
  return PREF_TAGS.map((tag) => scores[tag]);
}
