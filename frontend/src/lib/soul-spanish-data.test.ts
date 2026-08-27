import { describe, expect, it } from "vitest";

import { ENGLISH_SOULS } from "./soul-english-data";

type SpanishSoulModule = typeof import("./soul-spanish-data");

async function loadSpanishSoulModule(): Promise<SpanishSoulModule | null> {
  const modulePath = "./soul-spanish-data";
  return import(modulePath).catch(() => null);
}

describe("Spanish soul dataset", () => {
  it("provides a complete Spanish dataset for the existing 16 soul slugs", async () => {
    const spanish = await loadSpanishSoulModule();

    expect(spanish).not.toBeNull();
    expect(spanish?.SPANISH_SOULS).toHaveLength(16);
    expect(spanish?.SPANISH_SOULS.map((soul) => soul.slug)).toEqual(
      ENGLISH_SOULS.map((soul) => soul.slug),
    );
  });

  it("exposes localized details without English display-copy fallback", async () => {
    const spanish = await loadSpanishSoulModule();
    expect(spanish).not.toBeNull();

    for (const soul of spanish?.SPANISH_SOULS ?? []) {
      const reference = ENGLISH_SOULS.find((item) => item.slug === soul.slug);
      const spec = spanish?.getSpanishSoulSpec(soul.slug);
      const detail = spanish?.getSpanishSoulDetail(soul.slug);

      expect(soul.displayName, soul.slug).not.toBe(reference?.displayName);
      expect(soul.summary, soul.slug).not.toBe(reference?.summary);
      expect(spec, soul.slug).not.toBeNull();
      expect(detail?.content, soul.slug).toContain("## Temperamento esencial");
      expect(detail?.content, soul.slug).toContain("## Preferencia de ejecución del agente");
      expect(detail?.content, soul.slug).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });
});
