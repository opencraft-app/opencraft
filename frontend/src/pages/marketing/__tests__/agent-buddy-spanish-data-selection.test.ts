import { describe, expect, it } from "vitest";

import { ENGLISH_SOULS } from "@/lib/soul-english-data";
import { SPANISH_SOULS } from "@/lib/soul-spanish-data";

describe("BuddyPanel Spanish dataset selection", () => {
  it("resolves persisted westernized slugs from the Spanish pool", async () => {
    const modulePath = "@/pages/marketing/agent-buddy-panel";
    const panel = await import(modulePath) as unknown as {
      localizeDrawnSouls?: (
        drawn: typeof ENGLISH_SOULS,
        available: typeof ENGLISH_SOULS,
        locale: "es",
      ) => typeof ENGLISH_SOULS;
    };

    expect(panel.localizeDrawnSouls).toEqual(expect.any(Function));
    const localized = panel.localizeDrawnSouls?.(
      [ENGLISH_SOULS[0]!],
      [],
      "es",
    );
    expect(localized?.[0]?.displayName).toBe(SPANISH_SOULS[0]?.displayName);
  });
});
