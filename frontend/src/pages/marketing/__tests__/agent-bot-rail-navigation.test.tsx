import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenClawBot } from "@/contexts/agent-context";
import { AgentBotRail } from "@/pages/marketing/agent-bot-rail";

vi.mock("@/i18n/t", () => ({ t: (value: string) => value, useT: () => (value: string) => value }));
vi.mock("@/pages/marketing/agent-buddy-profile", () => ({
  useBuddyProfile: ({ fallbackName }: { fallbackName: string }) => ({
    hasBuddyConfig: false,
    profile: { name: fallbackName, color: "#7c3aed", shapeId: "circle" },
  }),
}));
vi.mock("@/pages/marketing/agent-model-config/model-action-tooltip", () => ({
  ModelActionTooltip: ({ children }: { children: ReactNode }) => children,
}));

const bot = (id: string): OpenClawBot => ({
  id,
  name: id,
  instanceId: id,
  profileId: id,
  isDefault: id === "first",
  status: "running",
  personality: "",
  personalityEmoji: "",
  intro: "",
  createdAt: "",
  connectedChannels: [],
  installedSkills: [],
});

afterEach(cleanup);

describe("Agent Bot rail navigation", () => {
  it("uses client navigation for a normal click while retaining a real href", () => {
    const onSelect = vi.fn();
    render(<AgentBotRail bots={[bot("first"), bot("second")]} activeBotId="first"
      canCreate createLimitMessage="" restartingBotIds={new Set()} execDebugCommand={vi.fn()}
      onSelect={onSelect} onCreate={vi.fn()} />);

    const link = screen.getByRole("link", { name: /second/ });
    expect(link).toHaveAttribute("href", "/agents/chat/?bot=second");

    const normalClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, normalClick);
    expect(normalClick.defaultPrevented).toBe(true);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("second");

    onSelect.mockClear();
    const newTabClick = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    const preventJsdomNavigation = (event: MouseEvent) => {
      expect(event.defaultPrevented).toBe(false);
      event.preventDefault();
    };
    document.addEventListener("click", preventJsdomNavigation, { once: true });
    fireEvent(link, newTabClick);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
