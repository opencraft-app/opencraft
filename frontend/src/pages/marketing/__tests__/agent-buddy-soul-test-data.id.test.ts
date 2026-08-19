import { describe, expect, it } from "vitest";

import {
  englishPersonalityQuestions,
  englishPrefQuestions,
} from "@/pages/marketing/agent-buddy-soul-test-data.en";
import {
  INDONESIAN_PREF_TAG_LABELS,
  buildIndonesianQuestions,
  generateIndonesianPersonalityProfile,
  indonesianPersonalityQuestions,
  indonesianPrefQuestions,
} from "@/pages/marketing/agent-buddy-soul-test-data.id";
import { PREF_TAGS } from "@/pages/marketing/agent-buddy-soul-test-data";

/**
 * 印尼语题库刻意复用英文的计分与人设匹配实现，前提是两套题库的
 * 结构性字段（题目 id、选项 key、primary/secondary 标签）完全一致。
 * 这里把该契约锁死，避免后续只改单侧导致计分静默错位。
 */
describe("Indonesian soul test dataset", () => {
  it("keeps personality question structure aligned with the English dataset", () => {
    expect(indonesianPersonalityQuestions).toHaveLength(englishPersonalityQuestions.length);

    indonesianPersonalityQuestions.forEach((question, index) => {
      const reference = englishPersonalityQuestions[index];
      expect(question.id, `question #${index}`).toBe(reference?.id);
      expect(question.dimension, question.id).toBe(reference?.dimension);
      expect(question.options.map((option) => option.key), question.id)
        .toEqual(reference?.options.map((option) => option.key));
      expect(question.options.map((option) => option.level), question.id)
        .toEqual(reference?.options.map((option) => option.level));
      expect(question.options.map((option) => option.score), question.id)
        .toEqual(reference?.options.map((option) => option.score));
    });
  });

  it("keeps preference question scoring tags aligned with the English dataset", () => {
    expect(indonesianPrefQuestions).toHaveLength(englishPrefQuestions.length);

    indonesianPrefQuestions.forEach((question, index) => {
      const reference = englishPrefQuestions[index];
      expect(question.id, `question #${index}`).toBe(reference?.id);
      expect(question.options.map((option) => option.key), question.id)
        .toEqual(reference?.options.map((option) => option.key));
      expect(question.options.map((option) => option.primary), question.id)
        .toEqual(reference?.options.map((option) => option.primary));
      expect(question.options.map((option) => option.secondary), question.id)
        .toEqual(reference?.options.map((option) => option.secondary));
    });
  });

  it("localizes every question text without leaving CJK characters", () => {
    for (const question of [...indonesianPersonalityQuestions, ...indonesianPrefQuestions]) {
      expect(question.text, question.id).not.toMatch(/[\u4e00-\u9fff]/);
      for (const option of question.options) {
        expect(option.text, `${question.id}.${option.key}`).not.toMatch(/[\u4e00-\u9fff]/);
      }
    }
  });

  it("provides an Indonesian label for every preference tag", () => {
    for (const tag of PREF_TAGS) {
      const label = INDONESIAN_PREF_TAG_LABELS[tag];
      expect(label, tag).toBeTruthy();
      expect(label, tag).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("builds the full question set", () => {
    const questions = buildIndonesianQuestions();
    expect(questions).toHaveLength(
      indonesianPersonalityQuestions.length + indonesianPrefQuestions.length,
    );
  });

  it("joins personality phrases into a readable Indonesian sentence", () => {
    const answers = Object.fromEntries(
      indonesianPersonalityQuestions.map((question) => [question.id, "A"]),
    );
    const profile = generateIndonesianPersonalityProfile(answers);

    expect(profile).not.toMatch(/[\u4e00-\u9fff]/);
    expect(profile.endsWith(".")).toBe(true);
    // 末维话术以 `dan` 收束，保证五段拼接后仍是一个完整句子。
    expect(profile).toContain("dan ");
  });

  it("returns an empty profile when nothing is answered", () => {
    expect(generateIndonesianPersonalityProfile({})).toBe("");
  });
});
