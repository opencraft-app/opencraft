import type {
  PersonalityQuestion,
  PrefQuestion,
  PrefTag,
  PersonalityLevel,
  SoulWeight,
  PrefCategory,
} from "@/pages/marketing/agent-buddy-soul-test-data";
import { toEnglishSlug } from "@/lib/soul-slug-mapping";
import {
  PREF_TAG_MAX_SCORES,
  PREF_TAGS,
  isPersonalityQuestion,
  shuffleArray,
  soulWeights,
  type SoulTestQuestion,
} from "@/pages/marketing/agent-buddy-soul-test-data";

export const englishPersonalityQuestions: PersonalityQuestion[] = [
  {
    id: "p1",
    dimension: "Openness",
    text: "Someone on the street is dressed wildly and singing out loud. What is your first reaction?",
    options: [
      { key: "A", text: "That is incredible. I wish I could be that free.", level: "high", score: 2 },
      { key: "B", text: "There is probably a reason they are doing that.", level: "mid", score: 1 },
      { key: "C", text: "People should pay attention to public manners.", level: "low", score: 0 },
    ],
  },
  {
    id: "p2",
    dimension: "Conscientiousness",
    text: "A task is due tomorrow, your screen is still blank, and you are exhausted. What do you do?",
    options: [
      { key: "A", text: "Pull through, even overnight, and deliver it properly.", level: "high", score: 2 },
      { key: "B", text: "Do what I can and accept the result.", level: "mid", score: 1 },
      { key: "C", text: "Maybe I should just pretend to be sick tomorrow.", level: "low", score: 0 },
    ],
  },
  {
    id: "p3",
    dimension: "Extraversion",
    text: "At a dinner table, you usually...",
    options: [
      { key: "A", text: "Start conversations and interact with others.", level: "high", score: 2 },
      { key: "B", text: "Join in occasionally when the timing feels right.", level: "mid", score: 1 },
      { key: "C", text: "Stay low-key and quietly eat.", level: "low", score: 0 },
    ],
  },
  {
    id: "p4",
    dimension: "Agreeableness",
    text: "Which best describes your attitude toward other people?",
    options: [
      { key: "A", text: "Gentle, considerate, and quick to sense emotions.", level: "high", score: 2 },
      { key: "B", text: "Caring sometimes, but with clear boundaries.", level: "mid", score: 1 },
      { key: "C", text: "Rational and direct. Other people's business is their own.", level: "low", score: 0 },
    ],
  },
  {
    id: "p5",
    dimension: "Emotional Stability",
    text: "Someone online attacks your looks and mocks you. What happens inside?",
    options: [
      { key: "A", text: "It does not matter. Looks are not everything.", level: "high", score: 2 },
      { key: "B", text: "It hurts a little. Who are they to judge me?", level: "mid", score: 1 },
      { key: "C", text: "Wait... am I actually ugly?", level: "low", score: 0 },
    ],
  },
];

const englishPersonalityPhrases: Record<string, Record<PersonalityLevel, string>> = {
  Openness: {
    low: "You may prefer familiar structures and steady ground, ",
    mid: "You are open to new things while keeping a cautious hand on the rail, ",
    high: "You are drawn to novelty, imagination, and fresh possibilities, ",
  },
  Conscientiousness: {
    low: "you tend to move casually and improvise as needed, ",
    mid: "you can adjust your working style to the situation, ",
    high: "you are often organized, clear, and execution-oriented, ",
  },
  Extraversion: {
    low: "your social energy is quiet and observant, ",
    mid: "your social rhythm changes with the environment, ",
    high: "you are socially open and often bring energy to the room, ",
  },
  Agreeableness: {
    low: "you prefer directness and dislike unnecessary noise, ",
    mid: "you care in moderation while keeping boundaries, ",
    high: "you are gentle, considerate, and emotionally perceptive, ",
  },
  "Emotional Stability": {
    low: "and your emotional radar is sensitive, so words can land deeply.",
    mid: "and pressure may shake you for a moment, but you can recover.",
    high: "and you usually meet pressure with calm, rational steadiness.",
  },
};

