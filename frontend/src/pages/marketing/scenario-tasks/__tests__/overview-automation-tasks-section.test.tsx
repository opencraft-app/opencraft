import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverviewAutomationTasksSection } from "../OverviewAutomationTasksSection";
import { getOverviewScenarioTaskPacks } from "../overview-packs";

afterEach(() => {
  cleanup();
});

describe("OverviewAutomationTasksSection", () => {
  it("keeps execution times inside the task editor instead of showing them on cards", () => {
    const packs = getOverviewScenarioTaskPacks("zh-CN");

    render(
      <OverviewAutomationTasksSection
        packs={packs}
        installedScenarioIds={new Set()}
        myTasksHref="/agents/automations"
        onEnable={vi.fn()}
      />,
    );

    for (const pack of packs) {
      expect(screen.getByRole("heading", { name: pack.name })).toBeInTheDocument();
      expect(screen.queryByText(pack.defaultFrequencyLabel)).not.toBeInTheDocument();
    }
  });
});
