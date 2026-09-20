import { describe, expect, it } from "vitest";

import { shouldMoveModelEntryToAccountMenu } from "@/lib/agent-plan-navigation";

describe("agent plan navigation", () => {
  it.each(["bundle_launch_ai_01", "bundle_cruise_ai_01"])(
    "moves the model entry into the sidebar account menu for %s",
    (bundleId) => {
      expect(shouldMoveModelEntryToAccountMenu(bundleId)).toBe(true);
    },
  );

  it.each([null, undefined, "", "bundle_launch_01", "bundle_cruise_01"])(
    "keeps the model entry in the Agent navigation for %s",
    (bundleId) => {
      expect(shouldMoveModelEntryToAccountMenu(bundleId)).toBe(false);
    },
  );
});
