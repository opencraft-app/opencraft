import { describe, expect, it } from "vitest";
import { toCanonicalSlug, toEnglishSlug } from "./soul-slug-mapping";

describe("soul-slug-mapping", () => {
  const pairs: Array<[canonical: string, english: string]> = [
    ["YYDS", "GOAT"],
    ["HHHH", "LOL"],
    ["MIAO", "MEOW"],
    ["OH-NO", "OH-NO"],
    ["WHY", "WHY"],
    ["GRASS", "NO-FILTER"],
    ["MONK", "MONK"],
    ["MUM", "MOMMY"],
    ["SOLO", "SOLO"],
    ["GOOD", "STEADY"],
    ["MALO", "LIVEWIRE"],
    ["FAKE", "CHAMELEON"],
    ["LOVE-R", "LOVE-R"],
    ["ZZZZ", "ZZZZ"],
    ["WORK-er", "GRINDER"],
    ["GOGO", "GO-MODE"],
  ];

  it("covers all 16 personas", () => {
    expect(pairs).toHaveLength(16);
  });

  it("toEnglishSlug translates canonical slugs and is idempotent on EN slugs", () => {
    for (const [canonical, english] of pairs) {
      expect(toEnglishSlug(canonical)).toBe(english);
      // already-EN slug must map to itself (idempotent)
      expect(toEnglishSlug(english)).toBe(english);
    }
  });

  it("toCanonicalSlug translates EN slugs and is idempotent on canonical slugs", () => {
    for (const [canonical, english] of pairs) {
      expect(toCanonicalSlug(english)).toBe(canonical);
      // already-canonical slug must map to itself (idempotent)
      expect(toCanonicalSlug(canonical)).toBe(canonical);
    }
  });

  it("round-trips EN -> canonical -> EN losslessly", () => {
    for (const [canonical, english] of pairs) {
      expect(toEnglishSlug(toCanonicalSlug(english))).toBe(english);
      expect(toCanonicalSlug(toEnglishSlug(canonical))).toBe(canonical);
    }
  });

  it("passes through unknown slugs unchanged", () => {
    expect(toEnglishSlug("UNKNOWN")).toBe("UNKNOWN");
    expect(toCanonicalSlug("UNKNOWN")).toBe("UNKNOWN");
  });
});
