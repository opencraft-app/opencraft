import { describe, expect, it } from "vitest";

import { ENGLISH_SOULS } from "./soul-english-data";

type JapaneseSoulModule = typeof import("./soul-japanese-data");

async function loadJapaneseSoulModule(): Promise<JapaneseSoulModule | null> {
  const modulePath = "./soul-japanese-data";
  return import(modulePath).catch(() => null);
}

describe("Japanese soul dataset", () => {
  it("provides all 16 existing soul slugs", async () => {
    const japanese = await loadJapaneseSoulModule();

    expect(japanese).not.toBeNull();
    expect(japanese?.JAPANESE_SOULS).toHaveLength(16);
    expect(japanese?.JAPANESE_SOULS.map((soul) => soul.slug)).toEqual(
      ENGLISH_SOULS.map((soul) => soul.slug),
    );
  });

  it("exposes Japanese summaries, specs, and rendered detail sections", async () => {
    const japanese = await loadJapaneseSoulModule();
    expect(japanese).not.toBeNull();

    for (const soul of japanese?.JAPANESE_SOULS ?? []) {
      const reference = ENGLISH_SOULS.find((item) => item.slug === soul.slug);
      const spec = japanese?.getJapaneseSoulSpec(soul.slug);
      const detail = japanese?.getJapaneseSoulDetail(soul.slug);

      expect(soul.displayName, soul.slug).not.toBe(reference?.displayName);
      expect(soul.summary, soul.slug).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
      expect(spec, soul.slug).not.toBeNull();
      expect(detail?.content, soul.slug).toContain("## 基本的な個性");
      expect(detail?.content, soul.slug).toContain("## エージェントの実行設定");
    }
  });
});
