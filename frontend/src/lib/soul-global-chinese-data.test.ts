import { describe, expect, it } from "vitest";
import {
  GLOBAL_CHINESE_SOULS,
  getGlobalChineseSoulDetail,
  getGlobalChineseSoulSpec,
} from "./soul-global-chinese-data";

describe("soul-global-chinese-data", () => {
  it("provides a Chinese spec and SOUL.md content for every local soul", () => {
    expect(GLOBAL_CHINESE_SOULS).toHaveLength(16);

    for (const soul of GLOBAL_CHINESE_SOULS) {
      const spec = getGlobalChineseSoulSpec(soul.slug);
      const detail = getGlobalChineseSoulDetail(soul.slug);

      expect(spec, soul.slug).not.toBeNull();
      expect(detail, soul.slug).not.toBeNull();
      expect(detail?.displayName).toBe(soul.displayName);
      // content uses Chinese section headers (matches the global-CN buildSoulMd)
      expect(detail?.content).toContain("## 核心气质");
      expect(detail?.content).toContain("## Agent 运行偏好");
      // Chinese text present somewhere in the spec
      expect(spec?.coreTemperament).toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("shares the westernized slug namespace with the EN catalog", () => {
    const enSlugs = [
      "GOAT", "LOL", "MEOW", "OH-NO", "WHY", "NO-FILTER", "MONK", "MOMMY",
      "SOLO", "STEADY", "LIVEWIRE", "CHAMELEON", "LOVE-R", "ZZZZ", "GRINDER", "GO-MODE",
    ];
    expect(GLOBAL_CHINESE_SOULS.map((s) => s.slug)).toEqual(enSlugs);
  });

  it("returns null for unknown slugs", () => {
    expect(getGlobalChineseSoulSpec("UNKNOWN")).toBeNull();
    expect(getGlobalChineseSoulDetail("UNKNOWN")).toBeNull();
  });
});
