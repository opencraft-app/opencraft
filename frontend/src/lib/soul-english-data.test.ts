import { describe, expect, it } from "vitest";
import { ENGLISH_SOULS, getEnglishSoulDetail, getEnglishSoulSpec } from "./soul-english-data";

describe("soul-english-data", () => {
  it("provides an English spec and SOUL.md content for every local soul", () => {
    expect(ENGLISH_SOULS).toHaveLength(16);

    for (const soul of ENGLISH_SOULS) {
      const spec = getEnglishSoulSpec(soul.slug);
      const detail = getEnglishSoulDetail(soul.slug);

      expect(spec, soul.slug).not.toBeNull();
      expect(detail, soul.slug).not.toBeNull();
      expect(detail?.displayName).toBe(soul.displayName);
      expect(detail?.content).toContain("## Core Temperament");
      expect(detail?.content).toContain("## Agent Runtime Preference");
      expect(detail?.content).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });
});
