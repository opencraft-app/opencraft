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

function makeDataLayer(): SkillsDataLayer {
  const searchSkills = Array.from({ length: 13 }, (_, index) => ({
    registry: "clawhub" as const,
    rawId: index === 0 ? "first" : index === 1 ? "second" : `skill-${index + 1}`,
    slug: index === 0 ? "first" : index === 1 ? "second" : `skill-${index + 1}`,
    name: index === 0 ? "First" : index === 1 ? "Second" : `Skill ${index + 1}`,
  }));
  return {
    search: vi.fn(async () => ({
      clawhub: searchSkills,
      skillssh: [],
      skillhub: [],
    })),
    listInstalled: vi.fn(async () => [
      {
        registry: "skillhub",
        rawId: "builder-radar",
        slug: "builder-radar",
        name: "Builder Radar",
        iconUrl: "https://cdn.example.com/builder-radar.png",
        registries: ["skillhub"],
        sourceLabel: "SkillHub",
        uninstallable: true,
      },
      {
        registry: "hermes",
        rawId: "finance-news",
        slug: "finance-news",
        name: "Finance News",
        registries: ["hermes"],
        sourceLabel: "Hermes",
        uninstallable: true,
      },
    ]),
    install: vi.fn(async () => ({ ok: true })),
    uninstall: vi.fn(async () => ({ ok: true })),
    getPopular: vi.fn(async () => ({ clawhub: [], skillssh: [], skillhub: [] })),
  };
}

