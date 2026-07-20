import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SkillsDataLayer } from "./skill-registries";
import { SkillsDemoPanel } from "./SkillsDemoPanel";

const mocks = vi.hoisted(() => ({
  createSkillsDataLayer: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string, options?: Record<string, unknown>) => (
    options
      ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => String(options[key]))
      : text
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { resolvedLanguage: "zh-CN" } }),
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

vi.mock("./skill-registries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./skill-registries")>();
  return { ...actual, createSkillsDataLayer: mocks.createSkillsDataLayer };
});

afterEach(() => cleanup());

function makeDataLayer(mode: "global" | "domestic"): SkillsDataLayer {
  const registry = mode === "domestic" ? "skillhub" as const : "clawhub" as const;
  const searchSkills = Array.from({ length: 13 }, (_, index) => ({
    registry,
    rawId: index === 0 ? "first" : index === 1 ? "second" : `skill-${index + 1}`,
    slug: index === 0 ? "first" : index === 1 ? "second" : `skill-${index + 1}`,
    name: index === 0 ? "First" : index === 1 ? "Second" : `Skill ${index + 1}`,
    installs: index === 0 ? 20_001 : undefined,
    downloads: index === 0 ? 10_001 : undefined,
  }));
  return {
    search: vi.fn(async () => ({
      clawhub: mode === "global" ? searchSkills : [],
      skillssh: [],
      skillhub: mode === "domestic" ? searchSkills : [],
      failedSources: [],
    })),
    listInstalled: vi.fn(async () => ({
      failedSources: [],
      skills: [{
        registry: "skillhub",
        rawId: "builder-radar",
        slug: "builder-radar",
        name: "Builder Radar",
        category: "productivity",
        version: "1.2.3",
        iconUrl: "https://cdn.example.com/builder-radar.png",
        registries: ["skillhub", "hermes"],
        sourceLabel: "SkillHub / Hermes",
        uninstallable: true,
      }, {
        registry: "hermes",
        rawId: "finance-news",
        slug: "finance-news",
        name: "Finance News",
        status: "disabled",
        registries: ["hermes"],
        nativeSource: "local",
        sourceLabel: "本地安装",
        uninstallable: true,
      }],
    })),
    install: vi.fn(async () => ({ ok: true })),
    uninstall: vi.fn(async () => ({ ok: true })),
    getPopular: vi.fn(async () => ({ clawhub: [], skillssh: [], skillhub: [] })),
  };
}

function renderPanel(mode: "global" | "domestic" = "global", initialTab: "discover" | "installed" = "discover") {
  const dataLayer = makeDataLayer(mode);
  mocks.createSkillsDataLayer.mockReturnValue(dataLayer);
  render(
    <SkillsDemoPanel
      botId="bot-1"
      execDebugCommand={vi.fn()}
      mode={mode}
      initialTab={initialTab}
    />,
  );
  return dataLayer;
}

