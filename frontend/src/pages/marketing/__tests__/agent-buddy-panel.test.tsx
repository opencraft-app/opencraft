import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BuddyPanel } from "@/pages/marketing/agent-buddy-panel";
import {
  VibebaseError,
  loadBuddyState,
  saveBuddyState,
} from "@/lib/buddy-storage";
import {
  fetchSoulDetail,
  fetchSouls,
  type SkillHubSoul,
} from "@/lib/skillhub-api";

const fixtures = vi.hoisted(() => {
  const soul = (id: number, slug: string, displayName: string) => ({
    id,
    slug,
    displayName,
    summary: `${displayName} summary`,
    remark: "",
    version: "1.0.0",
    createdAt: 1,
    updatedAt: 1,
  });
  return {
    agentA: soul(1, "custom-persona-a", "Agent A Soul"),
    agentB: soul(2, "custom-persona-b", "Agent B Soul"),
    extra: soul(3, "custom-persona-extra", "Extra Soul"),
  };
});

const repositoryMocks = vi.hoisted(() => ({
  execDebugCommand: vi.fn(),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    bots: {
      execDebugCommand: repositoryMocks.execDebugCommand,
    },
  }),
}));

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string, options?: Record<string, unknown>) => text.replace(
    /\{\{\s*([\w$]+)\s*\}\}/g,
    (raw, key: string) => options?.[key] === undefined ? raw : String(options[key]),
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "zh-CN" } }),
}));

vi.mock("@/lib/buddy-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/buddy-storage")>();
  return {
    ...actual,
    loadBuddyState: vi.fn(),
    saveBuddyState: vi.fn(),
  };
});

vi.mock("@/lib/skillhub-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/skillhub-api")>();
  return {
    ...actual,
    fetchSouls: vi.fn(),
    fetchSoulDetail: vi.fn(),
  };
});

vi.mock("@/observability/datong-tracker", () => ({
  trackDatongClick: vi.fn(),
  trackDatongEvent: vi.fn(),
}));

vi.mock("@/pages/marketing/agent-buddy-soul-test-modal", () => ({
  SoulTestModal: ({
    open,
    onUseSoul,
  }: {
    open: boolean;
    onUseSoul: (soul: SkillHubSoul) => boolean;
  }) => open ? (
    <button type="button" onClick={() => onUseSoul(fixtures.extra)}>
      使用测试推荐
    </button>
  ) : null,
}));

const mockedLoadBuddyState = vi.mocked(loadBuddyState);
const mockedSaveBuddyState = vi.mocked(saveBuddyState);
const mockedFetchSouls = vi.mocked(fetchSouls);
const mockedFetchSoulDetail = vi.mocked(fetchSoulDetail);

