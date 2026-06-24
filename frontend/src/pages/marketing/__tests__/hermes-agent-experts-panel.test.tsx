import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadExpertPackagesState, saveExpertPackagesState } from "@/lib/expert-package-storage";
import { fetchSkillFile, fetchSkillDetail, fetchSkillFiles, fetchSkillSetDetail, fetchSkillSets } from "@/lib/skillhub-api";

import {
  buildInstalledSkillsListCommand,
  buildInstallSkillCommand,
  buildSkillHubSelfUpgradeCommand,
  ExpertsPanel,
  formatInstallFailureOutput,
  getSkillHubErrorMessage,
  getPackageSkillSlugs,
  getSkillPackageInstallFailureMessage,
  getSkillPackageTags,
  isSkillInstallAlreadyExists,
  getUniqueSkillSlugs,
  installSkillSlugs,
  parseInstalledSkillSlugs,
  stripMarkdownFrontmatter,
} from "../hermes-agent-experts-panel";

vi.mock("@/lib/skillhub-api", () => ({
  fetchSkillFile: vi.fn(),
  fetchSkillDetail: vi.fn(),
  fetchSkillFiles: vi.fn(),
  fetchSkillSets: vi.fn(),
  fetchSkillSetDetail: vi.fn(),
}));

vi.mock("@/lib/expert-package-storage", () => ({
  loadExpertPackagesState: vi.fn(),
  saveExpertPackagesState: vi.fn(),
}));

