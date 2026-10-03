import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AgentChatPanel } from "@/pages/marketing/agent-chat-panel";
import { AgentChatMigrationSurface } from "@/pages/marketing/opencraft-embedded-workbench";

const region = vi.hoisted(() => ({ isCN: true }));

vi.mock("@/lib/region", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/region")>(),
  get isCN() { return region.isCN; },
}));
vi.mock("@/i18n/t", () => ({ useT: () => (text: string) => text }));
vi.mock("@/pages/marketing/workbench-prompt-auto-sender", () => ({ WorkbenchPromptAutoSender: () => null }));
vi.mock("@tencent/agentchat-lightvela-panel", () => ({ LightVelaPanel: () => null }));

afterEach(() => {
  cleanup();
  region.isCN = true;
});

it("shows the assistant only while the CN chat panel waits for a launch token", () => {
  const props = {
    accountId: "account-1",
    commandExecutor: vi.fn(),
    instanceId: "ins-1",
    launchToken: null,
    launchTokenExpiresAt: null,
    launchTokenError: null,
    launchTokenStatus: "loading" as const,
    onRetryLaunchToken: vi.fn(),
    onRefreshLaunchToken: vi.fn(async () => ({ token: "token" })),
  };

  const { rerender } = render(<AgentChatPanel {...props} />);
  expect(screen.getByRole("status")).toHaveTextContent("你的 AI 伙伴，马上就来");
  expect(document.querySelectorAll(".lv-chat-loading-dot")).toHaveLength(3);

  region.isCN = false;
  rerender(<AgentChatPanel {...props} />);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByText("正在获取对话启动 token…")).toBeInTheDocument();
  expect(screen.queryByText("你的 AI 伙伴，马上就来")).toBeNull();
});

it("uses regional prompts while the chat SDK chunk loads", () => {
  const props = {
    accountId: "account-1",
    commandExecutor: vi.fn(),
    instanceId: "ins-1",
    launchToken: "token",
    launchTokenExpiresAt: null,
    launchTokenError: null,
    launchTokenStatus: "ready" as const,
    onRetryLaunchToken: vi.fn(),
    onRefreshLaunchToken: vi.fn(async () => ({ token: "token" })),
  };
  const { rerender } = render(<AgentChatPanel {...props} />);
  expect(screen.getByRole("status")).toHaveTextContent("你的 AI 伙伴，马上就来");

  region.isCN = false;
  rerender(<AgentChatPanel {...props} />);
  expect(screen.getByText("正在加载对话…")).toBeInTheDocument();
  expect(screen.queryByText("你的 AI 伙伴，马上就来")).toBeNull();
});

it("keeps the original global embedded workbench loading prompt", () => {
  region.isCN = false;
  render(<AgentChatMigrationSurface active enabled instanceId="ins-1" profileId="main" region="intl"
    legacy={<div>Legacy chat</div>}
    multiSession={{ onSessionStateChange: vi.fn(), onSelectedChatIdChange: vi.fn() }} />);

  expect(screen.getByRole("status")).toHaveTextContent("正在加载会话…");
  expect(screen.queryByText("你的 AI 伙伴，马上就来")).toBeNull();
});
