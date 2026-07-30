import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AchievementsPanel } from "@/pages/marketing/agent-achievements-panel";

const repositoryMocks = vi.hoisted(() => ({
  execDebugCommand: vi.fn(),
}));

vi.mock("@/contexts/repository-context", () => {
  const repositories = {
    bots: {
      execDebugCommand: repositoryMocks.execDebugCommand,
    },
  };
  return { useRepositories: () => repositories };
});

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string, options?: Record<string, unknown>) => text.replace(
    /\{\{\s*([\w$]+)\s*\}\}/g,
    (raw, key: string) => options?.[key] === undefined ? raw : String(options[key]),
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "zh-CN" } }),
}));

const START = "__LIGHTVELA_ACHIEVEMENTS_JSON_START__";
const END = "__LIGHTVELA_ACHIEVEMENTS_JSON_END__";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const achievementResult = (botLabel: string) => ({
  status: "Succeeded",
  exitCode: 0,
  output: [
    START,
    JSON.stringify({
      achievements: [{
        id: `${botLabel.toLowerCase()}_achievement`,
        name: `${botLabel} Achievement`,
        description: `${botLabel} achievement description`,
        category: "Other",
        state: "discovered",
        unlocked: false,
      }],
      discovered_count: 1,
      total_count: 1,
    }),
    END,
  ].join("\n"),
});

describe("AchievementsPanel request ownership", () => {
  afterEach(() => {
    cleanup();
    repositoryMocks.execDebugCommand.mockReset();
  });

  it("ignores an older Agent response that resolves after the current Agent", async () => {
    const agentA = deferred<ReturnType<typeof achievementResult>>();
    const agentB = deferred<ReturnType<typeof achievementResult>>();
    repositoryMocks.execDebugCommand.mockImplementation((botId: string) => (
      botId === "agent-a" ? agentA.promise : agentB.promise
    ));

    const { rerender } = render(<AchievementsPanel botId="agent-a" botName="Agent A" />);
    await waitFor(() => expect(repositoryMocks.execDebugCommand).toHaveBeenCalledTimes(1));

    rerender(<AchievementsPanel botId="agent-b" botName="Agent B" />);
    await waitFor(() => expect(repositoryMocks.execDebugCommand).toHaveBeenCalledTimes(2));

    await act(async () => agentB.resolve(achievementResult("Agent B")));
    expect(await screen.findByText("Agent B Achievement")).toBeInTheDocument();

    await act(async () => agentA.resolve(achievementResult("Agent A")));
    expect(screen.getByText("Agent B Achievement")).toBeInTheDocument();
    expect(screen.queryByText("Agent A Achievement")).not.toBeInTheDocument();
  });
});
