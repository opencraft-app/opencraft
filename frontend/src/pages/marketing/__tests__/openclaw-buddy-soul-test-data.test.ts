import { describe, expect, it } from "vitest";
import {
  PREF_TAG_MAX_SCORES,
  PREF_TAGS,
  calculateMatchedSoul,
  calculatePrefScores,
  categorizePrefScores,
  generatePersonalityProfile,
  personalityQuestions,
  prefQuestions,
} from "@/pages/marketing/openclaw-buddy-soul-test-data";

describe("openclaw-buddy-soul-test-data", () => {
  it("keeps the SkillHub test shape: 5 personality questions and 10 preference questions", () => {
    expect(personalityQuestions).toHaveLength(5);
    expect(prefQuestions).toHaveLength(10);
    expect([...personalityQuestions, ...prefQuestions]).toHaveLength(15);
    expect(personalityQuestions.every((question) => question.options.length === 3)).toBe(true);
    expect(prefQuestions.every((question) => question.options.length === 4)).toBe(true);
  });

  it("scores primary and secondary preference tags with SkillHub weights", () => {
    const scores = calculatePrefScores({
      q1: "C",
      q4: "A",
    });

    expect(scores["玩趣性"]).toBe(2);
    expect(scores["活跃性"]).toBe(1);
    expect(scores["行动力"]).toBe(2);
    expect(scores["主导性"]).toBe(1);
    expect(scores["严谨性"]).toBe(0);
  });

  it("matches a dominant action-oriented answer set to YYDS", () => {
    const answers = Object.fromEntries(prefQuestions.map((question) => [question.id, "A"]));

    expect(calculateMatchedSoul(answers)).toBe("YYDS");
  });

  it("derives each preference tag's maximum score from the question set", () => {
    expect(PREF_TAG_MAX_SCORES).toEqual({
      主导性: 18,
      安抚性: 20,
      活跃性: 11,
      玩趣性: 19,
      锋利性: 11,
      严谨性: 19,
      浪漫性: 10,
      行动力: 12,
    });
  });

  it("builds the five-dimension personality profile", () => {
    const answers = Object.fromEntries(personalityQuestions.map((question) => [question.id, "A"]));
    const profile = generatePersonalityProfile(answers);

    expect(profile).toContain("脑洞丰富");
    expect(profile).toContain("执行力强");
    expect(profile).toContain("情绪稳定");
  });

  it("categorizes preference scores into high, mid, and low bands", () => {
    const scores = Object.fromEntries(PREF_TAGS.map((tag) => [tag, 0])) as Record<
      (typeof PREF_TAGS)[number],
      number
    >;
    scores["主导性"] = 12;
    scores["安抚性"] = 6;
    scores["严谨性"] = 5;
    scores["浪漫性"] = 6;
    scores["活跃性"] = 4;
    scores["锋利性"] = 3;

    expect(categorizePrefScores(scores)).toMatchObject({
      主导性: "high",
      安抚性: "mid",
      严谨性: "low",
      浪漫性: "high",
      活跃性: "mid",
      锋利性: "low",
    });
  });
});
