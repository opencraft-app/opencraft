import { describe, expect, it } from "vitest";

import { PREF_TAGS } from "@/pages/marketing/agent-buddy-soul-test-data";
import {
  englishPersonalityQuestions,
  englishPrefQuestions,
} from "@/pages/marketing/agent-buddy-soul-test-data.en";

type KoreanTestModule = typeof import("@/pages/marketing/agent-buddy-soul-test-data.ko");

async function loadKoreanTestModule(): Promise<KoreanTestModule | null> {
  const modulePath = "@/pages/marketing/agent-buddy-soul-test-data.ko";
  return import(modulePath).catch(() => null);
}

describe("Korean soul test dataset", () => {
  it("keeps the scoring structure aligned while localizing every question", async () => {
    const korean = await loadKoreanTestModule();
    expect(korean).not.toBeNull();
    expect(korean?.koreanPersonalityQuestions).toHaveLength(englishPersonalityQuestions.length);
    expect(korean?.koreanPrefQuestions).toHaveLength(englishPrefQuestions.length);
    korean?.koreanPersonalityQuestions.forEach((question, index) => {
      const reference = englishPersonalityQuestions[index];
      expect(question.id).toBe(reference?.id);
      expect(question.text).toMatch(/[가-힣]/);
      expect(question.options.map((option) => option.key)).toEqual(reference?.options.map((option) => option.key));
    });
  });

  it("provides Korean labels and a complete Korean profile", async () => {
    const korean = await loadKoreanTestModule();
    expect(korean).not.toBeNull();
    for (const tag of PREF_TAGS) expect(korean?.KOREAN_PREF_TAG_LABELS[tag]).toMatch(/[가-힣]/);
    const answers = Object.fromEntries(
      (korean?.koreanPersonalityQuestions ?? []).map((question) => [question.id, "A"]),
    );
    expect(korean?.generateKoreanPersonalityProfile(answers)).toMatch(/다\.$/);
    expect(korean?.buildKoreanQuestions()).toHaveLength(15);
  });
});
