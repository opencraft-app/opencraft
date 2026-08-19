import { describe, expect, it } from "vitest";

import { ENGLISH_SOULS } from "./soul-english-data";
import {
  INDONESIAN_SOULS,
  getIndonesianSoulDetail,
  getIndonesianSoulSpec,
} from "./soul-indonesian-data";

describe("Indonesian soul dataset", () => {
  it("mirrors the English slug namespace so persisted slugs stay portable", () => {
    expect(INDONESIAN_SOULS.map((soul) => soul.slug)).toEqual(
      ENGLISH_SOULS.map((soul) => soul.slug),
    );
  });

  it("exposes a fully localized spec and detail for every soul", () => {
    for (const soul of INDONESIAN_SOULS) {
      const spec = getIndonesianSoulSpec(soul.slug);
      const detail = getIndonesianSoulDetail(soul.slug);

      expect(spec, soul.slug).not.toBeNull();
      expect(detail, soul.slug).not.toBeNull();
      expect(detail?.displayName, soul.slug).toBe(soul.displayName);
      expect(detail?.content, soul.slug).toContain("## Temperamen Inti");
      expect(detail?.content, soul.slug).toContain("## Preferensi Runtime Agent");
      // 印尼语文案不应残留中文字符。
      expect(detail?.content, soul.slug).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("keeps display copy free of English fallback leftovers", () => {
    for (const soul of INDONESIAN_SOULS) {
      const reference = ENGLISH_SOULS.find((item) => item.slug === soul.slug);
      expect(soul.summary, soul.slug).not.toBe(reference?.summary);
      expect(soul.displayName, soul.slug).not.toBe(reference?.displayName);
    }
  });

  it("falls back to the English spec for unknown slugs instead of throwing", () => {
    // 未知 slug 在两套数据里都不存在时返回 null，由调用方降级处理。
    expect(getIndonesianSoulSpec("NOT-A-SOUL")).toBeNull();
    expect(getIndonesianSoulDetail("NOT-A-SOUL")).toBeNull();
  });
});
