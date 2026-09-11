import { describe, expect, it } from "vitest";

import { resolveBotQuotaForPassState, resolveBotQuotaPerAgent } from "../agent-context";

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

describe("resolveBotQuotaForPassState", () => {
  it("does not block creation before the first Pass response resolves", () => {
    expect(resolveBotQuotaForPassState(null, false)).toBe(0);
  });

  it("uses the free fallback only after Passes resolve without an active Pass", () => {
    expect(resolveBotQuotaForPassState(null, true)).toBe(1);
  });

  it("uses a resolved paid Pass even while the resolution flag is false", () => {
    expect(resolveBotQuotaForPassState({ bundle_id: "bundle_cruise_01" }, false)).toBe(10);
  });
});
