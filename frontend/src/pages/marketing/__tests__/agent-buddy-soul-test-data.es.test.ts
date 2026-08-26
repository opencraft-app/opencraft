import { describe, expect, it } from "vitest";

import { PREF_TAGS } from "@/pages/marketing/agent-buddy-soul-test-data";
import {
  englishPersonalityQuestions,
  englishPrefQuestions,
} from "@/pages/marketing/agent-buddy-soul-test-data.en";

type SpanishTestModule = typeof import("@/pages/marketing/agent-buddy-soul-test-data.es");

async function loadSpanishTestModule(): Promise<SpanishTestModule | null> {
  const modulePath = "@/pages/marketing/agent-buddy-soul-test-data.es";
  return import(modulePath).catch(() => null);
}

describe("Spanish soul test dataset", () => {
  it("keeps the scoring structure aligned while localizing all questions", async () => {
    const spanish = await loadSpanishTestModule();
    expect(spanish).not.toBeNull();
    expect(spanish?.spanishPersonalityQuestions).toHaveLength(englishPersonalityQuestions.length);
    expect(spanish?.spanishPrefQuestions).toHaveLength(englishPrefQuestions.length);

    spanish?.spanishPersonalityQuestions.forEach((question, index) => {
      const reference = englishPersonalityQuestions[index];
      expect(question.id).toBe(reference?.id);
      expect(question.text).not.toBe(reference?.text);
      expect(question.options.map((option) => option.key)).toEqual(reference?.options.map((option) => option.key));
    });
    spanish?.spanishPrefQuestions.forEach((question, index) => {
      const reference = englishPrefQuestions[index];
      expect(question.id).toBe(reference?.id);
      expect(question.text).not.toBe(reference?.text);
      expect(question.options.map((option) => [option.key, option.primary, option.secondary]))
        .toEqual(reference?.options.map((option) => [option.key, option.primary, option.secondary]));
    });
  });

  it("provides Spanish labels and a complete Spanish profile", async () => {
    const spanish = await loadSpanishTestModule();
    expect(spanish).not.toBeNull();
    for (const tag of PREF_TAGS) {
      expect(spanish?.SPANISH_PREF_TAG_LABELS[tag]).toBeTruthy();
      expect(spanish?.SPANISH_PREF_TAG_LABELS[tag]).not.toMatch(/[\u4e00-\u9fff]/);
    }
    const answers = Object.fromEntries(
      (spanish?.spanishPersonalityQuestions ?? []).map((question) => [question.id, "A"]),
    );
    expect(spanish?.generateSpanishPersonalityProfile(answers)).toMatch(/\.$/);
    expect(spanish?.buildSpanishQuestions()).toHaveLength(15);
  });
});
