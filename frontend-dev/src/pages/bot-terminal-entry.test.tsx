import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/pages/settings-page";
import { WorkspacePage } from "@/pages/workspace-page";

const mockUseParams = vi.fn();
const mockUseAsyncResource = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useParams: () => mockUseParams(),
  };
});

vi.mock("@/services/use-async-resource", () => ({
  useAsyncResource: (...args: unknown[]) => mockUseAsyncResource(...args),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    bots: {
      getWorkspaceSnapshot: vi.fn(),
      getSettingsSnapshot: vi.fn(),
      sendWorkspaceMessage: vi.fn(),
      updateBotProfile: vi.fn(),
    },
  }),
}));

describe("bot terminal entry points", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockUseParams.mockReturnValue({ id: "bot_123" });
  });

  it("renders a terminal entry link on the workspace page", () => {
    mockUseAsyncResource.mockReturnValue({
      loading: false,
      error: null,
      reload: vi.fn(),
      data: {
        bot: {
          id: "bot_123",
          name: "Ops Bot",
          template: "OpenClaw Runtime",
          type: "ops",
          status: "active",
          createdAt: "2026-03-25T00:00:00Z",
        },
        runtime: null,
        messages: [],
        quickActions: [],
      },
    });

    render(
      <MemoryRouter>
        <WorkspacePage />
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: "打开终端" });
    expect(link).toHaveAttribute("href", "/bots/bot_123/terminal");
  });

  it("renders a terminal entry link on the settings page", () => {
    mockUseAsyncResource.mockReturnValue({
      loading: false,
      error: null,
      reload: vi.fn(),
      data: {
        bot: {
          id: "bot_123",
          name: "Ops Bot",
          template: "OpenClaw Runtime",
          type: "ops",
          status: "active",
          mission: "Keep prod healthy",
          scenario: "Operations",
          createdAt: "2026-03-25T00:00:00Z",
        },
        versions: [],
        tools: [],
        knowledge: [],
        auditEvents: [],
        billing: {
          tier: "free",
          monthCost: 0,
          budgetLimit: 0,
          estimatedMonthEnd: 0,
          tokenSpend: 0,
          runMinutes: 0,
        },
      },
    });

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: "打开终端" });
    expect(link).toHaveAttribute("href", "/bots/bot_123/terminal");
  });
});