describe("hermes agent experts panel", () => {
  beforeEach(() => {
    vi.mocked(loadExpertPackagesState).mockResolvedValue(null);
    vi.mocked(saveExpertPackagesState).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    window.localStorage.clear();
  });

  it("deduplicates skill slugs while preserving order", () => {
    expect(getUniqueSkillSlugs([" finance-news ", "market", "finance-news", "", "market"])).toEqual([
      "finance-news",
      "market",
    ]);
  });

  it("normalizes code-review package skill slugs to the SkillHub package content", () => {
    expect(getPackageSkillSlugs("tech-code-review", [
      "pr-reviewer",
      "cody",
      "code-review-assistant",
      "cody",
    ])).toEqual(["pr-reviewer", "code-review-assistant"]);
  });

  it("builds a single-skill acli install command", () => {
    expect(buildInstallSkillCommand("report's-helper")).toBe("env SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE='https://api.skillhub.cn/api/v1/download?slug={slug}' acli skills install 'report'\\''s-helper'");
  });

  it("parses installed skill slugs from acli json and Hermes table output", () => {
    expect(parseInstalledSkillSlugs(JSON.stringify({
      success: true,
      data: { skills: [{ name: "market-data" }, { slug: "backtest-engine" }] },
    }))).toEqual(["market-data", "backtest-engine"]);

    expect(parseInstalledSkillSlugs("│ Name │ Category │ Source │ Trust │ Status │\n│ cody │ dev │ local │ yes │ installed │")).toEqual([
      "cody",
    ]);
  });

  it("builds compact card tags from the package name and skill count", () => {
    expect(getSkillPackageTags({ displayName: " 量化回测 ", skillCount: 6 })).toEqual(["量化回测", "6 个技能"]);
  });

  it("strips yaml frontmatter before rendering package markdown", () => {
    expect(stripMarkdownFrontmatter("---\nscene: \"tech\"\nskills:\n  - \"pr-reviewer\"\n---\n\n# 代码审查工作流")).toBe(
      "# 代码审查工作流",
    );
  });

  it("localizes browser fetch failures from SkillHub", () => {
    expect(getSkillHubErrorMessage(new Error("Failed to fetch"), (value: string) => value)).toBe("无法连接 SkillHub，请稍后重试");
  });

  it("formats package install failures with failed skill slugs and command output", () => {
    const t = (value: string, options?: Record<string, unknown>) => {
      if (!options) return value;
      return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(options[name]));
    };

    expect(getSkillPackageInstallFailureMessage({
      succeeded: ["market-data"],
      failed: [{ slug: "backtest-engine", output: "line1\nline2\nline3\nline4" }],
    }, t)).toBe("技能包安装：成功 1 项，失败 1 项。失败：backtest-engine；错误：line2；line3；line4");
  });

  it("treats existing skill targets as already installed and compacts json install errors", () => {
    expect(isSkillInstallAlreadyExists("Target exists: /home/agentuser/.agents/skills/pr-reviewer (use --force to overwrite)")).toBe(true);
    expect(formatInstallFailureOutput(JSON.stringify({
      error: "Target exists: /home/agentuser/.agents/skills/pr-reviewer (use --force to overwrite)",
      success: false,
    }))).toBe("Target exists: /home/agentuser/.agents/skills/pr-reviewer (use --force to overwrite)");
  });

  it("compacts nested SkillHub CLI json install errors", () => {
    expect(formatInstallFailureOutput(JSON.stringify({
      error: JSON.stringify({
        code: "INSTALL_FAILED",
        message: `[skillhub] 发现新版本 2026.6.23（当前 2026.6.18）。运行 \`skillhub self-upgrade\` 进行升级。; ${JSON.stringify({
          success: false,
          slug: "tdd-guide",
          error: "Download failed: HTTP 404 for https://api.skillhub.cn/api/v1/download?slug=tdd-guide",
        })}`,
      }),
      success: false,
    }))).toBe("Download failed: HTTP 404 for https://api.skillhub.cn/api/v1/download?slug=tdd-guide");
  });

  it("compacts object-shaped SkillHub CLI install errors", () => {
    expect(formatInstallFailureOutput(JSON.stringify({
      error: {
        code: "INSTALL_FAILED",
        message: "Download failed: HTTP 404 for https://api.skillhub.cn/api/v1/download?slug=tdd-guide",
      },
      success: false,
    }))).toBe("Download failed: HTTP 404 for https://api.skillhub.cn/api/v1/download?slug=tdd-guide");
  });

  it("opens expert detail with skill module content when a card is clicked", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "finance"
        ? [{
            id: 1,
            slug: "quant-backtest",
            displayName: "量化回测",
            summary: "列表摘要",
            remark: "",
            scene: "finance",
            skillCount: 2,
            createdAt: 0,
            updatedAt: 0,
          }]
        : [],
    }));
    vi.mocked(fetchSkillSetDetail).mockResolvedValue({
      id: 1,
      slug: "quant-backtest",
      displayName: "量化回测",
      summary: "详情摘要",
      remark: "",
      skillCount: 2,
      skillSlugs: ["market-data"],
      createdAt: 0,
      updatedAt: 0,
    });
    vi.mocked(fetchSkillFiles).mockResolvedValue([{ path: "SKILL.md", size: 1, sha256: "abc" }]);
    vi.mocked(fetchSkillFile).mockResolvedValue("# Market Data\n\n完整技能详情");
    vi.mocked(fetchSkillDetail).mockResolvedValue({
      slug: "market-data",
      displayName: "Backend Market Data",
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /量化回测/ }));

    await waitFor(() => {
      expect(fetchSkillSetDetail).toHaveBeenCalledWith("quant-backtest");
    });
    expect(await screen.findByText("完整技能详情")).toBeInTheDocument();
    expect(await screen.findByText("Backend Market Data")).toBeInTheDocument();
  });

  it("renders the SkillHub expert profile image on package cards", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "finance"
        ? [{
            id: 1,
            slug: "finance-quant-backtesting",
            displayName: "量化回测",
            summary: "列表摘要",
            remark: "",
            scene: "finance",
            skillCount: 2,
            skillSlugs: ["market-data", "backtest-engine"],
            createdAt: 0,
            updatedAt: 0,
          }]
        : [],
    }));

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    expect(await screen.findByTestId("skill-package-profile-icon")).toBeInTheDocument();
    expect(screen.getByTestId("skill-package-profile-image")).toHaveAttribute(
      "src",
      "https://cloudcache.tencent-cloud.com/qcloud/tea/app/skillhub/assets/source/ai-buddy-decouple/expert-profiles/finance-quant-backtesting.v20260616.png",
    );
  });

  it("falls back to an initial when the expert profile image fails", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene
        ? [{
            id: 1,
            slug: "finance-missing-icon",
            displayName: "缺图技能包",
            summary: "列表摘要",
            remark: "",
            scene: "finance",
            skillCount: 3,
            createdAt: 0,
            updatedAt: 0,
          }]
        : [],
    }));

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    fireEvent.error(await screen.findByTestId("skill-package-profile-image"));

    expect(await screen.findByTestId("skill-package-profile-fallback")).toHaveTextContent("缺");
  });

  it("switches between list and card views", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "finance"
        ? [{
            id: 1,
            slug: "quant-backtest",
            displayName: "量化回测",
            summary: "列表摘要",
            remark: "",
            scene: "finance",
            skillCount: 2,
            createdAt: 0,
            updatedAt: 0,
          }]
        : [],
    }));

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /量化回测/ })).toBeInTheDocument();
    const cardViewButton = screen.getByRole("button", { name: "卡片" });
    const listViewButton = screen.getByRole("button", { name: "列表" });
    expect(cardViewButton).toHaveAttribute("data-tooltip", "卡片");
    expect(cardViewButton).toHaveTextContent("");
    expect(screen.getByRole("tooltip", { name: "卡片" })).toBeInTheDocument();
    expect(listViewButton).toHaveAttribute("data-tooltip", "列表");
    expect(listViewButton).toHaveTextContent("");
    expect(screen.getByRole("tooltip", { name: "列表" })).toBeInTheDocument();

    fireEvent.click(cardViewButton);
    expect(cardViewButton).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(listViewButton);
    expect(listViewButton).toHaveAttribute("aria-pressed", "true");
  });

  it("uses the parent skills tab as the package title instead of rendering a duplicate package heading", async () => {
    vi.mocked(fetchSkillSets).mockResolvedValue({
      skillSets: [],
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    expect(await screen.findByText("快速安装技能组合，让 Agent 从单点技能走向完整工作流")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索技能包")).toHaveClass("lv-agent-search-box-input");
    expect(screen.queryByRole("heading", { name: "技能包" })).not.toBeInTheDocument();
  });

  it("keeps the package intro visible while the catalog is loading", async () => {
    let resolveSkillSets: (value: Awaited<ReturnType<typeof fetchSkillSets>>) => void = () => {};
    vi.mocked(fetchSkillSets).mockReturnValue(new Promise((resolve) => {
      resolveSkillSets = resolve;
    }));

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    expect(screen.getByText("快速安装技能组合，让 Agent 从单点技能走向完整工作流")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索技能包")).toBeInTheDocument();
    expect(screen.getByText("正在加载技能包")).toBeInTheDocument();

    resolveSkillSets({ skillSets: [] });
    await waitFor(() => expect(screen.queryByText("正在加载技能包")).not.toBeInTheDocument());
  });

  it("loads the SkillHub scene expert catalog and hides scene-less generic packages", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async () => ({
      total: 3,
      skillSets: [{
            id: 1,
            slug: "test-automation",
            displayName: "自动化测试",
            summary: "第一页摘要",
            remark: "",
            scene: "tech",
            skillCount: 1,
            createdAt: 0,
            updatedAt: 0,
          }, {
            id: 2,
            slug: "analyst",
            displayName: "分析师",
            summary: "无分类摘要",
            remark: "",
            skillCount: 1,
            createdAt: 0,
            updatedAt: 0,
          }, {
            id: 3,
            slug: "finance-quant-backtesting",
            displayName: "量化回测",
            summary: "金融摘要",
            remark: "",
            scene: "finance",
            skillCount: 1,
            createdAt: 0,
            updatedAt: 0,
          }],
    }));

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /自动化测试/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /量化回测/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /分析师/ })).not.toBeInTheDocument();
    expect(fetchSkillSets).toHaveBeenCalledWith({
      keyword: "",
      scene: undefined,
      page: 1,
      pageSize: 60,
    });
  });

  it("installs package skills one by one without opening detail", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "finance"
        ? [{
            id: 1,
            slug: "quant-backtest",
            displayName: "量化回测",
            summary: "列表摘要",
            remark: "",
            scene: "finance",
            skillCount: 2,
            createdAt: 0,
            updatedAt: 0,
          }]
        : [],
    }));
    vi.mocked(fetchSkillSetDetail).mockResolvedValue({
      id: 1,
      slug: "quant-backtest",
      displayName: "量化回测",
      summary: "详情摘要",
      remark: "",
      skillCount: 2,
      skillSlugs: ["market-data", "backtest-engine"],
      createdAt: 0,
      updatedAt: 0,
    });
    const execDebugCommand = vi.fn().mockImplementation(async (_botId: string, command: string) => {
      if (command === buildInstalledSkillsListCommand()) {
        return { status: "success", exitCode: 0, output: "" };
      }
      return { status: "success", exitCode: 0, output: "" };
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={execDebugCommand} />);

    fireEvent.click(await screen.findByRole("button", { name: "安装" }));

    await waitFor(() => {
      expect(execDebugCommand).toHaveBeenCalledWith("bot-1", "env SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE='https://api.skillhub.cn/api/v1/download?slug={slug}' acli skills install 'backtest-engine'");
    });
    const installCommands = execDebugCommand.mock.calls.map((call) => call[1]).filter((command) => command.startsWith("env SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE='https://api.skillhub.cn/api/v1/download?slug={slug}' acli skills install"));
    expect(installCommands).toEqual(["env SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE='https://api.skillhub.cn/api/v1/download?slug={slug}' acli skills install 'market-data'", "env SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE='https://api.skillhub.cn/api/v1/download?slug={slug}' acli skills install 'backtest-engine'"]);
    expect(saveExpertPackagesState).toHaveBeenCalledWith("bot-1", {
      installedPackageSlugs: ["quant-backtest"],
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the package installed when SkillHub output reports success even if debug status is not normalized", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "legal"
        ? [{
            id: 1,
            slug: "legal-contract-drafting",
            displayName: "合同起草",
            summary: "列表摘要",
            remark: "",
            scene: "legal",
            skillCount: 1,
            createdAt: 0,
            updatedAt: 0,
          }]
        : [],
    }));
    vi.mocked(fetchSkillSetDetail).mockResolvedValue({
      id: 1,
      slug: "legal-contract-drafting",
      displayName: "合同起草",
      summary: "详情摘要",
      remark: "",
      skillCount: 1,
      skillSlugs: ["contract-drafting"],
      createdAt: 0,
      updatedAt: 0,
    });
    const execDebugCommand = vi.fn().mockImplementation(async (_botId: string, command: string) => {
      if (command === buildInstalledSkillsListCommand()) {
        return { status: "success", exitCode: 0, output: "" };
      }
      return {
        status: "",
        exitCode: -1,
        output: JSON.stringify({ success: true, slug: "contract-drafting" }),
      };
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={execDebugCommand} />);

    fireEvent.click(await screen.findByRole("button", { name: "安装" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "已安装" })).toBeDisabled();
    });
    expect(saveExpertPackagesState).toHaveBeenCalledWith("bot-1", {
      installedPackageSlugs: ["legal-contract-drafting"],
    });
  });

  it("shows per-skill package install progress on the install button", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "finance"
        ? [{
            id: 1,
            slug: "quant-backtest",
            displayName: "量化回测",
            summary: "列表摘要",
            remark: "",
            scene: "finance",
            skillCount: 2,
            createdAt: 0,
            updatedAt: 0,
          }]
        : [],
    }));
    vi.mocked(fetchSkillSetDetail).mockResolvedValue({
      id: 1,
      slug: "quant-backtest",
      displayName: "量化回测",
      summary: "详情摘要",
      remark: "",
      skillCount: 2,
      skillSlugs: ["market-data", "backtest-engine"],
      createdAt: 0,
      updatedAt: 0,
    });
    let resolveFirstInstall: ((result: { status: string; exitCode: number; output: string }) => void) | undefined;
    const firstInstall = new Promise<{ status: string; exitCode: number; output: string }>((resolve) => {
      resolveFirstInstall = resolve;
    });
    const execDebugCommand = vi.fn().mockImplementation(async (_botId: string, command: string) => {
      if (command === buildInstalledSkillsListCommand()) {
        return { status: "success", exitCode: 0, output: "" };
      }
      if (command === buildInstallSkillCommand("market-data")) {
        return firstInstall;
      }
      return { status: "success", exitCode: 0, output: "" };
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={execDebugCommand} />);

    fireEvent.click(await screen.findByRole("button", { name: "安装" }));

    expect(await screen.findByRole("button", { name: "安装中 1/2" })).toBeDisabled();
    resolveFirstInstall?.({ status: "success", exitCode: 0, output: "" });
    await waitFor(() => {
      expect(execDebugCommand).toHaveBeenCalledWith("bot-1", buildInstallSkillCommand("backtest-engine"));
    });
  });

  it("retries failed package skills once", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "finance"
        ? [{
            id: 1,
            slug: "quant-backtest",
            displayName: "量化回测",
            summary: "列表摘要",
            remark: "",
            scene: "finance",
            skillCount: 2,
            createdAt: 0,
            updatedAt: 0,
          }]
        : [],
    }));
    vi.mocked(fetchSkillSetDetail).mockResolvedValue({
      id: 1,
      slug: "quant-backtest",
      displayName: "量化回测",
      summary: "详情摘要",
      remark: "",
      skillCount: 2,
      skillSlugs: ["market-data", "backtest-engine"],
      createdAt: 0,
      updatedAt: 0,
    });
    const installResults = [
      { status: "success", exitCode: 0, output: "" },
      { status: "failed", exitCode: 1, output: "" },
      { status: "success", exitCode: 0, output: "" },
    ];
    const execDebugCommand = vi.fn().mockImplementation(async (_botId: string, command: string) => {
      if (command === buildInstalledSkillsListCommand()) {
        return { status: "success", exitCode: 0, output: "" };
      }
      return installResults.shift() ?? { status: "success", exitCode: 0, output: "" };
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={execDebugCommand} />);

    fireEvent.click(await screen.findByRole("button", { name: "安装" }));

    await waitFor(() => {
      expect(execDebugCommand).toHaveBeenCalledWith("bot-1", "env SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE='https://api.skillhub.cn/api/v1/download?slug={slug}' acli skills install 'backtest-engine'");
    });
    const installCommands = execDebugCommand.mock.calls.map((call) => call[1]).filter((command) => command.startsWith("env SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE='https://api.skillhub.cn/api/v1/download?slug={slug}' acli skills install"));
    expect(installCommands).toEqual([
      "env SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE='https://api.skillhub.cn/api/v1/download?slug={slug}' acli skills install 'market-data'",
      "env SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE='https://api.skillhub.cn/api/v1/download?slug={slug}' acli skills install 'backtest-engine'",
      "env SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE='https://api.skillhub.cn/api/v1/download?slug={slug}' acli skills install 'backtest-engine'",
    ]);
  });

  it("backs off before retrying rate-limited package skill downloads", async () => {
    vi.useFakeTimers();
    try {
      const installResults = [
        {
          status: "failed",
          exitCode: 1,
          output: "Download failed: HTTP 429 (rate limited) for https://api.skillhub.cn/api/v1/download?slug=nexus-error-explain",
        },
        { status: "success", exitCode: 0, output: "" },
      ];
      const execDebugCommand = vi.fn().mockImplementation(async () => (
        installResults.shift() ?? { status: "success", exitCode: 0, output: "" }
      ));

      const installPromise = installSkillSlugs("bot-1", ["nexus-error-explain"], execDebugCommand);

      expect(execDebugCommand).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(execDebugCommand).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(installPromise).resolves.toEqual({
        succeeded: ["nexus-error-explain"],
        failed: [],
      });
      expect(execDebugCommand).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps backing off when package skill downloads hit repeated rate limits", async () => {
    vi.useFakeTimers();
    try {
      const installResults = [
        {
          status: "failed",
          exitCode: 1,
          output: "Download failed: HTTP 429 for https://api.skillhub.cn/api/v1/download?slug=nexus-error-explain",
        },
        {
          status: "failed",
          exitCode: 1,
          output: "Download failed: Too Many Requests for https://api.skillhub.cn/api/v1/download?slug=nexus-error-explain",
        },
        { status: "success", exitCode: 0, output: "" },
      ];
      const execDebugCommand = vi.fn().mockImplementation(async () => (
        installResults.shift() ?? { status: "success", exitCode: 0, output: "" }
      ));

      const installPromise = installSkillSlugs("bot-1", ["nexus-error-explain"], execDebugCommand);

      expect(execDebugCommand).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(execDebugCommand).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(execDebugCommand).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await expect(installPromise).resolves.toEqual({
        succeeded: ["nexus-error-explain"],
        failed: [],
      });
      expect(execDebugCommand).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failed package skill after exhausting rate-limit retries", async () => {
    vi.useFakeTimers();
    try {
      const installResults = [
        {
          status: "failed",
          exitCode: 1,
          output: "Download failed: HTTP 429 for https://api.skillhub.cn/api/v1/download?slug=nexus-error-explain",
        },
        {
          status: "failed",
          exitCode: 1,
          output: "Download failed: HTTP 429 for https://api.skillhub.cn/api/v1/download?slug=nexus-error-explain",
        },
        {
          status: "failed",
          exitCode: 1,
          output: "Download failed: HTTP 429 for https://api.skillhub.cn/api/v1/download?slug=nexus-error-explain",
        },
      ];
      const execDebugCommand = vi.fn().mockImplementation(async () => (
        installResults.shift() ?? { status: "success", exitCode: 0, output: "" }
      ));

      const installPromise = installSkillSlugs("bot-1", ["nexus-error-explain"], execDebugCommand);

      await vi.advanceTimersByTimeAsync(7_000);
      await expect(installPromise).resolves.toEqual({
        succeeded: [],
        failed: [{
          slug: "nexus-error-explain",
          output: "Download failed: HTTP 429 for https://api.skillhub.cn/api/v1/download?slug=nexus-error-explain",
        }],
      });
      expect(execDebugCommand).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("self-upgrades SkillHub CLI once when install output asks for it", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "tech"
        ? [{
            id: 1,
            slug: "tech-test-automation",
            displayName: "自动化测试",
            summary: "列表摘要",
            remark: "",
            scene: "tech",
            skillCount: 1,
            createdAt: 0,
            updatedAt: 0,
          }]
        : [],
    }));
    vi.mocked(fetchSkillSetDetail).mockResolvedValue({
      id: 1,
      slug: "tech-test-automation",
      displayName: "自动化测试",
      summary: "详情摘要",
      remark: "",
      skillCount: 1,
      skillSlugs: ["tdd-guide"],
      createdAt: 0,
      updatedAt: 0,
    });
    const execDebugCommand = vi.fn().mockImplementation(async (_botId: string, command: string) => {
      if (command === buildInstalledSkillsListCommand()) {
        return { status: "success", exitCode: 0, output: "" };
      }
      if (command === buildSkillHubSelfUpgradeCommand()) {
        return { status: "success", exitCode: 0, output: "upgraded" };
      }
      if (command === buildInstallSkillCommand("tdd-guide") && execDebugCommand.mock.calls
        .filter((call) => call[1] === buildInstallSkillCommand("tdd-guide")).length === 1) {
        return {
          status: "failed",
          exitCode: 1,
          output: "[skillhub] 发现新版本 2026.6.23（当前 2026.6.18）。运行 `skillhub self-upgrade` 进行升级。",
        };
      }
      return { status: "success", exitCode: 0, output: "" };
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={execDebugCommand} />);

    fireEvent.click(await screen.findByRole("button", { name: "安装" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "已安装" })).toBeDisabled();
    });
    expect(saveExpertPackagesState).toHaveBeenCalledWith("bot-1", {
      installedPackageSlugs: ["tech-test-automation"],
    });
    expect(execDebugCommand).toHaveBeenCalledWith("bot-1", buildSkillHubSelfUpgradeCommand());
    expect(execDebugCommand.mock.calls.map((call) => call[1])).toEqual([
      buildInstalledSkillsListCommand(),
      buildInstallSkillCommand("tdd-guide"),
      buildSkillHubSelfUpgradeCommand(),
      buildInstallSkillCommand("tdd-guide"),
    ]);
  });

  it("shows failed skill slugs when package installation still fails after retry", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "finance"
        ? [{
            id: 1,
            slug: "quant-backtest",
            displayName: "量化回测",
            summary: "列表摘要",
            remark: "",
            scene: "finance",
            skillCount: 2,
            createdAt: 0,
            updatedAt: 0,
          }]
        : [],
    }));
    vi.mocked(fetchSkillSetDetail).mockResolvedValue({
      id: 1,
      slug: "quant-backtest",
      displayName: "量化回测",
      summary: "详情摘要",
      remark: "",
      skillCount: 2,
      skillSlugs: ["market-data", "backtest-engine"],
      createdAt: 0,
      updatedAt: 0,
    });
    const installResults = [
      { status: "success", exitCode: 0, output: "" },
      { status: "failed", exitCode: 1, output: "preflight failed\nmissing dependency" },
      { status: "failed", exitCode: 1, output: "install failed\nmissing dependency" },
    ];
    const execDebugCommand = vi.fn().mockImplementation(async (_botId: string, command: string) => {
      if (command === buildInstalledSkillsListCommand()) {
        return { status: "success", exitCode: 0, output: "" };
      }
      return installResults.shift() ?? { status: "success", exitCode: 0, output: "" };
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={execDebugCommand} />);

    fireEvent.click(await screen.findByRole("button", { name: "安装" }));

    expect(await screen.findByText(/失败：backtest-engine/)).toHaveTextContent("missing dependency");
  });

  it("counts existing skill target install output as package install success", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "finance"
        ? [{
            id: 1,
            slug: "quant-backtest",
            displayName: "量化回测",
            summary: "列表摘要",
            remark: "",
            scene: "finance",
            skillCount: 1,
            createdAt: 0,
            updatedAt: 0,
          }]
        : [],
    }));
    vi.mocked(fetchSkillSetDetail).mockResolvedValue({
      id: 1,
      slug: "quant-backtest",
      displayName: "量化回测",
      summary: "详情摘要",
      remark: "",
      skillCount: 1,
      skillSlugs: ["market-data"],
      createdAt: 0,
      updatedAt: 0,
    });
    const execDebugCommand = vi.fn().mockImplementation(async (_botId: string, command: string) => {
      if (command === buildInstalledSkillsListCommand()) {
        return { status: "success", exitCode: 0, output: "" };
      }
      return {
        status: "failed",
        exitCode: 1,
        output: JSON.stringify({
          error: "Target exists: /home/agentuser/.agents/skills/market-data (use --force to overwrite)",
          success: false,
        }),
      };
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={execDebugCommand} />);

    fireEvent.click(await screen.findByRole("button", { name: "安装" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "已安装" })).toBeDisabled();
    });
    expect(screen.queryByText(/失败：market-data/)).not.toBeInTheDocument();
  });

  it("restores installed package state after a page refresh", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "tech"
        ? [{
            id: 1,
            slug: "tech-code-review",
            displayName: "代码审查",
            summary: "列表摘要",
            remark: "",
            scene: "tech",
            skillCount: 1,
            createdAt: 0,
            updatedAt: 0,
          }]
        : [],
    }));
    vi.mocked(fetchSkillSetDetail).mockResolvedValue({
      id: 1,
      slug: "tech-code-review",
      displayName: "代码审查",
      summary: "详情摘要",
      remark: "",
      skillCount: 1,
      skillSlugs: ["code-review-assistant"],
      createdAt: 0,
      updatedAt: 0,
    });
    const execDebugCommand = vi.fn().mockImplementation(async (_botId: string, command: string) => {
      if (command === buildInstalledSkillsListCommand()) {
        return { status: "success", exitCode: 0, output: "" };
      }
      return { status: "success", exitCode: 0, output: "" };
    });

    const firstRender = render(<ExpertsPanel botId="bot-1" execDebugCommand={execDebugCommand} />);

    fireEvent.click(await screen.findByRole("button", { name: "安装" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "已安装" })).toBeDisabled();
    });

    firstRender.unmount();
    render(<ExpertsPanel botId="bot-1" execDebugCommand={execDebugCommand} />);

    expect(await screen.findByRole("button", { name: "已安装" })).toBeDisabled();
  });

  it("restores installed package state from Vibebase like applied Soul state", async () => {
    vi.mocked(loadExpertPackagesState).mockResolvedValue({
      installedPackageSlugs: ["tech-code-review"],
    });
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "tech"
        ? [{
            id: 1,
            slug: "tech-code-review",
            displayName: "代码审查",
            summary: "列表摘要",
            remark: "",
            scene: "tech",
            skillCount: 1,
            createdAt: 0,
            updatedAt: 0,
          }]
        : [],
    }));
    const execDebugCommand = vi.fn().mockImplementation(async (_botId: string, command: string) => {
      if (command === buildInstalledSkillsListCommand()) {
        return { status: "success", exitCode: 0, output: "" };
      }
      return { status: "success", exitCode: 0, output: "" };
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={execDebugCommand} />);

    expect(await screen.findByRole("button", { name: "已安装" })).toBeDisabled();
    expect(loadExpertPackagesState).toHaveBeenCalledWith("bot-1");
  });

  it("marks a package as installed when all package skills are already installed", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "finance"
        ? [{
            id: 1,
            slug: "quant-backtest",
            displayName: "量化回测",
            summary: "列表摘要",
            remark: "",
            scene: "finance",
            skillCount: 2,
            createdAt: 0,
            updatedAt: 0,
          }]
        : [],
    }));
    vi.mocked(fetchSkillSetDetail).mockResolvedValue({
      id: 1,
      slug: "quant-backtest",
      displayName: "量化回测",
      summary: "详情摘要",
      remark: "",
      skillCount: 2,
      skillSlugs: ["market-data", "backtest-engine"],
      createdAt: 0,
      updatedAt: 0,
    });
    const execDebugCommand = vi.fn().mockResolvedValue({
      status: "success",
      exitCode: 0,
      output: JSON.stringify({ success: true, data: { skills: [{ name: "market-data" }, { name: "backtest-engine" }] } }),
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={execDebugCommand} />);

    const installedButton = await screen.findByRole("button", { name: "已安装" });
    expect(installedButton).toBeDisabled();
    expect(execDebugCommand).toHaveBeenCalledWith("bot-1", buildInstalledSkillsListCommand());
  });
});
