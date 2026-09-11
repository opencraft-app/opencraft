import { describe, expect, it } from "vitest";

import { resolveBotQuotaPerAgent } from "../agent-context";

describe("resolveBotQuotaPerAgent", () => {
  it.each([
    ["bundle_launch_01", 5],
    ["bundle_launch_ai_01", 5],
    ["bundle_cruise_01", 10],
    ["bundle_cruise_ai_01", 10],
  ])("maps the %s Pass to its frontend Bot limit", (bundleId, quota) => {
    expect(resolveBotQuotaPerAgent({ bundle_id: bundleId })).toBe(quota);
  });

  it.each([null, { bundle_id: "" }, { bundle_id: "bundle_free_7d" }, { bundle_id: "bundle_unknown" }])(
    "falls back to one Bot for a missing, free, or unknown Pass",
    (pass) => {
      expect(resolveBotQuotaPerAgent(pass)).toBe(1);
    },
  );
});
