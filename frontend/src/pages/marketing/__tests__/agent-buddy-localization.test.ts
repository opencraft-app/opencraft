import { describe, expect, it } from "vitest";

import { JAPANESE_SOULS } from "@/lib/soul-japanese-data";
import { KOREAN_SOULS } from "@/lib/soul-korean-data";
import { PREF_TAGS } from "@/pages/marketing/agent-buddy-soul-test-data";

type LocalizationModule = typeof import("@/pages/marketing/agent-buddy-localization");

async function loadLocalizationModule(): Promise<LocalizationModule | null> {
  const modulePath = "@/pages/marketing/agent-buddy-localization";
  return import(modulePath).catch(() => null);
}

describe("Buddy Soul locale resolver", () => {
  it("keeps historical MUM/MOMMY data while excluding it from new recommendations", async () => {
    const localization = await loadLocalizationModule();
    expect(localization).not.toBeNull();

    const domesticSouls = [
      { ...JAPANESE_SOULS[0]!, slug: "MUM" },
      { ...JAPANESE_SOULS[1]!, slug: "YYDS" },
    ];
    expect(localization?.getRecommendableSouls(domesticSouls, "domestic-zh").map((soul) => soul.slug)).toEqual(["YYDS"]);
    expect(domesticSouls[0]?.slug).toBe("MUM");

    for (const locale of ["global-zh", "en", "id", "es", "ja", "ko"] as const) {
      const sourceSouls = localization?.getBuddySoulPool(locale) ?? [];
      expect(sourceSouls.some((soul) => soul.slug === "MOMMY")).toBe(true);
      expect(localization?.getRecommendableSouls(sourceSouls, locale).some((soul) => soul.slug === "MOMMY")).toBe(false);
    }
  });

  it("excludes risky Souls only from new domestic recommendations", async () => {
    const localization = await loadLocalizationModule();
    expect(localization).not.toBeNull();

    const slugs = ["MUM", "LOVE-R", "SOLO", "GRASS", "YYDS"];
    const domesticSouls = slugs.map((slug, id) => ({ ...JAPANESE_SOULS[0]!, id, slug }));
    expect(localization?.getRecommendableSouls(domesticSouls, "domestic-zh").map((soul) => soul.slug)).toEqual(["YYDS"]);
    expect(domesticSouls.map((soul) => soul.slug)).toEqual(slugs);

    for (const locale of ["global-zh", "en", "id", "es", "ja", "ko"] as const) {
      const sourceSouls = localization?.getBuddySoulPool(locale) ?? [];
      const recommended = localization?.getRecommendableSouls(sourceSouls, locale) ?? [];
      for (const slug of ["LOVE-R", "SOLO", "NO-FILTER"]) {
        expect(sourceSouls.some((soul) => soul.slug === slug)).toBe(true);
        expect(recommended.some((soul) => soul.slug === slug)).toBe(true);
      }
    }
  });

  it("resolves global languages without locale-specific booleans", async () => {
    const localization = await loadLocalizationModule();
    expect(localization).not.toBeNull();
    expect(localization?.resolveBuddySoulLocale(false, "ja-JP")).toBe("domestic-zh");
    expect(localization?.resolveBuddySoulLocale(true, "zh-CN")).toBe("global-zh");
    expect(localization?.resolveBuddySoulLocale(true, "en-US")).toBe("en");
    expect(localization?.resolveBuddySoulLocale(true, "id-ID")).toBe("id");
    expect(localization?.resolveBuddySoulLocale(true, "es-ES")).toBe("es");
    expect(localization?.resolveBuddySoulLocale(true, "ja-JP")).toBe("ja");
    expect(localization?.resolveBuddySoulLocale(true, "ko-KR")).toBe("ko");
  });

  it("serves the complete Japanese Soul experience through one adapter", async () => {
    const localization = await loadLocalizationModule();
    expect(localization).not.toBeNull();
    expect(localization?.getBuddySoulPool("ja")).toEqual(JAPANESE_SOULS);
    expect(localization?.buildBuddyQuestions("ja")).toHaveLength(15);
    expect(localization?.getBuddySoulSpec("ja", JAPANESE_SOULS[0]!.slug)).not.toBeNull();
    expect(localization?.getBuddySoulDetail("ja", JAPANESE_SOULS[0]!.slug)?.content).toContain("基本的な個性");
    for (const tag of PREF_TAGS) {
      expect(localization?.getBuddyPrefTagLabel("ja", tag)).toBeTruthy();
    }
    expect(localization?.getBuddyCategoryLabel("ja", "high")).toBe("高");
  });

  it("serves the complete Korean Soul experience through one adapter", async () => {
    const localization = await loadLocalizationModule();
    expect(localization).not.toBeNull();
    expect(localization?.getBuddySoulPool("ko")).toEqual(KOREAN_SOULS);
    expect(localization?.buildBuddyQuestions("ko")).toHaveLength(15);
    expect(localization?.getBuddySoulSpec("ko", KOREAN_SOULS[0]!.slug)).not.toBeNull();
    expect(localization?.getBuddySoulDetail("ko", KOREAN_SOULS[0]!.slug)?.content).toContain("기본 성격");
    for (const tag of PREF_TAGS) expect(localization?.getBuddyPrefTagLabel("ko", tag)).toBeTruthy();
    expect(localization?.getBuddyCategoryLabel("ko", "high")).toBe("높음");
  });
});
