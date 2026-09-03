import { describe, expect, it } from "vitest";

import { ENGLISH_SOULS } from "./soul-english-data";

type KoreanSoulModule = typeof import("./soul-korean-data");

async function loadKoreanSoulModule(): Promise<KoreanSoulModule | null> {
  const modulePath = "./soul-korean-data";
  return import(modulePath).catch(() => null);
}

describe("Korean soul dataset", () => {
  it("provides all 16 existing soul slugs", async () => {
    const korean = await loadKoreanSoulModule();
    expect(korean).not.toBeNull();
    expect(korean?.KOREAN_SOULS).toHaveLength(16);
    expect(korean?.KOREAN_SOULS.map((soul) => soul.slug)).toEqual(ENGLISH_SOULS.map((soul) => soul.slug));
  });

  it("exposes Korean summaries, specs, and rendered detail sections", async () => {
    const korean = await loadKoreanSoulModule();
    expect(korean).not.toBeNull();
    for (const soul of korean?.KOREAN_SOULS ?? []) {
      const reference = ENGLISH_SOULS.find((item) => item.slug === soul.slug);
      const spec = korean?.getKoreanSoulSpec(soul.slug);
      const detail = korean?.getKoreanSoulDetail(soul.slug);
      expect(soul.displayName, soul.slug).not.toBe(reference?.displayName);
      expect(soul.summary, soul.slug).toMatch(/[가-힣]/);
      expect(spec, soul.slug).not.toBeNull();
      expect(detail?.content, soul.slug).toContain("## 기본 성격");
      expect(detail?.content, soul.slug).toContain("## 에이전트 실행 설정");
    }
  });
});
