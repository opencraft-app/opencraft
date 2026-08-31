import { describe, expect, it } from "vitest";

import { JAPANESE_SOULS } from "@/lib/soul-japanese-data";
import { PREF_TAGS } from "@/pages/marketing/agent-buddy-soul-test-data";

type LocalizationModule = typeof import("@/pages/marketing/agent-buddy-localization");

async function loadLocalizationModule(): Promise<LocalizationModule | null> {
  const modulePath = "@/pages/marketing/agent-buddy-localization";
  return import(modulePath).catch(() => null);
}

describe("Buddy Soul locale resolver", () => {
  it("resolves global languages without locale-specific booleans", async () => {
    const localization = await loadLocalizationModule();
    expect(localization).not.toBeNull();
    expect(localization?.resolveBuddySoulLocale(false, "ja-JP")).toBe("domestic-zh");
    expect(localization?.resolveBuddySoulLocale(true, "zh-CN")).toBe("global-zh");
    expect(localization?.resolveBuddySoulLocale(true, "en-US")).toBe("en");
    expect(localization?.resolveBuddySoulLocale(true, "id-ID")).toBe("id");
    expect(localization?.resolveBuddySoulLocale(true, "es-ES")).toBe("es");
    expect(localization?.resolveBuddySoulLocale(true, "ja-JP")).toBe("ja");
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
});