describe.each(["global", "domestic"] as const)("SkillsDemoPanel %s mode", (mode) => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("renders Installed as a structured list with real sources and offers single deletion", async () => {
    const dataLayer = renderPanel(mode, "installed");
    await screen.findByText("finance-news");

    const nativeItem = screen.getByText("finance-news").closest("li");
    const registryItem = screen.getByText("builder-radar").closest("li");
    const installedList = nativeItem?.closest("ul");
    expect(screen.getByText("名称/Slug")).toBeInTheDocument();
    expect(within(nativeItem as HTMLElement).getByText("Finance News")).toBeInTheDocument();
    expect(within(nativeItem as HTMLElement).getByText("finance-news")).toBeInTheDocument();
    expect(within(registryItem as HTMLElement).getByText("Builder Radar")).toBeInTheDocument();
    expect(within(registryItem as HTMLElement).getByText("builder-radar")).toBeInTheDocument();
    expect(screen.getAllByText("分类").length).toBeGreaterThan(0);
    expect(screen.getAllByText("来源").length).toBeGreaterThan(0);
    expect(screen.getAllByText("版本").length).toBeGreaterThan(0);
    expect(screen.getByText("操作")).toBeInTheDocument();
    expect(installedList).toHaveClass("divide-y");
    expect(installedList).not.toHaveClass("grid", "gap-2");
    expect(nativeItem).not.toHaveClass("border", "rounded-md");
    expect(registryItem).toHaveTextContent("SkillHub");
    expect(registryItem).toHaveTextContent("效率工具");
    expect(registryItem).not.toHaveTextContent("SkillHubHermes");
    expect(registryItem).toHaveTextContent("v1.2.3");
    expect(nativeItem).toHaveTextContent("本地安装");
    expect(nativeItem).toHaveTextContent("未分类");
    expect(nativeItem).toHaveTextContent("已禁用");
    const nativeDelete = within(nativeItem as HTMLElement).getByRole("button", { name: /删除技能/ });
    expect(within(registryItem as HTMLElement).getByRole("button", { name: /删除技能/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "批量卸载" })).not.toBeInTheDocument();

    fireEvent.click(nativeDelete);
    expect(dataLayer.uninstall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除 Finance News" }));
    await waitFor(() => expect(dataLayer.uninstall).toHaveBeenCalledWith(expect.objectContaining({
      registry: "hermes",
      rawId: "finance-news",
    })));
  });

  it("always renders both name and slug rows even when their text is identical", async () => {
    const dataLayer = makeDataLayer(mode);
    dataLayer.listInstalled = vi.fn(async () => ({
      failedSources: [],
      skills: [{
        registry: "hermes" as const,
        rawId: "same-slug",
        slug: "same-slug",
        name: "same-slug",
        registries: ["hermes" as const],
        nativeSource: "local",
        sourceLabel: "本地安装",
      }],
    }));
    mocks.createSkillsDataLayer.mockReturnValue(dataLayer);

    render(<SkillsDemoPanel botId="bot-1" execDebugCommand={vi.fn()} mode={mode} initialTab="installed" />);

    const row = (await screen.findAllByText("same-slug"))[0]?.closest("li") as HTMLElement;
    expect(within(row).getAllByText("same-slug")).toHaveLength(2);
  });

  it("filters installed skills by name and install source", async () => {
    renderPanel(mode, "installed");
    await screen.findByText("finance-news");

    const search = screen.getByRole("searchbox", { name: "搜索已安装技能" });
    fireEvent.change(search, { target: { value: "builder" } });
    expect(screen.getByText("builder-radar")).toBeInTheDocument();
    expect(screen.queryByText("finance-news")).not.toBeInTheDocument();
    expect(screen.getByText("(1/2)")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "" } });
    const sourceFilter = screen.getByRole("combobox", { name: "筛选技能来源" });
    fireEvent.click(sourceFilter);
    fireEvent.click(await screen.findByRole("option", { name: /本地安装/ }));
    expect(screen.getByText("finance-news")).toBeInTheDocument();
    expect(screen.queryByText("builder-radar")).not.toBeInTheDocument();

    fireEvent.click(sourceFilter);
    fireEvent.click(await screen.findByRole("option", { name: /全部来源/ }));
    const categoryFilter = screen.getByRole("combobox", { name: "筛选技能分类" });
    fireEvent.click(categoryFilter);
    fireEvent.click(await screen.findByRole("option", { name: /效率工具/ }));
    expect(screen.getByText("builder-radar")).toBeInTheDocument();
    expect(screen.queryByText("finance-news")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByText("没有匹配的已安装技能")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByText("builder-radar")).toBeInTheDocument();
    expect(screen.getByText("finance-news")).toBeInTheDocument();
  });

  it("orders installed source filters by product priority", async () => {
    const dataLayer = makeDataLayer(mode);
    dataLayer.listInstalled = vi.fn(async () => ({
      failedSources: [],
      skills: [{
        registry: "hermes" as const,
        rawId: "chat-installed",
        slug: "chat-installed",
        name: "Chat Installed",
        registries: ["hermes" as const],
        nativeSource: "other",
        sourceLabel: "其他",
      }, {
        registry: "hermes" as const,
        rawId: "find-skills",
        slug: "find-skills",
        name: "Find Skills",
        registries: ["hermes" as const],
        nativeSource: "local",
        sourceLabel: "本地安装",
      }, {
        registry: "hermes" as const,
        rawId: "builtin-tool",
        slug: "builtin-tool",
        name: "Builtin Tool",
        registries: ["hermes" as const],
        nativeSource: "builtin",
        sourceLabel: "系统预置",
      }, {
        registry: "skillhub" as const,
        rawId: "market-tool",
        slug: "market-tool",
        name: "Market Tool",
        registries: ["skillhub" as const, "hermes" as const],
        sourceLabel: "SkillHub",
      }],
    }));
    mocks.createSkillsDataLayer.mockReturnValue(dataLayer);
    render(
      <SkillsDemoPanel
        botId="bot-1"
        execDebugCommand={vi.fn()}
        mode={mode}
        initialTab="installed"
      />,
    );
    await screen.findByText("find-skills");

    fireEvent.click(screen.getByRole("combobox", { name: "筛选技能来源" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "全部来源 (4)",
      "SkillHub (1)",
      "系统预置 (1)",
      "本地安装 (1)",
      "其他 (1)",
    ]);
  });

  it("does not render skill icons or icon links in Installed rows", async () => {
    renderPanel(mode, "installed");
    await screen.findByText("finance-news");

    const registryItem = screen.getByText("builder-radar").closest("li") as HTMLElement;
    const nativeItem = screen.getByText("finance-news").closest("li") as HTMLElement;
    expect(registryItem.querySelector("img")).toBeNull();
    expect(nativeItem.querySelector("img")).toBeNull();
    expect(registryItem.querySelector("a")).toBeNull();
    expect(nativeItem.querySelector("a")).toBeNull();
  });

  it("shows a retryable error instead of an empty state when installed loading fails", async () => {
    const dataLayer = makeDataLayer(mode);
    vi.mocked(dataLayer.listInstalled).mockRejectedValue(new Error("list failed"));
    mocks.createSkillsDataLayer.mockReturnValue(dataLayer);
    render(
      <SkillsDemoPanel botId="bot-1" execDebugCommand={vi.fn()} mode={mode} initialTab="installed" />,
    );

    expect(await screen.findByText("无法获取已安装技能")).toBeInTheDocument();
    expect(screen.queryByText("还没有已安装的技能")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(dataLayer.listInstalled).toHaveBeenCalledTimes(2));
  });

  it("clears the previous Agent list when switching Agents even if the next load fails", async () => {
    const firstLayer = makeDataLayer(mode);
    const secondLayer = makeDataLayer(mode);
    vi.mocked(secondLayer.listInstalled).mockRejectedValue(new Error("second list failed"));
    mocks.createSkillsDataLayer.mockImplementation((botId) => (botId === "bot-1" ? firstLayer : secondLayer));
    const { rerender } = render(
      <SkillsDemoPanel botId="bot-1" execDebugCommand={vi.fn()} mode={mode} initialTab="installed" />,
    );
    await screen.findByText("finance-news");

    rerender(<SkillsDemoPanel botId="bot-2" execDebugCommand={vi.fn()} mode={mode} initialTab="installed" />);

    expect(await screen.findByText("无法获取已安装技能")).toBeInTheDocument();
    expect(screen.queryByText("finance-news")).not.toBeInTheDocument();
  });

  it("marks partial-source rows as unavailable and prevents deletion", async () => {
    const dataLayer = makeDataLayer(mode);
    vi.mocked(dataLayer.listInstalled).mockResolvedValue({
      failedSources: [mode === "domestic" ? "skillhub" : "clawhub"],
      skills: [{
        registry: "hermes",
        rawId: "ambiguous-skill",
        slug: "ambiguous-skill",
        name: "Ambiguous Skill",
        registries: ["hermes"],
        nativeSource: "unavailable",
        sourceLabel: "来源暂不可用",
        sourceUncertain: true,
        uninstallable: false,
      }],
    });
    mocks.createSkillsDataLayer.mockReturnValue(dataLayer);
    render(
      <SkillsDemoPanel botId="bot-1" execDebugCommand={vi.fn()} mode={mode} initialTab="installed" />,
    );

    const row = (await screen.findByText("ambiguous-skill")).closest("li") as HTMLElement;
    expect(row).toHaveTextContent("来源暂不可用");
    expect(screen.getByText("部分技能来源暂不可用，相关技能暂时不能删除")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /删除技能/ })).not.toBeInTheDocument();
  });

  it("paginates installed skills in groups of ten", async () => {
    const dataLayer = makeDataLayer(mode);
    vi.mocked(dataLayer.listInstalled).mockResolvedValue({
      failedSources: [],
      skills: Array.from({ length: 11 }, (_, index) => ({
        registry: "hermes" as const,
        rawId: `installed-${index + 1}`,
        slug: `installed-${index + 1}`,
        name: `Installed ${index + 1}`,
        registries: ["hermes" as const],
        nativeSource: "local",
        sourceLabel: "本地安装",
        uninstallable: true,
      })),
    });
    mocks.createSkillsDataLayer.mockReturnValue(dataLayer);
    render(
      <SkillsDemoPanel botId="bot-1" execDebugCommand={vi.fn()} mode={mode} initialTab="installed" />,
    );

    await screen.findByText("installed-1");
    expect(screen.queryByText("installed-11")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("installed-11")).toBeInTheDocument();
  });

  it("enables batch install after selecting search results and installs every selected skill", async () => {
    const dataLayer = renderPanel(mode);
    expect(screen.queryByRole("button", { name: "安装已选技能" })).not.toBeInTheDocument();
    if (mode === "domestic") {
      expect(screen.queryByRole("combobox", { name: "来源" })).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole("combobox", { name: "来源" })).toHaveClass("!justify-center");
    }
    expect(screen.getByPlaceholderText(
      mode === "domestic" ? "搜索 SkillHub 中的技能" : "搜索 Skills.sh / Clawhub 中的技能",
    )).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/搜索 .*技能/), { target: { value: "tools" } });
    const firstSelector = await screen.findByRole("button", { name: "选择批量安装 First" }, { timeout: 3_000 });
    const secondSelector = screen.getByRole("button", { name: "选择批量安装 Second" });
    const batchButton = screen.getByRole("button", { name: "安装已选技能" });
    expect(screen.getByText("已选 0 / 13")).toBeInTheDocument();
    expect(batchButton).toBeDisabled();
    expect(batchButton).toHaveClass("h-9", "px-6", "rounded-[12px]", "text-sm");
    expect(batchButton).not.toHaveClass("text-xs");
    expect(batchButton).not.toHaveClass("min-w-32");
    fireEvent.click(firstSelector);
    fireEvent.click(secondSelector);

    expect(batchButton).toBeEnabled();
    expect(screen.getByText("已选 2 / 13")).toBeInTheDocument();
    expect(batchButton).toHaveTextContent(/^安装$/);
    fireEvent.click(batchButton);

    await waitFor(() => expect(dataLayer.install).toHaveBeenCalledTimes(2));
    expect(vi.mocked(dataLayer.install).mock.calls.map(([skill]) => skill.rawId)).toEqual(["first", "second"]);
    expect(batchButton).toBeDisabled();
  });

  it("shows only the registries available in the current market", async () => {
    renderPanel(mode);

    if (mode === "domestic") {
      expect(screen.queryByRole("combobox", { name: "来源" })).not.toBeInTheDocument();
    } else {
      fireEvent.click(screen.getByRole("combobox", { name: "来源" }));
      expect(await screen.findByRole("option", { name: "所有来源" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "skills.sh" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "ClawHub" })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: "SkillHub" })).not.toBeInTheDocument();
    }
  });

  it("does not show the batch toolbar when search has no installable results", async () => {
    const dataLayer = renderPanel(mode);
    vi.mocked(dataLayer.search).mockResolvedValue({ clawhub: [], skillssh: [], skillhub: [], failedSources: [] });

    fireEvent.change(screen.getByRole("textbox", { name: "搜索技能" }), { target: { value: "missing" } });

    expect(await screen.findByText("没有找到匹配的技能", {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(screen.queryByText(/已选 \d+ \/ \d+/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "安装已选技能" })).not.toBeInTheDocument();
  });

  it("removes stale remembered install identities after an authoritative installed refresh", async () => {
    window.localStorage.setItem(
      "lightvela-skills-demo-known-installed:bot-1",
      JSON.stringify([`${mode === "domestic" ? "skillhub" : "clawhub"}:first`]),
    );
    const dataLayer = renderPanel(mode);
    await waitFor(() => expect(dataLayer.listInstalled).toHaveBeenCalled());

    fireEvent.change(screen.getByRole("textbox", { name: "搜索技能" }), { target: { value: "tools" } });

    expect(await screen.findByRole("button", { name: "选择批量安装 First" }, { timeout: 3_000 })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("lightvela-skills-demo-known-installed:bot-1") ?? "[]")).toEqual([]);
  });

  it("locks every install and selection control while a batch install is running", async () => {
    const dataLayer = renderPanel(mode);
    let resolveFirst: ((result: { ok: true }) => void) | undefined;
    let resolveSecond: ((result: { ok: true }) => void) | undefined;
    vi.mocked(dataLayer.install)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSecond = resolve;
      }));

    fireEvent.change(screen.getByPlaceholderText(/搜索 .*技能/), { target: { value: "tools" } });
    const firstSelector = await screen.findByRole("button", { name: "选择批量安装 First" }, { timeout: 3_000 });
    const secondSelector = screen.getByRole("button", { name: "选择批量安装 Second" });
    const thirdSelector = screen.getByRole("button", { name: "选择批量安装 Skill 3" });
    fireEvent.click(firstSelector);
    fireEvent.click(secondSelector);
    fireEvent.click(screen.getByRole("button", { name: "安装已选技能" }));

    await waitFor(() => expect(dataLayer.install).toHaveBeenCalledTimes(1));
    const firstRow = screen.getByText("First").closest("li") as HTMLElement;
    const secondRow = screen.getByText("Second").closest("li") as HTMLElement;
    expect(screen.getByRole("status")).toHaveTextContent("正在安装 (1/2)：First");
    expect(within(firstRow).getByText("安装中...")).toBeInTheDocument();
    expect(within(secondRow).getByText("等待中")).toBeInTheDocument();
    expect(firstSelector).toBeDisabled();
    expect(secondSelector).toBeDisabled();
    expect(thirdSelector).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "搜索技能" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "按热度" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "按名称" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: /已安装/ })).toBeDisabled();
    if (mode === "global") {
      expect(screen.getByRole("combobox", { name: "来源" })).toBeDisabled();
    }
    fireEvent.click(thirdSelector);
    expect(screen.getByRole("button", { name: "安装已选技能" })).toHaveTextContent(/^安装$/);

    resolveFirst?.({ ok: true });
    await waitFor(() => expect(dataLayer.install).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status")).toHaveTextContent("正在安装 (2/2)：Second");
    expect(within(firstRow).getByText("已安装")).toBeInTheDocument();
    expect(within(secondRow).getByText("安装中...")).toBeInTheDocument();
    resolveSecond?.({ ok: true });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("cancels the remaining batch items after the current install finishes", async () => {
    const dataLayer = renderPanel(mode);
    let resolveFirst: ((result: { ok: true }) => void) | undefined;
    vi.mocked(dataLayer.install).mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirst = resolve;
    }));

    fireEvent.change(screen.getByRole("textbox", { name: "搜索技能" }), { target: { value: "tools" } });
    fireEvent.click(await screen.findByRole("button", { name: "选择批量安装 First" }, { timeout: 3_000 }));
    fireEvent.click(screen.getByRole("button", { name: "选择批量安装 Second" }));
    fireEvent.click(screen.getByRole("button", { name: "安装已选技能" }));

    const cancelButton = await screen.findByRole("button", { name: "取消剩余任务" });
    fireEvent.click(cancelButton);
    expect(screen.getByRole("button", { name: "取消中..." })).toBeDisabled();
    resolveFirst?.({ ok: true });

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(dataLayer.install).toHaveBeenCalledTimes(1);
    const secondRow = screen.getByText("Second").closest("li") as HTMLElement;
    expect(within(secondRow).getByText("已跳过")).toBeInTheDocument();
    expect(mocks.toastError).toHaveBeenCalledWith("已取消安装：成功 1 个，失败 0 个，跳过 1 个");
  });

  it("shows registry search failures separately from empty results and retries", async () => {
    const dataLayer = renderPanel(mode);
    vi.mocked(dataLayer.search)
      .mockResolvedValueOnce({
        clawhub: [],
        skillssh: [],
        skillhub: [],
        failedSources: mode === "domestic" ? ["skillhub"] : ["clawhub"],
      })
      .mockResolvedValueOnce({
        clawhub: mode === "global" ? [{ registry: "clawhub", rawId: "retry", slug: "retry", name: "Retry Result" }] : [],
        skillssh: [],
        skillhub: mode === "domestic" ? [{ registry: "skillhub", rawId: "retry", slug: "retry", name: "Retry Result" }] : [],
        failedSources: [],
      });

    fireEvent.change(screen.getByRole("textbox", { name: "搜索技能" }), { target: { value: "retry" } });
    const alert = await screen.findByRole("alert", {}, { timeout: 3_000 });
    expect(alert).toHaveTextContent(mode === "domestic"
      ? "技能搜索失败，请重试"
      : "ClawHub 搜索失败，当前结果可能不完整");
    expect(screen.queryByText("没有找到匹配的技能")).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));

    expect(await screen.findByText("Retry Result")).toBeInTheDocument();
    expect(dataLayer.search).toHaveBeenCalledTimes(2);
  });

  it("disables registry search retry while a batch install is running", async () => {
    const dataLayer = renderPanel(mode);
    const registry = mode === "domestic" ? "skillhub" as const : "clawhub" as const;
    let resolveInstall: ((result: { ok: true }) => void) | undefined;
    vi.mocked(dataLayer.search).mockResolvedValue({
      clawhub: mode === "global" ? [{ registry, rawId: "retry-lock", slug: "retry-lock", name: "Retry Lock" }] : [],
      skillssh: [],
      skillhub: mode === "domestic" ? [{ registry, rawId: "retry-lock", slug: "retry-lock", name: "Retry Lock" }] : [],
      failedSources: [registry],
    });
    vi.mocked(dataLayer.install).mockImplementation(() => new Promise((resolve) => {
      resolveInstall = resolve;
    }));

    fireEvent.change(screen.getByRole("textbox", { name: "搜索技能" }), { target: { value: "retry-lock" } });
    const alert = await screen.findByRole("alert", {}, { timeout: 3_000 });
    fireEvent.click(screen.getByRole("button", { name: "选择批量安装 Retry Lock" }));
    fireEvent.click(screen.getByRole("button", { name: "安装已选技能" }));

    await waitFor(() => expect(dataLayer.install).toHaveBeenCalledTimes(1));
    const retryButton = within(alert).getByRole("button", { name: "重试" });
    expect(retryButton).toBeDisabled();
    fireEvent.click(retryButton);
    expect(dataLayer.search).toHaveBeenCalledTimes(1);

    resolveInstall?.({ ok: true });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("reports a successful single install as installed", async () => {
    const dataLayer = renderPanel(mode);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索技能" }), { target: { value: "tools" } });

    const firstResult = await screen.findByText("First");
    const firstItem = firstResult.closest("li") as HTMLElement;
    fireEvent.click(within(firstItem).getByRole("button", { name: "安装" }));

    await waitFor(() => expect(dataLayer.install).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("安装成功");
  });

  it("shows failed and skipped row states and allows retry", async () => {
    const dataLayer = renderPanel(mode);
    let resolveRetry: ((result: { ok: true }) => void) | undefined;
    vi.mocked(dataLayer.install)
      .mockResolvedValueOnce({ ok: false, message: "download failed" })
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveRetry = resolve;
      }))
      .mockResolvedValueOnce({ ok: false, message: "skipped by registry" });
    fireEvent.change(screen.getByRole("textbox", { name: "搜索技能" }), { target: { value: "tools" } });

    const firstRow = (await screen.findByText("First")).closest("li") as HTMLElement;
    fireEvent.click(within(firstRow).getByRole("button", { name: "安装" }));
    expect(await within(firstRow).findByText("失败")).toBeInTheDocument();
    const retryButton = within(firstRow).getByRole("button", { name: "重试" });
    expect(retryButton).toBeInTheDocument();

    fireEvent.click(retryButton);
    expect(await within(firstRow).findByText("重试中...")).toBeInTheDocument();
    resolveRetry?.({ ok: true });
    await waitFor(() => expect(within(firstRow).getByLabelText("已安装")).toBeInTheDocument());

    const secondRow = screen.getByText("Second").closest("li") as HTMLElement;
    fireEvent.click(within(secondRow).getByRole("button", { name: "安装" }));
    expect(await within(secondRow).findByText("已跳过")).toBeInTheDocument();
    expect(within(secondRow).getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(dataLayer.install).toHaveBeenCalledTimes(3);
  });

  it("renders the expand and collapse control as a button below the searched skills", async () => {
    renderPanel(mode);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索技能" }), { target: { value: "tools" } });

    const firstResult = await screen.findByText("First");
    const resultsList = firstResult.closest("ul");
    const expandButton = screen.getByRole("button", { name: "查看更多" });
    expect(resultsList?.nextElementSibling).toContainElement(expandButton);
    expect(expandButton).toHaveClass("h-8", "min-w-28", "rounded-full", "bg-transparent", "text-xs");
    expect(expandButton).toHaveAttribute("aria-expanded", "false");
    expect(expandButton.querySelector("svg")).toBeInTheDocument();

    fireEvent.click(expandButton);
    const collapseButton = screen.getByRole("button", { name: "收起" });
    expect(screen.getByText("Skill 13")).toBeInTheDocument();
    expect(resultsList?.nextElementSibling).toContainElement(collapseButton);
    expect(collapseButton).toHaveAttribute("aria-expanded", "true");
    expect(collapseButton.querySelector("svg")).toBeInTheDocument();
  });

  it("limits batch selection to search results", async () => {
    renderPanel(mode);
    const featuredSection = screen.getByText("精选").closest("section") as HTMLElement;
    const categorySection = screen
      .getByText(mode === "domestic" ? "理财分析" : "市场分析")
      .closest("section") as HTMLElement;

    expect(within(featuredSection).queryByRole("button", { name: /选择批量安装/ })).not.toBeInTheDocument();
    expect(within(categorySection).queryByRole("button", { name: /选择批量安装/ })).not.toBeInTheDocument();
    expect(within(featuredSection).getAllByRole("button", { name: "安装" }).length).toBeGreaterThan(0);
    expect(within(categorySection).getAllByRole("button", { name: "安装" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "安装已选技能" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索技能" }), { target: { value: "tools" } });
    const searchSelector = await screen.findByRole("button", { name: "选择批量安装 First" }, { timeout: 3_000 });
    expect(screen.getByRole("button", { name: "按热度" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "按名称" })).toBeInTheDocument();
    const firstSearchRow = searchSelector.closest("li") as HTMLElement;
    const searchList = firstSearchRow.parentElement as HTMLElement;
    expect(searchList).toHaveClass("overflow-hidden", "border", "bg-white");
    expect(searchList).not.toHaveClass("grid", "md:grid-cols-2");
    expect(firstSearchRow).toHaveClass("border-b", "last:border-b-0");
    expect(firstSearchRow).not.toHaveClass("rounded-md");
    expect(within(firstSearchRow).getByText("first")).toHaveClass("font-mono");
    expect(firstSearchRow.querySelector("img")).toBeNull();
    expect(within(firstSearchRow).queryByText(mode === "domestic" ? "SkillHub" : "ClawHub")).not.toBeInTheDocument();
    expect(within(firstSearchRow).queryByText("热门")).not.toBeInTheDocument();
    const batchButton = screen.getByRole("button", { name: "安装已选技能" });
    expect(batchButton).toBeDisabled();
    fireEvent.click(searchSelector);
    expect(batchButton).toBeEnabled();
    expect(batchButton).toHaveTextContent(/^安装$/);
  });

  it("keeps international sources by the search field and moves the domestic source below results", async () => {
    renderPanel(mode);
    const tabs = screen.getByRole("tablist", { name: "技能市场页面切换" });
    const tabRule = tabs.parentElement as HTMLElement;
    const searchInput = screen.getByRole("textbox", { name: "搜索技能" });
    const searchRow = searchInput.closest("div")?.parentElement as HTMLElement;

    expect(tabRule).toHaveClass("border-b", "items-end");
    expect(tabs).not.toHaveClass("!border-b");
    expect(searchRow).toHaveClass("sm:flex-row", "sm:items-center");
    if (mode === "domestic") {
      expect(within(searchRow).queryByRole("link", { name: "源自 SkillHub" })).not.toBeInTheDocument();
      fireEvent.change(searchInput, { target: { value: "tools" } });
      const firstResult = await screen.findByText("First");
      const resultsList = firstResult.closest("ul") as HTMLElement;
      const sourceFooter = resultsList.nextElementSibling as HTMLElement;
      const sourceLink = within(sourceFooter).getByRole("link", { name: "源自 SkillHub" });
      expect(sourceFooter).toHaveClass("grid", "grid-cols-[1fr_auto_1fr]", "items-center");
      expect(within(sourceFooter).getByRole("button", { name: "查看更多" })).toHaveClass("h-8", "col-start-2");
      expect(sourceLink).toHaveAttribute("href", "https://skillhub.cn");
      expect(sourceLink).toHaveClass("h-8", "col-start-3", "justify-self-end", "text-[#2563EB]", "hover:text-[#1D4ED8]", "hover:underline");
      expect(sourceLink).toHaveTextContent("源自 SkillHub↗");
    } else {
      const sourceLine = searchRow.lastElementChild as HTMLElement;
      expect(tabRule).not.toContainElement(sourceLine);
      expect(sourceLine).toHaveClass("shrink-0", "text-right");
      expect(sourceLine).toHaveTextContent("技能来源于 Skills.sh 与 ClawHub");
      expect(sourceLine).not.toHaveClass("border");
      expect(within(sourceLine).getByRole("link", { name: "Skills.sh" })).toHaveAttribute("href", "https://skills.sh");
      expect(within(sourceLine).getByRole("link", { name: "ClawHub" })).toHaveAttribute("href", "https://clawhub.ai/");
    }
  });
});

describe("SkillsDemoPanel installed identity boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("does not keep a ClawHub result installed when only a skills.sh skill has the same slug", async () => {
    window.localStorage.setItem(
      "lightvela-skills-demo-known-installed:bot-1",
      JSON.stringify(["clawhub:first"]),
    );
    const dataLayer = makeDataLayer("global");
    vi.mocked(dataLayer.listInstalled).mockResolvedValue({
      failedSources: [],
      skills: [{
        registry: "skills-sh",
        rawId: "team/repository/first",
        slug: "first",
        name: "Skills.sh First",
        registries: ["skills-sh", "hermes"],
        sourceLabel: "skills.sh",
      }],
    });
    mocks.createSkillsDataLayer.mockReturnValue(dataLayer);

    render(<SkillsDemoPanel botId="bot-1" execDebugCommand={vi.fn()} mode="global" initialTab="discover" />);
    await waitFor(() => expect(dataLayer.listInstalled).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("textbox", { name: "搜索技能" }), { target: { value: "tools" } });

    expect(await screen.findByRole("button", { name: "选择批量安装 First" }, { timeout: 3_000 })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("lightvela-skills-demo-known-installed:bot-1") ?? "[]")).toEqual([]);
  });
});