const successResult = (output = "") => ({
  status: "Succeeded",
  exitCode: 0,
  output,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe("BuddyPanel P1 stability", () => {
  let now = 0;

  beforeEach(() => {
    now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    repositoryMocks.execDebugCommand.mockReset();
    mockedLoadBuddyState.mockReset();
    mockedSaveBuddyState.mockReset();
    mockedFetchSouls.mockReset();
    mockedFetchSoulDetail.mockReset();

    mockedFetchSouls.mockResolvedValue({
      total: 3,
      souls: [fixtures.agentA, fixtures.agentB, fixtures.extra],
    });
    mockedFetchSoulDetail.mockImplementation(async (slug) => {
      const soul = [fixtures.agentA, fixtures.agentB, fixtures.extra]
        .find((item) => item.slug === slug) ?? fixtures.agentA;
      return { ...soul, content: `${soul.displayName} content` };
    });
    mockedSaveBuddyState.mockResolvedValue();
    repositoryMocks.execDebugCommand.mockResolvedValue(successResult());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("ignores an old Agent injection result after the user switches Agents", async () => {
    const agentAWrite = deferred<ReturnType<typeof successResult>>();
    mockedLoadBuddyState.mockImplementation(async (botId) => ({
      drawnSouls: [botId === "agent-a" ? fixtures.agentA : fixtures.agentB],
      appliedSlug: null,
    }));
    repositoryMocks.execDebugCommand.mockImplementation(
      async (_botId: string, command: string) => (
        command.includes("base64 -d") ? agentAWrite.promise : successResult()
      ),
    );

    const { rerender } = render(<BuddyPanel botId="agent-a" />);
    fireEvent.click(await screen.findByRole("button", { name: "选中此人设" }));
    fireEvent.click(screen.getByRole("button", { name: "注入人设" }));
    await waitFor(() => expect(repositoryMocks.execDebugCommand).toHaveBeenCalledWith(
      "agent-a",
      expect.stringContaining("base64 -d"),
      { timeoutMs: 120_000 },
    ));

    rerender(<BuddyPanel botId="agent-b" />);
    expect(await screen.findByText("Agent B Soul")).toBeInTheDocument();

    now = 3_000;
    await act(async () => agentAWrite.resolve(successResult()));

    expect(screen.queryByText("人设已注入")).not.toBeInTheDocument();
    expect(screen.getByText("Agent B Soul")).toBeInTheDocument();
  });

  it("ignores an old Agent save failure after the user switches Agents", async () => {
    const agentASave = deferred<void>();
    mockedLoadBuddyState.mockImplementation(async (botId) => ({
      drawnSouls: [botId === "agent-a" ? fixtures.agentA : fixtures.agentB],
      appliedSlug: null,
    }));
    mockedSaveBuddyState.mockImplementation((botId) => (
      botId === "agent-a" ? agentASave.promise : Promise.resolve()
    ));

    const { rerender } = render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("Agent A Soul");
    fireEvent.click(screen.getByRole("button", { name: "答题测试人设" }));
    fireEvent.click(screen.getByRole("button", { name: "使用测试推荐" }));
    await waitFor(() => expect(mockedSaveBuddyState).toHaveBeenCalledWith(
      "agent-a",
      expect.objectContaining({
        drawnSouls: expect.arrayContaining([fixtures.extra]),
      }),
    ), { timeout: 1_500 });

    rerender(<BuddyPanel botId="agent-b" />);
    expect(await screen.findByText("Agent B Soul")).toBeInTheDocument();

    await act(async () => agentASave.reject(
      new VibebaseError("expired", 401, "unauthorized"),
    ));

    expect(screen.queryByText("登录后即可保存你的搭子人设")).not.toBeInTheDocument();
    expect(screen.getByText("Agent B Soul")).toBeInTheDocument();
  });

  it("keeps the applied card and reports an error when clearing SOUL.md fails", async () => {
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA],
      appliedSlug: fixtures.agentA.slug,
    });
    repositoryMocks.execDebugCommand.mockImplementation(
      async (_botId: string, command: string) => {
        if (command.includes("rm -f")) throw new Error("sandbox unavailable");
        return successResult(`Slug: ${fixtures.agentA.slug}`);
      },
    );

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("Agent A Soul");
    fireEvent.click(screen.getByRole("button", { name: "删除这张人设" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));

    expect(await screen.findByText("删除人设失败，请检查网络后重试")).toBeInTheDocument();
    expect(screen.getByText("Agent A Soul")).toBeInTheDocument();
  });

  it("retries a failed persona detail request without closing the preview", async () => {
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA],
      appliedSlug: null,
    });
    mockedFetchSoulDetail
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({
        ...fixtures.agentA,
        content: "Recovered persona content",
      });

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("Agent A Soul");
    fireEvent.click(screen.getByText("人设解读"));
    expect(await screen.findByText("加载失败：network unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("Recovered persona content")).toBeInTheDocument();
    expect(mockedFetchSoulDetail).toHaveBeenCalledTimes(2);
  });
});
