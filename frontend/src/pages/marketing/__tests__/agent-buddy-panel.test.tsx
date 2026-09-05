import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { isGlobal } from "@/lib/region";
import { encodeUtf8Base64 } from "@/pages/marketing/agent-persona-upload";

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

vi.mock("@/pages/marketing/agent-buddy-draw-modal", () => ({
  DrawSoulModal: ({
    open,
    onInject,
  }: {
    open: boolean;
    onInject: (soul: SkillHubSoul) => Promise<boolean>;
  }) => open ? (
    <button type="button" onClick={() => void onInject(fixtures.extra)}>
      注入抽卡结果
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

const soulContentResult = (markdown: string) => successResult([
  "Exists: yes",
  `ByteLength: ${new TextEncoder().encode(markdown).byteLength}`,
  `ContentBase64: ${encodeUtf8Base64(markdown)}`,
].join("\n"));

const readBlobText = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
  reader.addEventListener("error", () => reject(reader.error));
  reader.readAsText(blob);
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

  it("renders the page title and description above the persona card", () => {
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [],
      appliedSlug: null,
    });

    const { container } = render(<BuddyPanel botId="agent-a" />);

    const title = screen.getByRole("heading", { level: 2, name: "人设" });
    const description = screen.getByText("设置人设文件（SOUL.md），让你的 Agent 拥有独特的性格与表达方式");
    const card = container.querySelector(".lv-buddy-panel");

    expect(title).toHaveClass(
      "mb-1",
      "text-lg",
      "font-semibold",
      "leading-6",
      "text-balance",
      "text-black/95",
    );
    expect(description).toHaveClass(
      "text-sm",
      "font-medium",
      "leading-6",
      "text-pretty",
      "text-black/50",
    );
    expect(title.parentElement).toHaveClass("mb-3");
    expect(card).not.toBeNull();
    expect(title.compareDocumentPosition(card as Element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(description.compareDocumentPosition(card as Element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector(".lv-buddy-panel__title")).not.toBeInTheDocument();
  });

  it("places the SkillHub source at the card heading height", () => {
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [],
      appliedSlug: null,
    });

    render(<BuddyPanel botId="agent-a" />);

    const description = screen.getByText("设置人设文件（SOUL.md），让你的 Agent 拥有独特的性格与表达方式");
    const source = screen.getByRole("link", { name: "灵感来自 SkillHub" });
    const cardHeading = screen.getByRole("heading", { level: 3, name: "人设卡片" });

    expect(source.parentElement).toBe(cardHeading.parentElement?.parentElement);
    expect(source.parentElement).toHaveClass("relative", "items-center", "justify-center");
    expect(source).toHaveClass("absolute", "inset-y-0", "right-6", "items-center");
    expect(description.parentElement).not.toBe(source.parentElement);
  });

  it("renders the persona card heading with the historical slogan typography", () => {
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [],
      appliedSlug: null,
    });

    const { container } = render(<BuddyPanel botId="agent-a" />);
    const card = container.querySelector(".lv-buddy-panel");

    expect(card).not.toBeNull();
    const cardHeading = within(card as HTMLElement).getByRole("heading", { level: 3, name: "人设卡片" });

    expect(cardHeading).toHaveClass(
      "text-lg",
      "font-semibold",
      "text-balance",
    );
    expect(cardHeading).not.toHaveClass("text-lg", "text-xl");
    expect(cardHeading.style.letterSpacing).toBe("-0.2px");
    expect(cardHeading.style.backgroundImage).toContain("linear-gradient");
    expect(cardHeading.style.backgroundClip).toBe("text");
    expect(cardHeading.style.color).toBe("transparent");
    expect(screen.queryByText("已抽")).not.toBeInTheDocument();
  });

  it("places the drawn-card count immediately after the persona card heading", async () => {
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA],
      appliedSlug: null,
    });

    const { container } = render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("Agent A Soul");

    const cardHeading = screen.getByRole("heading", { level: 3, name: "人设卡片" });
    const progressChip = screen.getByText("已抽").parentElement;

    expect(progressChip).not.toBeNull();
    expect(progressChip).toHaveTextContent("已抽1/8");
    expect(cardHeading.parentElement).toHaveClass("lv-buddy-panel__heading");
    expect(cardHeading.nextElementSibling).toBe(progressChip);
    expect(container.querySelector(".lv-buddy-panel__actions")).not.toContainElement(progressChip);
    expect(container.querySelector(".lv-buddy-panel__progress")).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "注入" }));
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

  it("renders the upload entry in both regions", async () => {
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA],
      appliedSlug: null,
    });
    repositoryMocks.execDebugCommand.mockResolvedValue(successResult("Exists: no"));

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("Agent A Soul");

    expect(await screen.findByRole("button", { name: "上传人设文件" })).toBeEnabled();
  });

  it("shows inject only after selecting a persona", async () => {
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA],
      appliedSlug: null,
    });
    repositoryMocks.execDebugCommand.mockResolvedValue(successResult("Exists: no"));

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("Agent A Soul");

    expect(screen.queryByRole("button", { name: "注入" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")
      .map((button) => button.textContent?.trim())
      .filter((label) => [
        "抽取人设",
        "测试人设",
        "上传人设文件",
      ].includes(label ?? ""))).toEqual([
      "抽取人设",
      "测试人设",
      "上传人设文件",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "选中此人设" }));

    expect(screen.getAllByRole("button")
      .map((button) => button.textContent?.trim())
      .filter((label) => [
        "抽取人设",
        "测试人设",
        "上传人设文件",
        "注入",
      ].includes(label ?? ""))).toEqual([
      "抽取人设",
      "测试人设",
      "上传人设文件",
      "注入",
    ]);
  });

  it("adds and selects a drawn persona only after direct injection succeeds", async () => {
    let installed = false;
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA],
      appliedSlug: null,
    });
    repositoryMocks.execDebugCommand.mockImplementation(async (_botId, command) => {
      if (command.includes("in_metadata && /^Name:/")) {
        return successResult(installed
          ? "Exists: yes\nSlug: custom-persona-extra\nName: Extra Soul"
          : "Exists: no");
      }
      if (command.includes("base64 -d")) installed = true;
      return successResult();
    });

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("Agent A Soul");
    fireEvent.click(screen.getByRole("button", { name: "抽取人设" }));
    fireEvent.click(screen.getByRole("button", { name: "注入抽卡结果" }));

    expect(await screen.findByText("Extra Soul", {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(screen.getByLabelText("当前已注入到 Agent")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已注入：Extra Soul");
    expect(screen.queryByRole("button", { name: "注入抽卡结果" })).not.toBeInTheDocument();
    await waitFor(() => expect(mockedSaveBuddyState).toHaveBeenCalledWith("agent-a", {
      drawnSouls: expect.arrayContaining([fixtures.agentA, fixtures.extra]),
      appliedSlug: fixtures.extra.slug,
    }));
  });

  it("restores the injected persona summary from the real SOUL.md slug", async () => {
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA],
      appliedSlug: null,
    });
    repositoryMocks.execDebugCommand.mockResolvedValue(successResult([
      "Exists: yes",
      `Slug: ${fixtures.agentA.slug}`,
      "Name: Agent A Soul",
    ].join("\n")));

    render(<BuddyPanel botId="agent-a" />);

    expect(await screen.findByRole("status")).toHaveTextContent("已注入：Agent A Soul");
  });

  it("turns an edited recommended persona into a downloadable custom persona", async () => {
    const currentMarkdown = [
      "# Soul",
      `Slug: ${fixtures.agentA.slug}`,
      "Name: Agent A Soul",
      "",
      "## Identity",
      "先给结论。",
    ].join("\n");
    let saved = false;
    let writtenCommand = "";
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA],
      appliedSlug: null,
    });
    repositoryMocks.execDebugCommand.mockImplementation(async (_botId, command) => {
      if (command.includes("ContentBase64:")) return soulContentResult(currentMarkdown);
      if (command.includes("base64 -d")) {
        writtenCommand = command;
        saved = true;
        return successResult();
      }
      if (command.includes("in_metadata && /^Name:/")) {
        return successResult(saved
          ? [
            "Exists: yes",
            `Slug: ${fixtures.agentA.slug}`,
            "LightVela-Source: custom-upload",
            "Name: 我的 Agent A Soul",
          ].join("\n")
          : [
            "Exists: yes",
            `Slug: ${fixtures.agentA.slug}`,
            "Name: Agent A Soul",
          ].join("\n"));
      }
      return successResult();
    });

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("已注入：Agent A Soul");
    expect(screen.queryByRole("button", { name: "下载自定义人设" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑人设文件" }));

    const dialog = await screen.findByRole("dialog", { name: "编辑人设文件" });
    expect(within(dialog).getByLabelText("人设内容")).toHaveValue(currentMarkdown);
    fireEvent.change(within(dialog).getByLabelText("人设内容"), {
      target: {
        value: currentMarkdown
          .replace("Name: Agent A Soul", "Name: 我的 Agent A Soul")
          .replace("先给结论。", "先确认目标，再给结论。"),
      },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存修改" }));

    expect(await screen.findByText("已注入：自定义人设 · 我的 Agent A Soul"))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑自定义人设" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载自定义人设" })).toBeInTheDocument();
    expect(atob(writtenCommand.match(/\n([A-Za-z0-9+/=]+)\n__CTL_SOUL_EOF__/)?.[1] ?? ""))
      .toContain("LightVela-Source: custom-upload");
  });

  it("uses the real SOUL.md Name for an edited recommended persona", async () => {
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA],
      appliedSlug: fixtures.agentA.slug,
    });
    repositoryMocks.execDebugCommand.mockResolvedValue(successResult([
      "Exists: yes",
      `Slug: ${fixtures.agentA.slug}`,
      "Name: Agent A Soul 达人版",
    ].join("\n")));

    render(<BuddyPanel botId="agent-a" />);

    expect(await screen.findByText("已注入：Agent A Soul 达人版")).toBeInTheDocument();
    expect(screen.getByText("Agent A Soul 达人版")).toBeInTheDocument();
    expect(screen.queryByText("Agent A Soul")).not.toBeInTheDocument();
  });

  it("keeps the draw result open and out of the grid when direct injection falls back", async () => {
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA],
      appliedSlug: null,
    });
    repositoryMocks.execDebugCommand.mockImplementation(async (_botId, command) => {
      if (command.includes("in_metadata && /^Name:/")) return successResult("Exists: no");
      if (command.includes("base64 -d")) throw new Error("sandbox unavailable");
      return successResult();
    });

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("Agent A Soul");
    fireEvent.click(screen.getByRole("button", { name: "抽取人设" }));
    fireEvent.click(screen.getByRole("button", { name: "注入抽卡结果" }));

    expect(await screen.findByText(
      "无法写入 Agent 沙箱，已下载 soul.md 到本地",
      {},
      { timeout: 3_000 },
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "注入抽卡结果" })).toBeInTheDocument();
    expect(screen.queryByText("Extra Soul")).not.toBeInTheDocument();
  });

  it("closes an old draw result and ignores its injection after switching Agents", async () => {
    const agentAWrite = deferred<ReturnType<typeof successResult>>();
    mockedLoadBuddyState.mockImplementation(async (botId) => ({
      drawnSouls: [botId === "agent-a" ? fixtures.agentA : fixtures.agentB],
      appliedSlug: null,
    }));
    repositoryMocks.execDebugCommand.mockImplementation(async (botId, command) => {
      if (botId === "agent-a" && command.includes("base64 -d")) return agentAWrite.promise;
      if (command.includes("in_metadata && /^Name:/")) return successResult("Exists: no");
      return successResult();
    });

    const { rerender } = render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("Agent A Soul");
    fireEvent.click(screen.getByRole("button", { name: "抽取人设" }));
    fireEvent.click(screen.getByRole("button", { name: "注入抽卡结果" }));
    await waitFor(() => expect(repositoryMocks.execDebugCommand).toHaveBeenCalledWith(
      "agent-a",
      expect.stringContaining("base64 -d"),
      { timeoutMs: 120_000 },
    ));

    rerender(<BuddyPanel botId="agent-b" />);
    expect(await screen.findByText("Agent B Soul")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "注入抽卡结果" })).not.toBeInTheDocument();

    await act(async () => agentAWrite.resolve(successResult()));

    expect(screen.queryByText("Extra Soul")).not.toBeInTheDocument();
    expect(screen.queryByText("人设已注入")).not.toBeInTheDocument();
  });

  it("re-enables direct injection when the download fallback throws", async () => {
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA],
      appliedSlug: null,
    });
    repositoryMocks.execDebugCommand.mockImplementation(async (_botId, command) => {
      if (command.includes("in_metadata && /^Name:/")) return successResult("Exists: no");
      if (command.includes("base64 -d")) throw new Error("sandbox unavailable");
      return successResult();
    });
    vi.spyOn(URL, "createObjectURL").mockImplementationOnce(() => {
      throw new Error("download unavailable");
    });

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("Agent A Soul");
    fireEvent.click(screen.getByRole("button", { name: "抽取人设" }));
    fireEvent.click(screen.getByRole("button", { name: "注入抽卡结果" }));

    expect(await screen.findByText(
      "注入失败，请检查网络后重试",
      {},
      { timeout: 3_000 },
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "注入抽卡结果" })).toBeInTheDocument();
  });

  it("replaces the rerolled slot only after direct injection succeeds", async () => {
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA, fixtures.agentB],
      appliedSlug: null,
    });
    repositoryMocks.execDebugCommand.mockImplementation(async (_botId, command) => (
      command.includes("in_metadata && /^Name:/")
        ? successResult("Exists: no")
        : successResult()
    ));

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("Agent A Soul");
    fireEvent.click(screen.getAllByRole("button", { name: "重新抽取这张人设" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "注入抽卡结果" }));

    expect(await screen.findByText("Extra Soul", {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(screen.queryByText("Agent A Soul")).not.toBeInTheDocument();
    expect(screen.getByText("Agent B Soul")).toBeInTheDocument();
  });

  it("keeps the original reroll slot when direct injection falls back", async () => {
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA, fixtures.agentB],
      appliedSlug: null,
    });
    repositoryMocks.execDebugCommand.mockImplementation(async (_botId, command) => {
      if (command.includes("in_metadata && /^Name:/")) return successResult("Exists: no");
      if (command.includes("base64 -d")) throw new Error("sandbox unavailable");
      return successResult();
    });

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("Agent A Soul");
    fireEvent.click(screen.getAllByRole("button", { name: "重新抽取这张人设" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "注入抽卡结果" }));

    expect(await screen.findByText(
      "无法写入 Agent 沙箱，已下载 soul.md 到本地",
      {},
      { timeout: 3_000 },
    )).toBeInTheDocument();
    expect(screen.getByText("Agent A Soul")).toBeInTheDocument();
    expect(screen.getByText("Agent B Soul")).toBeInTheDocument();
    expect(screen.queryByText("Extra Soul")).not.toBeInTheDocument();
  });

  it("restores a custom uploaded persona from the real SOUL.md source marker", async () => {
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA],
      appliedSlug: fixtures.agentA.slug,
    });
    repositoryMocks.execDebugCommand.mockResolvedValue(successResult([
      "Exists: yes",
      "Slug: focused-project-guide",
      "LightVela-Source: custom-upload",
      "Name: 冷静的项目搭档",
    ].join("\n")));

    render(<BuddyPanel botId="agent-a" />);

    expect(await screen.findByText("已注入：自定义人设 · 冷静的项目搭档"))
      .toBeInTheDocument();
    const editButton = screen.getByRole("button", { name: "编辑自定义人设" });
    expect(editButton).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载自定义人设" })).toBeInTheDocument();
    expect(editButton.parentElement?.parentElement).toHaveClass("gap-0");
    expect(screen.queryByRole("button", { name: "已注入：自定义人设 · 冷静的项目搭档" }))
      .not.toBeInTheDocument();
    expect(screen.queryByLabelText("当前已注入到 Agent")).not.toBeInTheDocument();
  });

  it("keeps recognizing legacy custom-upload Slug identities", async () => {
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA],
      appliedSlug: fixtures.agentA.slug,
    });
    repositoryMocks.execDebugCommand.mockResolvedValue(successResult([
      "Exists: yes",
      "Slug: custom-upload",
      "Name: 旧版自定义人设",
    ].join("\n")));

    render(<BuddyPanel botId="agent-a" />);

    expect(await screen.findByText("已注入：自定义人设 · 旧版自定义人设"))
      .toBeInTheDocument();
  });

  it("reads the current Soul, edits it, and saves through the safe write command", async () => {
    const currentMarkdown = "# Soul\nSlug: custom-upload\nName: 冷静的项目搭档\n\n## Identity\n先给结论。\n";
    let saved = false;
    mockedLoadBuddyState.mockResolvedValue({ drawnSouls: [fixtures.agentA], appliedSlug: null });
    repositoryMocks.execDebugCommand.mockImplementation(async (_botId, command) => {
      if (command.includes("ContentBase64:")) return soulContentResult(currentMarkdown);
      if (command.includes("base64 -d")) {
        saved = true;
        return successResult();
      }
      if (command.includes("in_metadata && /^Name:/")) {
        return successResult(saved
          ? "Exists: yes\nSlug: custom-upload\nName: 更新后的项目搭档"
          : "Exists: yes\nSlug: custom-upload\nName: 冷静的项目搭档");
      }
      return successResult();
    });

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("已注入：自定义人设 · 冷静的项目搭档");
    fireEvent.click(screen.getByRole("button", { name: "编辑自定义人设" }));

    const dialog = await screen.findByRole("dialog", { name: "编辑人设文件" });
    expect(within(dialog).getByLabelText("人设内容")).toHaveValue(currentMarkdown);
    fireEvent.change(within(dialog).getByLabelText("人设内容"), {
      target: {
        value: currentMarkdown
          .replace("Name: 冷静的项目搭档", "Name: 更新后的项目搭档")
          .replace("先给结论。", "先确认目标，再给结论。"),
      },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(repositoryMocks.execDebugCommand).toHaveBeenCalledWith(
      "agent-a",
      expect.stringContaining('base64 -d > "$TEMP"'),
      { timeoutMs: 120_000 },
    ));
    expect(await screen.findByText("已注入：自定义人设 · 更新后的项目搭档"))
      .toBeInTheDocument();
    expect(await screen.findByText("人设已更新")).toBeInTheDocument();
    expect(screen.getByText((_text, element) => (
      element?.tagName === "P"
      && element.textContent === "人设已更新，请发送 /new 开始新会话以生效"
    ))).toBeInTheDocument();
  });

  it("downloads the exact current Soul directly without opening the editor", async () => {
    const currentMarkdown = "# Soul\nSlug: custom-upload\nName: 下载测试\n\n原始内容保留。\n";
    let downloadedBlob: Blob | null = null;
    let downloadedName = "";
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      downloadedBlob = blob as Blob;
      return "blob:current-soul";
    });
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(
      this: HTMLAnchorElement,
    ) {
      downloadedName = this.download;
    });
    mockedLoadBuddyState.mockResolvedValue({ drawnSouls: [fixtures.agentA], appliedSlug: null });
    repositoryMocks.execDebugCommand.mockImplementation(async (_botId, command) => {
      if (command.includes("ContentBase64:")) return soulContentResult(currentMarkdown);
      return successResult("Exists: yes\nSlug: custom-upload\nName: 下载测试");
    });

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("已注入：自定义人设 · 下载测试");
    fireEvent.click(screen.getByRole("button", { name: "下载自定义人设" }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    expect(downloadedName).toBe("soul.md");
    expect(downloadedBlob).not.toBeNull();
    expect(await readBlobText(downloadedBlob!)).toBe(currentMarkdown);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:current-soul");
    expect(screen.queryByRole("dialog", { name: "编辑人设文件" })).not.toBeInTheDocument();
  });

  it.each([
    ["Exists: no", "当前 Agent 没有可用的人设文件"],
    ["Exists: yes\nTooLarge: yes\nByteLength: 20481", "当前人设文件超过 20 KB，暂不支持在线编辑或下载"],
    ["unexpected output", "无法读取人设文件，请重试"],
  ])("reports an actionable error for an unreadable current Soul: %s", async (output, message) => {
    mockedLoadBuddyState.mockResolvedValue({ drawnSouls: [fixtures.agentA], appliedSlug: null });
    repositoryMocks.execDebugCommand.mockImplementation(async (_botId, command) => (
      command.includes("ContentBase64:")
        ? successResult(output)
        : successResult("Exists: yes\nSlug: custom-upload\nName: 读取测试")
    ));

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("已注入：自定义人设 · 读取测试");
    fireEvent.click(screen.getByRole("button", { name: "编辑自定义人设" }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "编辑人设文件" })).not.toBeInTheDocument();
  });

  it("reports a network error while reading the current Soul", async () => {
    mockedLoadBuddyState.mockResolvedValue({ drawnSouls: [fixtures.agentA], appliedSlug: null });
    repositoryMocks.execDebugCommand.mockImplementation(async (_botId, command) => {
      if (command.includes("ContentBase64:")) throw new Error("network unavailable");
      return successResult("Exists: yes\nSlug: custom-upload\nName: 读取测试");
    });

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("已注入：自定义人设 · 读取测试");
    fireEvent.click(screen.getByRole("button", { name: "下载自定义人设" }));

    expect(await screen.findByText("无法读取人设文件，请检查网络后重试"))
      .toBeInTheDocument();
  });

  it("disables both file actions and ignores an old content read after switching Agents", async () => {
    const agentARead = deferred<ReturnType<typeof successResult>>();
    mockedLoadBuddyState.mockResolvedValue({ drawnSouls: [fixtures.agentA], appliedSlug: null });
    repositoryMocks.execDebugCommand.mockImplementation(async (botId, command) => {
      if (botId === "agent-a" && command.includes("ContentBase64:")) return agentARead.promise;
      if (command.includes("in_metadata && /^Name:/")) {
        return successResult(`Exists: yes\nSlug: custom-upload\nName: ${botId === "agent-a" ? "Agent A 自定义" : "Agent B 自定义"}`);
      }
      return successResult();
    });

    const { rerender } = render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("已注入：自定义人设 · Agent A 自定义");
    fireEvent.click(screen.getByRole("button", { name: "编辑自定义人设" }));
    expect(screen.getByRole("button", { name: "编辑自定义人设" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下载自定义人设" })).toBeDisabled();

    rerender(<BuddyPanel botId="agent-b" />);
    expect(await screen.findByText("已注入：自定义人设 · Agent B 自定义"))
      .toBeInTheDocument();

    await act(async () => agentARead.resolve(soulContentResult(
      "# Soul\nSlug: custom-upload\nName: Agent A 自定义\n",
    )));
    expect(screen.queryByRole("dialog", { name: "编辑人设文件" })).not.toBeInTheDocument();
    expect(screen.getByText("已注入：自定义人设 · Agent B 自定义"))
      .toBeInTheDocument();
  });

  it("cancels a pending current-persona download when the panel unmounts", async () => {
    const currentSoulRead = deferred<ReturnType<typeof successResult>>();
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    mockedLoadBuddyState.mockResolvedValue({ drawnSouls: [fixtures.agentA], appliedSlug: null });
    repositoryMocks.execDebugCommand.mockImplementation(async (_botId, command) => {
      if (command.includes("ContentBase64:")) return currentSoulRead.promise;
      return successResult("Exists: yes\nSlug: custom-upload\nName: 下载测试");
    });

    const { unmount } = render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("已注入：自定义人设 · 下载测试");
    fireEvent.click(screen.getByRole("button", { name: "下载自定义人设" }));
    await waitFor(() => expect(repositoryMocks.execDebugCommand).toHaveBeenCalledWith(
      "agent-a",
      expect.stringContaining("ContentBase64:"),
      { timeoutMs: 120_000 },
    ));

    unmount();
    await act(async () => currentSoulRead.resolve(soulContentResult(
      "# Soul\nSlug: custom-upload\nName: 下载测试\n",
    )));

    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("clears a pending file action when a new persona write supersedes its read", async () => {
    const oldRead = deferred<ReturnType<typeof successResult>>();
    let written = false;
    mockedLoadBuddyState.mockResolvedValue({ drawnSouls: [fixtures.agentA], appliedSlug: null });
    repositoryMocks.execDebugCommand.mockImplementation(async (_botId, command) => {
      if (command.includes("ContentBase64:")) return oldRead.promise;
      if (command.includes("base64 -d")) {
        written = true;
        return successResult();
      }
      return successResult(`Exists: yes\nSlug: custom-upload\nName: ${written ? "新人设" : "原人设"}`);
    });

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("已注入：自定义人设 · 原人设");
    fireEvent.click(screen.getByRole("button", { name: "编辑自定义人设" }));
    expect(screen.getByRole("button", { name: "编辑自定义人设" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("选择 Markdown 人设文件"), {
      target: {
        files: [new File([
          "# Soul\nName: 新人设\n\n## Content\n保持简洁。",
        ], "new.md")],
      },
    });
    const uploadDialog = await screen.findByRole("dialog", { name: "编辑人设文件" });
    fireEvent.click(within(uploadDialog).getByRole("button", { name: "注入人设" }));
    fireEvent.click(await screen.findByRole("button", { name: "覆盖并注入" }));

    expect(await screen.findByText("已注入：自定义人设 · 新人设")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑自定义人设" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "下载自定义人设" })).toBeEnabled();

    await act(async () => oldRead.resolve(soulContentResult(
      "# Soul\nSlug: custom-upload\nName: 原人设\n",
    )));
    expect(screen.queryByRole("dialog", { name: "编辑人设文件" })).not.toBeInTheDocument();
  });

  it("discards an old custom-persona read when a recommended persona is injected", async () => {
    if (isGlobal) return;
    const oldRead = deferred<ReturnType<typeof successResult>>();
    const recommendedWrite = deferred<ReturnType<typeof successResult>>();
    mockedLoadBuddyState.mockResolvedValue({ drawnSouls: [fixtures.agentA], appliedSlug: null });
    repositoryMocks.execDebugCommand.mockImplementation(async (_botId, command) => {
      if (command.includes("ContentBase64:")) return oldRead.promise;
      if (command.includes("base64 -d")) return recommendedWrite.promise;
      return successResult("Exists: yes\nSlug: custom-upload\nName: 原人设");
    });

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("已注入：自定义人设 · 原人设");
    fireEvent.click(screen.getByRole("button", { name: "编辑自定义人设" }));
    await waitFor(() => expect(repositoryMocks.execDebugCommand).toHaveBeenCalledWith(
      "agent-a",
      expect.stringContaining("ContentBase64:"),
      { timeoutMs: 120_000 },
    ));

    fireEvent.click(screen.getByRole("button", { name: "选中此人设" }));
    fireEvent.click(screen.getByRole("button", { name: "注入" }));
    await waitFor(() => expect(repositoryMocks.execDebugCommand).toHaveBeenCalledWith(
      "agent-a",
      expect.stringContaining("base64 -d"),
      { timeoutMs: 120_000 },
    ));
    now = 3_000;
    recommendedWrite.resolve(successResult());
    expect(await screen.findByText("人设已注入")).toBeInTheDocument();

    oldRead.resolve(soulContentResult(
      "# Soul\nSlug: custom-upload\nName: 原人设\n",
    ));
    await waitFor(() => expect(
      screen.queryByRole("dialog", { name: "编辑人设文件" }),
    ).not.toBeInTheDocument());

    expect(screen.queryByRole("dialog", { name: "编辑人设文件" })).not.toBeInTheDocument();
  });

  it("keeps Agent B editor open when Agent A save finishes stale", async () => {
    const agentAWrite = deferred<ReturnType<typeof successResult>>();
    const markdownFor = (name: string) => [
      "# Soul",
      "Slug: custom-upload",
      `Name: ${name}`,
      "",
      "## Content",
      `${name} 的内容。`,
      "",
    ].join("\n");
    mockedLoadBuddyState.mockResolvedValue({ drawnSouls: [fixtures.agentA], appliedSlug: null });
    repositoryMocks.execDebugCommand.mockImplementation(async (botId, command) => {
      const name = botId === "agent-a" ? "Agent A 自定义" : "Agent B 自定义";
      if (command.includes("ContentBase64:")) return soulContentResult(markdownFor(name));
      if (botId === "agent-a" && command.includes("base64 -d")) return agentAWrite.promise;
      if (command.includes("in_metadata && /^Name:/")) {
        return successResult(`Exists: yes\nSlug: custom-upload\nName: ${name}`);
      }
      return successResult();
    });

    const { rerender } = render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("已注入：自定义人设 · Agent A 自定义");
    fireEvent.click(screen.getByRole("button", { name: "编辑自定义人设" }));
    const agentADialog = await screen.findByRole("dialog", { name: "编辑人设文件" });
    fireEvent.change(within(agentADialog).getByLabelText("人设内容"), {
      target: { value: markdownFor("Agent A 修改中") },
    });
    fireEvent.click(within(agentADialog).getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(repositoryMocks.execDebugCommand).toHaveBeenCalledWith(
      "agent-a",
      expect.stringContaining("base64 -d"),
      { timeoutMs: 120_000 },
    ));

    rerender(<BuddyPanel botId="agent-b" />);
    await screen.findByText("已注入：自定义人设 · Agent B 自定义");
    fireEvent.click(screen.getByRole("button", { name: "编辑自定义人设" }));
    const agentBDialog = await screen.findByRole("dialog", { name: "编辑人设文件" });
    expect(within(agentBDialog).getByLabelText("人设内容"))
      .toHaveValue(markdownFor("Agent B 自定义"));

    agentAWrite.resolve(successResult());

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "编辑人设文件" })).toBeInTheDocument();
      expect(screen.getByLabelText("人设内容")).toHaveValue(markdownFor("Agent B 自定义"));
    });
  });

  it("uploads a custom persona through the existing Hermes command", async () => {
    let installed = false;
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA],
      appliedSlug: null,
    });
    repositoryMocks.execDebugCommand.mockImplementation(async (_botId, command) => {
      if (command.includes("in_metadata && /^Name:/")) {
        return successResult(installed
          ? "Exists: yes\nSlug: custom-upload\nName: 我的专属搭档"
          : "Exists: no");
      }
      if (command.includes("base64 -d")) installed = true;
      return successResult();
    });

    render(<BuddyPanel botId="agent-a" />);
    await screen.findByText("Agent A Soul");
    const uploadButton = await screen.findByRole("button", { name: "上传人设文件" });
    expect(uploadButton).toBeEnabled();

    fireEvent.change(screen.getByLabelText("选择 Markdown 人设文件"), {
      target: {
        files: [new File([
          "# Soul\nName: 我的专属搭档\n\n## Content\n保持简洁。",
        ], "mine.md")],
      },
    });
    const dialog = await screen.findByRole("dialog", { name: "上传人设文件" });
    fireEvent.click(within(dialog).getByRole("button", { name: "注入人设" }));

    await waitFor(() => expect(repositoryMocks.execDebugCommand).toHaveBeenCalledWith(
      "agent-a",
      expect.stringContaining('base64 -d > "$TEMP"'),
      { timeoutMs: 120_000 },
    ));
    expect(await screen.findByText("已注入：自定义人设 · 我的专属搭档"))
      .toBeInTheDocument();
    expect(await screen.findByText("人设已注入")).toBeInTheDocument();
  });

  it("keeps the real custom status when a recommended persona write falls back", async () => {
    if (isGlobal) return;
    mockedLoadBuddyState.mockResolvedValue({
      drawnSouls: [fixtures.agentA],
      appliedSlug: null,
    });
    repositoryMocks.execDebugCommand.mockImplementation(async (_botId, command) => {
      if (command.includes("in_metadata && /^Name:/")) {
        return successResult("Exists: yes\nSlug: custom-upload\nName: 真实自定义人设");
      }
      if (command.includes("base64 -d")) throw new Error("sandbox unavailable");
      return successResult();
    });

    render(<BuddyPanel botId="agent-a" />);
    expect(await screen.findByText("已注入：自定义人设 · 真实自定义人设"))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "选中此人设" }));
    fireEvent.click(screen.getByRole("button", { name: "注入" }));

    expect(await screen.findByText("无法写入 Agent 沙箱，已下载 soul.md 到本地", {}, {
      timeout: 3_000,
    })).toBeInTheDocument();
    expect(screen.getByText("已注入：自定义人设 · 真实自定义人设"))
      .toBeInTheDocument();
    expect(screen.queryByLabelText("当前已注入到 Agent")).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "测试人设" }));
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
        return successResult(`Exists: yes\nSlug: ${fixtures.agentA.slug}\nName: Agent A Soul`);
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