export const englishPrefQuestions: PrefQuestion[] = [
  {
    id: "q1",
    text: "If you had to choose one, which feels closest to you?",
    options: [
      { key: "A", text: "A soft but fast-moving heart", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "A loyal night runner", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "A playful little spark", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "A quiet watcher in the dark", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q2",
    text: "In a team, which role do you lean toward?",
    options: [
      { key: "A", text: "The one who refuses needless pressure", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "The one who keeps things moving", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "The one who manages the vibe", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "The one who plans the route", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q3",
    text: "Which line do you agree with most?",
    options: [
      { key: "A", text: "Everything has its timing.", primary: "主导性", secondary: "锋利性" },
      { key: "B", text: "I do not need to please the world; I have my own order.", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "The room needs someone who can wake it up.", primary: "活跃性", secondary: "玩趣性" },
      { key: "D", text: "Analyze first. Plan next.", primary: "严谨性", secondary: "行动力" },
    ],
  },
  {
    id: "q4",
    text: "When you have a brilliant idea, what do you want from others?",
    options: [
      { key: "A", text: "Help me land it immediately.", primary: "行动力", secondary: "主导性" },
      { key: "B", text: "Praise it first. I need the glow.", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "Brainstorm with me and make it bigger.", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "Analyze whether it is actually feasible.", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q5",
    text: "When pressure appears, what should an AI companion do?",
    options: [
      { key: "A", text: "Make the call and pull me into action.", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "Soothe the emotion and lower the pressure.", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "Use humor and play to help me breathe.", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "Give clear analysis and risk assessment.", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q6",
    text: "Which stories do you enjoy most?",
    options: [
      { key: "A", text: "Romance, myth, elegant longing", primary: "安抚性", secondary: "浪漫性" },
      { key: "B", text: "Comedy, wild ideas, playful fantasy", primary: "玩趣性", secondary: "活跃性" },
      { key: "C", text: "Mystery, deduction, logic puzzles", primary: "锋利性", secondary: "严谨性" },
      { key: "D", text: "Adventure, action, exploration", primary: "行动力", secondary: "主导性" },
    ],
  },
  {
    id: "q7",
    text: "If you chose an ideal companion, you would want them to be...",
    options: [
      { key: "A", text: "Decisive and able to lead the rhythm.", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "Warm, delicate, and attentive to the mood.", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "Funny, vivid, and fun to interact with.", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "Structured, rigorous, and clear.", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q8",
    text: "When you study or work, how should AI stay with you?",
    options: [
      { key: "A", text: "Arrange the plan and guide the process.", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "Offer encouragement and comfort.", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "Bring ideas and lighten the atmosphere.", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "Provide analysis and method.", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q9",
    text: "For rest and entertainment, you prefer...",
    options: [
      { key: "A", text: "Strategy, control, and rhythm.", primary: "主导性", secondary: "锋利性" },
      { key: "B", text: "Warm, companion-like experiences.", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "Comedy, randomness, and strange ideas.", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "Logic, rules, and carefully built systems.", primary: "严谨性", secondary: "行动力" },
    ],
  },
  {
    id: "q10",
    text: "When an AI companion gives advice, you want it to...",
    options: [
      { key: "A", text: "Decide and tell me the next step directly.", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "Care about how I feel before advising.", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "Make the suggestion playful or funny.", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "Give logic, evidence, and risk assessment.", primary: "严谨性", secondary: "锋利性" },
    ],
  },
];

export const ENGLISH_PREF_TAG_LABELS: Record<PrefTag, string> = {
  主导性: "Dominance",
  安抚性: "Soothing",
  活跃性: "Energy",
  玩趣性: "Playfulness",
  锋利性: "Sharpness",
  严谨性: "Rigor",
  浪漫性: "Romance",
  行动力: "Action",
};

export function buildEnglishQuestions(): SoulTestQuestion[] {
  return [...shuffleArray(englishPersonalityQuestions), ...shuffleArray(englishPrefQuestions)];
}

export function calculateEnglishPrefScores(answers: Record<string, string>): Record<PrefTag, number> {
  const scores = Object.fromEntries(PREF_TAGS.map((tag) => [tag, 0])) as Record<PrefTag, number>;

  for (const question of englishPrefQuestions) {
    const selectedKey = answers[question.id];
    if (!selectedKey) continue;
    const option = question.options.find((item) => item.key === selectedKey);
    if (!option) continue;
    scores[option.primary] += 2;
    scores[option.secondary] += 1;
  }

  return scores;
}

export function calculateEnglishMatchedSoul(answers: Record<string, string>): string {
  const userVector = toVector(calculateEnglishPrefScores(answers));
  let bestCanonical = "YYDS";
  let bestSimilarity = -1;

  for (const [soulId, weights] of Object.entries(soulWeights)) {
    const similarity = cosineSimilarity(userVector, toVector(weights));
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestCanonical = soulId;
    }
  }

  // `soulWeights` is keyed by the canonical (CN) slug; the EN UI expects the
  // westernized slug so callers can look the persona up in ENGLISH_SOULS.
  return toEnglishSlug(bestCanonical);
}

export function generateEnglishPersonalityProfile(answers: Record<string, string>): string {
  const phrases: string[] = [];

  for (const question of englishPersonalityQuestions) {
    const selectedKey = answers[question.id];
    if (!selectedKey) continue;
    const option = question.options.find((item) => item.key === selectedKey);
    if (!option) continue;
    const phrase = englishPersonalityPhrases[question.dimension]?.[option.level];
    if (phrase) phrases.push(phrase);
  }

  return phrases.join("");
}

export function categorizeEnglishPrefScores(scores: Record<PrefTag, number>): Record<PrefTag, PrefCategory> {
  const result = {} as Record<PrefTag, PrefCategory>;

  for (const tag of PREF_TAGS) {
    const maxScore = PREF_TAG_MAX_SCORES[tag];
    const ratio = maxScore > 0 ? scores[tag] / maxScore : 0;
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

export function isEnglishPersonalityQuestion(question: SoulTestQuestion): boolean {
  return isPersonalityQuestion(question);
}

function toVector(scores: SoulWeight): number[] {
  return PREF_TAGS.map((tag) => scores[tag] ?? 0);
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
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
