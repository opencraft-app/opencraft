import { describe, expect, it } from "vitest";

import { resolveBotQuotaPerAgent } from "../agent-context";

describe("resolveBotQuotaPerAgent", () => {
  it.each([
    ["Launch", 5],
    ["Launch AI", 5],
    ["Cruise", 10],
    ["Cruise AI", 10],
  ])("uses the %s Pass entitlement", (_plan, quota) => {
    expect(resolveBotQuotaPerAgent({ bot_quota_per_agent: quota })).toBe(quota);
  });

  it.each([null, {}, { bot_quota_per_agent: 0 }, { bot_quota_per_agent: -1 }, { bot_quota_per_agent: 1.5 }])(
    "falls back to one Bot for a missing or invalid entitlement",
    (pass) => {
      expect(resolveBotQuotaPerAgent(pass)).toBe(1);
    },
  );
});
