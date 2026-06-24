import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExpertsExecDebugCommand } from "../hermes-agent-experts-panel";
import {
  getInitialAgentSkillsTab,
  HermesAgentSkillsPanel,
} from "../hermes-agent-skills-panel";

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => text,
}));

vi.mock("../hermes-agent-experts-panel", () => ({
  ExpertsPanel: () => <div>技能包列表</div>,
}));

function TestSkillPanel() {
  return (
    <div data-testid="sdk-skill-panel">
      单技能安装面板
      <input className="lh-std-skill-panel__installed-search-input" placeholder="搜索技能名称" />
    </div>
  );
}

const renderPanel = (initialSectionSlug?: string) => {
  const execDebugCommand: ExpertsExecDebugCommand = vi.fn();
  render(
    <HermesAgentSkillsPanel
      botId="bot-1"
      execDebugCommand={execDebugCommand}
      featureFlags={{} as never}
      initialSectionSlug={initialSectionSlug}
      instance={{ InstanceId: "bot-1", RegionId: 1 }}
      productConfig={{} as never}
      SkillPanel={TestSkillPanel}
    />,
  );
};

describe("HermesAgentSkillsPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("defaults to the skill tab and can switch to skill packages", async () => {
    renderPanel("skills");

    const skillsTab = screen.getByRole("tab", { name: "技能" });
    const packagesTab = screen.getByRole("tab", { name: "技能包" });

    expect(skillsTab).toHaveAttribute("aria-selected", "true");
    expect(skillsTab).toHaveStyle({ fontSize: "18px", fontWeight: "600", lineHeight: "24px" });
    expect(packagesTab).toHaveStyle({ color: "rgba(0, 0, 0, 0.38)", fontSize: "18px" });
    expect(screen.getByText("单技能安装面板")).toBeInTheDocument();
    expect(screen.getByTestId("sdk-skill-panel").closest(".lv-agent-skills-sdk-panel")).not.toBeNull();
    expect(screen.getByPlaceholderText("搜索已安装技能名称")).toBeInTheDocument();

    await userEvent.click(packagesTab);

    expect(screen.getByRole("tab", { name: "技能包" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "技能包" })).toHaveStyle({ color: "rgba(0, 0, 0, 0.95)" });
    expect(screen.getByText("技能包列表")).toBeInTheDocument();
  });

  it("defaults to the skill tab for the legacy experts route", () => {
    expect(getInitialAgentSkillsTab("experts")).toBe("skills");

    renderPanel("experts");

    expect(screen.getByRole("tab", { name: "技能" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("单技能安装面板")).toBeInTheDocument();
  });
});
