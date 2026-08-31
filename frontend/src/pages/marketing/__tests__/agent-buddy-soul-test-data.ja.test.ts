import { describe, expect, it } from "vitest";

import { PREF_TAGS } from "@/pages/marketing/agent-buddy-soul-test-data";
import {
  englishPersonalityQuestions,
  englishPrefQuestions,
} from "@/pages/marketing/agent-buddy-soul-test-data.en";

type JapaneseTestModule = typeof import("@/pages/marketing/agent-buddy-soul-test-data.ja");

async function loadJapaneseTestModule(): Promise<JapaneseTestModule | null> {
  const modulePath = "@/pages/marketing/agent-buddy-soul-test-data.ja";
  return import(modulePath).catch(() => null);
}

describe("Japanese soul test dataset", () => {
  it("keeps the scoring structure aligned while localizing every question", async () => {
    const japanese = await loadJapaneseTestModule();
    expect(japanese).not.toBeNull();
    expect(japanese?.japanesePersonalityQuestions).toHaveLength(englishPersonalityQuestions.length);
    expect(japanese?.japanesePrefQuestions).toHaveLength(englishPrefQuestions.length);

    japanese?.japanesePersonalityQuestions.forEach((question, index) => {
      const reference = englishPersonalityQuestions[index];
      expect(question.id).toBe(reference?.id);
      expect(question.text).not.toBe(reference?.text);
      expect(question.text).toMatch(/[\u3040-\u30ff]/);
      expect(question.options.map((option) => option.key)).toEqual(reference?.options.map((option) => option.key));
    });
    japanese?.japanesePrefQuestions.forEach((question, index) => {
      const reference = englishPrefQuestions[index];
      expect(question.id).toBe(reference?.id);
      expect(question.text).not.toBe(reference?.text);
      expect(question.text).toMatch(/[\u3040-\u30ff]/);
      expect(question.options.map((option) => [option.key, option.primary, option.secondary]))
        .toEqual(reference?.options.map((option) => [option.key, option.primary, option.secondary]));
    });
  });

  it("provides Japanese labels and a complete Japanese profile", async () => {
    const japanese = await loadJapaneseTestModule();
    expect(japanese).not.toBeNull();
    for (const tag of PREF_TAGS) {
      expect(japanese?.JAPANESE_PREF_TAG_LABELS[tag]).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
    }
    const answers = Object.fromEntries(
      (japanese?.japanesePersonalityQuestions ?? []).map((question) => [question.id, "A"]),
    );
    expect(japanese?.generateJapanesePersonalityProfile(answers)).toMatch(/。$/);
    expect(japanese?.buildJapaneseQuestions()).toHaveLength(15);
  });
});