function renderPanel(mode: "global" | "domestic" = "global", initialTab: "discover" | "installed" = "discover") {
  const dataLayer = makeDataLayer();
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
  });

  it("renders Installed as a single-column list and offers real deletion for registry and Hermes-native skills", async () => {
    const dataLayer = renderPanel(mode, "installed");
    await screen.findByText("Finance News");

    const nativeItem = screen.getByText("Finance News").closest("li");
    const registryItem = screen.getByText("Builder Radar").closest("li");
    const installedList = nativeItem?.closest("ul");
    expect(installedList).toHaveClass("border-y", "divide-y");
    expect(installedList).not.toHaveClass("grid", "gap-2");
    expect(nativeItem).not.toHaveClass("border", "rounded-md");
    expect(registryItem).not.toHaveTextContent("SkillHub");
    expect(nativeItem).not.toHaveTextContent("Hermes");
    const nativeBatchSelect = within(nativeItem as HTMLElement).getByRole("button", {
      name: "选择批量卸载 Finance News",
    });
    const nativeDelete = within(nativeItem as HTMLElement).getByRole("button", { name: /删除技能/ });
    expect(nativeBatchSelect.compareDocumentPosition(nativeDelete) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(registryItem as HTMLElement).getByRole("button", { name: /删除技能/ })).toBeInTheDocument();

    fireEvent.click(nativeDelete);
    expect(dataLayer.uninstall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除 Finance News" }));
    await waitFor(() => expect(dataLayer.uninstall).toHaveBeenCalledWith(expect.objectContaining({
      registry: "hermes",
      rawId: "finance-news",
    })));
  });

  it("selects installed rows and batch-uninstalls them after one confirmation", async () => {
    const dataLayer = renderPanel(mode, "installed");
    await screen.findByText("Finance News");

    let resolveFirst: ((result: { ok: true }) => void) | undefined;
    vi.mocked(dataLayer.uninstall)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValue({ ok: true });

    const batchButton = screen.getByRole("button", { name: "批量卸载" });
    const builderSelect = screen.getByRole("button", { name: "选择批量卸载 Builder Radar" });
    const financeSelect = screen.getByRole("button", { name: "选择批量卸载 Finance News" });
    const builderDelete = screen.getByRole("button", { name: "删除技能 Builder Radar" });
    expect(batchButton).toBeDisabled();
    expect(batchButton).toHaveClass("h-10", "w-32", "rounded-[12px]");
    expect(batchButton).not.toHaveClass("w-40");

    fireEvent.click(builderSelect);
    fireEvent.click(financeSelect);
    expect(batchButton).toBeEnabled();
    expect(batchButton).toHaveTextContent("(2)");

    fireEvent.click(batchButton);
    expect(dataLayer.uninstall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认批量卸载 2 个技能" }));
    await waitFor(() => expect(dataLayer.uninstall).toHaveBeenCalledTimes(1));
    expect(builderSelect).toBeDisabled();
    expect(financeSelect).toBeDisabled();
    expect(builderDelete).toBeDisabled();

    resolveFirst?.({ ok: true });
    await waitFor(() => expect(dataLayer.uninstall).toHaveBeenCalledTimes(2));
    expect(vi.mocked(dataLayer.uninstall).mock.calls.map(([skill]) => skill.rawId)).toEqual([
      "builder-radar",
      "finance-news",
    ]);
    await waitFor(() => expect(dataLayer.listInstalled).toHaveBeenCalledTimes(2));
    expect(batchButton).toBeDisabled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("批量卸载成功，共 2 个");
  });

  it("keeps failed installed rows selected after a partial batch uninstall", async () => {
    const dataLayer = renderPanel(mode, "installed");
    await screen.findByText("Finance News");
    vi.mocked(dataLayer.uninstall).mockImplementation(async (skill) => (
      skill.rawId === "finance-news"
        ? { ok: false, message: "still in use" }
        : { ok: true }
    ));

    fireEvent.click(screen.getByRole("button", { name: "选择批量卸载 Builder Radar" }));
    fireEvent.click(screen.getByRole("button", { name: "选择批量卸载 Finance News" }));
    fireEvent.click(screen.getByRole("button", { name: "批量卸载" }));
    fireEvent.click(screen.getByRole("button", { name: "确认批量卸载 2 个技能" }));

    await waitFor(() => expect(dataLayer.uninstall).toHaveBeenCalledTimes(2));
    const batchButton = screen.getByRole("button", { name: "批量卸载" });
    expect(batchButton).toBeEnabled();
    expect(batchButton).toHaveTextContent("(1)");
    expect(screen.getByRole("button", { name: "取消批量卸载 Finance News" })).toHaveAttribute("aria-pressed", "true");
    expect(mocks.toastError).toHaveBeenCalledWith("批量卸载完成：成功 1 个，失败 1 个");
  });

  it("does not render skill icons or icon links in Installed rows", async () => {
    renderPanel(mode, "installed");
    await screen.findByText("Finance News");

    const registryItem = screen.getByText("Builder Radar").closest("li") as HTMLElement;
    const nativeItem = screen.getByText("Finance News").closest("li") as HTMLElement;
    expect(registryItem.querySelector("img")).toBeNull();
    expect(nativeItem.querySelector("img")).toBeNull();
    expect(registryItem.querySelector("a")).toBeNull();
    expect(nativeItem.querySelector("a")).toBeNull();
  });

  it("enables batch install after selecting search results and installs every selected skill", async () => {
    const dataLayer = renderPanel(mode);
    const batchButton = screen.getByRole("button", { name: "批量安装" });
    expect(batchButton).toBeDisabled();
    expect(batchButton).toHaveClass("h-10", "w-32", "rounded-[12px]");
    expect(screen.getByRole("combobox", { name: "来源" })).toHaveClass("!justify-center");
    expect(screen.getByPlaceholderText(
      mode === "domestic" ? "搜索 SkillHub 中的技能" : "搜索 Skills.sh / Clawhub 中的技能",
    )).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/搜索 .*技能/), { target: { value: "tools" } });
    const firstSelector = await screen.findByRole("button", { name: "选择批量安装 First" }, { timeout: 3_000 });
    const secondSelector = screen.getByRole("button", { name: "选择批量安装 Second" });
    fireEvent.click(firstSelector);
    fireEvent.click(secondSelector);

    expect(batchButton).toBeEnabled();
    expect(batchButton).toHaveClass("w-32", "rounded-[12px]");
    fireEvent.click(batchButton);

    await waitFor(() => expect(dataLayer.install).toHaveBeenCalledTimes(2));
    expect(vi.mocked(dataLayer.install).mock.calls.map(([skill]) => skill.rawId)).toEqual(["first", "second"]);
    expect(batchButton).toBeDisabled();
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

  it("renders the expand and collapse control as a button below the searched skills", async () => {
    renderPanel(mode);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索技能" }), { target: { value: "tools" } });

    const firstResult = await screen.findByText("First");
    const resultsList = firstResult.closest("ul");
    const expandButton = screen.getByRole("button", { name: "查看全部" });
    expect(resultsList?.nextElementSibling).toContainElement(expandButton);
    expect(expandButton).toHaveClass("rounded-md", "border");

    fireEvent.click(expandButton);
    const collapseButton = screen.getByRole("button", { name: "收起全部" });
    expect(screen.getByText("Skill 13")).toBeInTheDocument();
    expect(resultsList?.nextElementSibling).toContainElement(collapseButton);
  });

  it("selects Featured and category skills for one shared batch install", async () => {
    const dataLayer = renderPanel(mode);
    const batchButton = screen.getByRole("button", { name: "批量安装" });
    const featuredSection = screen.getByText("精选").closest("section") as HTMLElement;
    const categorySection = screen
      .getByText(mode === "domestic" ? "理财分析" : "市场分析")
      .closest("section") as HTMLElement;
    const featuredSelector = within(featuredSection).getAllByRole("button", { name: /选择批量安装/ })[0];
    const categorySelector = within(categorySection).getAllByRole("button", { name: /选择批量安装/ })[0];

    expect(featuredSelector).toBeDefined();
    expect(categorySelector).toBeDefined();
    fireEvent.click(featuredSelector as HTMLElement);
    fireEvent.click(categorySelector as HTMLElement);
    expect(batchButton).toBeEnabled();
    expect(batchButton).toHaveTextContent("(2)");

    fireEvent.click(batchButton);
    await waitFor(() => expect(dataLayer.install).toHaveBeenCalledTimes(2));
    expect(batchButton).toBeDisabled();
  });

  it("shows linked skill sources at the right edge of the Skills tab rule", () => {
    renderPanel(mode);
    const tabs = screen.getByRole("tablist", { name: "技能市场页面切换" });
    const tabRule = tabs.parentElement as HTMLElement;
    const sourceLine = tabs.nextElementSibling as HTMLElement;

    expect(tabRule).toHaveClass("border-b", "items-end");
    expect(tabs).not.toHaveClass("!border-b");
    expect(sourceLine).toHaveClass("ml-auto", "pb-2", "text-right");
    expect(sourceLine).toHaveTextContent(mode === "domestic"
      ? "技能来源于 SkillHub"
      : "技能来源于 Skills.sh 与 ClawHub");
    expect(sourceLine).not.toHaveClass("border");
    if (mode === "domestic") {
      expect(within(sourceLine).getByRole("link", { name: "SkillHub" })).toHaveAttribute("href", "https://skillhub.cn");
    } else {
      expect(within(sourceLine).getByRole("link", { name: "Skills.sh" })).toHaveAttribute("href", "https://skills.sh");
      expect(within(sourceLine).getByRole("link", { name: "ClawHub" })).toHaveAttribute("href", "https://clawhub.ai/");
    }
  });
});
