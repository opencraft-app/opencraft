import { describe, expect, it } from "vitest";

import { shouldMoveModelEntryToAccountMenu } from "@/lib/agent-plan-navigation";

describe("agent plan navigation", () => {
  it("moves the model entry into the sidebar account menu for ai bundles", () => {
    expect(shouldMoveModelEntryToAccountMenu({
      bundle_id: "bundle_future_ai_01",
      bundle_type: "ai",
    })).toBe(true);
  });

  it.each([null, undefined, "", "free", "general", "AI", "unknown"])(
    "keeps the model entry in the Agent navigation for %s",
    (bundleType) => {
      expect(shouldMoveModelEntryToAccountMenu(bundleType == null ? bundleType : {
        bundle_id: "bundle_any_01",
        bundle_type: bundleType,
      })).toBe(false);
    },
  );

  it("keeps the model entry in the Agent navigation when bundle_type is absent", () => {
    expect(shouldMoveModelEntryToAccountMenu({ bundle_id: "bundle_legacy_ai_01" })).toBe(false);
  });
});
