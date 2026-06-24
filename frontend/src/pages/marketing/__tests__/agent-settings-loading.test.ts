import { describe, expect, it } from "vitest";
import { shouldShowAgentSettingsDataLoading } from "@/pages/marketing/agent-settings-loading";

describe("agent settings loading gate", () => {
  it("keeps the rendered settings panel mounted during background bot refresh", () => {
    expect(
      shouldShowAgentSettingsDataLoading({
        botsLoading: true,
        isCreating: false,
        visibleBotCount: 1,
      }),
    ).toBe(false);
  });

  it("shows the data skeleton only for the initial empty bot load", () => {
    expect(
      shouldShowAgentSettingsDataLoading({
        botsLoading: true,
        isCreating: false,
        visibleBotCount: 0,
      }),
    ).toBe(true);
  });

  it("does not replace the dedicated creating flow with the data skeleton", () => {
    expect(
      shouldShowAgentSettingsDataLoading({
        botsLoading: true,
        isCreating: true,
        visibleBotCount: 0,
      }),
    ).toBe(false);
  });
});
