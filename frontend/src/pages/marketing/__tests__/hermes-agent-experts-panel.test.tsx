import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadExpertPackagesState, saveExpertPackagesState } from "@/lib/expert-package-storage";
import {
  buildInstalledSkillsListCommand,
  getUniqueSkillSlugs,
  parseInstalledSkillSlugs,
} from "@/lib/hermes-skills-client";
import { fetchSkillFile, fetchSkillDetail, fetchSkillFiles, fetchSkillSetDetail, fetchSkillSets } from "@/lib/skillhub-api";

import {
  buildInstallSkillCommand,
  buildSkillHubSelfUpgradeCommand,
  ExpertsPanel,
  formatInstallFailureOutput,
  getSkillHubErrorMessage,
  getPackageSkillSlugs,
  getSkillPackageInstallFailureMessage,
  getEnglishPackageFrontmatterValue,
  getExpertSkillDocumentPath,
  isSkillInstallAlreadyExists,
  installSkillSlugs,
  resolveAvailablePackageSkillSlugs,
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

  it("filters missing package skill slugs before display or install", () => {
    expect(getPackageSkillSlugs("tech-test-automation", [
      "tdd-guide",
      "test-case-generator",
    ], ["tdd-guide"])).toEqual(["test-case-generator"]);
  });

  it("filters package skill slugs whose SkillHub detail is missing", async () => {
    vi.mocked(fetchSkillDetail).mockImplementation(async (slug) => {
      if (slug === "tdd-guide") throw new Error("Skill not found");
      return { slug, displayName: slug };
    });

    await expect(resolveAvailablePackageSkillSlugs("tech-test-automation", [
      "tdd-guide",
      "test-case-generator",
    ])).resolves.toEqual(["test-case-generator"]);
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
    const sourceLink = await screen.findByRole("link", { name: "源自 SkillHub" });
    expect(sourceLink).toHaveAttribute("href", "https://skillhub.cn/skillspackage");
    expect(sourceLink).toHaveAttribute("target", "_blank");
  });

  it("selects the locale-specific expert skill document before legacy fallbacks", () => {
    const files = [
      "README.md",
      "identify.md",
      "identify_en.md",
      "SKILL.md",
    ];
    expect(getExpertSkillDocumentPath(files, "en")).toBe("identify_en.md");
    expect(getExpertSkillDocumentPath(files, "zh")).toBe("identify.md");
    expect(getExpertSkillDocumentPath(["README.md"], "en")).toBe("README.md");
  });

  it("parses folded English package descriptions from frontmatter", () => {
    expect(getEnglishPackageFrontmatterValue(`---
description: >-
  English package description that
  continues on the next line.
metadata:
  locale: en-US
---
# Package`, "description")).toBe(
      "English package description that continues on the next line.",
    );
  });

  it("shows detail skill count from filtered available package skills", async () => {
    const detailSkillSlugs = [
      "tdd-guide",
      "test-case-generator",
      "test-patterns",
      "e2e-test-orchestrator",
      "api-test-automation",
      "afrexai-qa-test-plan",
    ];
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "tech"
        ? [{
            id: 1,
            slug: "tech-test-automation",
            displayName: "自动化测试",
            summary: "列表摘要",
            remark: "",
            scene: "tech",
            skillCount: 2,
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
      skillCount: 6,
      skillSlugs: detailSkillSlugs,
      createdAt: 0,
      updatedAt: 0,
    });
    vi.mocked(fetchSkillDetail).mockImplementation(async (slug) => {
      if (slug === "tdd-guide") throw new TypeError("Failed to fetch");
      return {
        slug,
        displayName: slug === "test-case-generator" ? "Test Case Generator" : slug,
      };
    });
    vi.mocked(fetchSkillFiles).mockResolvedValue([{ path: "SKILL.md", size: 1, sha256: "abc" }]);
    vi.mocked(fetchSkillFile).mockResolvedValue("# Test Case Generator\n\n测试生成详情");

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /自动化测试/ }));

    expect(await screen.findByText("Test Case Generator")).toBeInTheDocument();
    expect(await screen.findByText("5 个技能")).toBeInTheDocument();
    expect(await screen.findByText("测试生成详情")).toBeInTheDocument();
    expect(screen.queryByText("Tdd Guide")).not.toBeInTheDocument();
    expect(screen.queryByText("Missing")).not.toBeInTheDocument();
    expect(fetchSkillDetail).not.toHaveBeenCalledWith("tdd-guide");
    expect(fetchSkillFiles).toHaveBeenCalledWith("test-case-generator");
    expect(fetchSkillFiles).not.toHaveBeenCalledWith("tdd-guide");
  });

  it("hides package skill counts on package list items", async () => {
    const detailSkillSlugs = [
      "tdd-guide",
      "test-case-generator",
      "playwright-e2e",
      "api-test",
      "coverage-plan",
      "pytest-unit",
    ];
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "tech"
        ? [{
            id: 1,
            slug: "tech-test-automation",
            displayName: "自动化测试",
            summary: "列表摘要",
            remark: "",
            scene: "tech",
            skillCount: 6,
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
      skillCount: 6,
      skillSlugs: detailSkillSlugs,
      createdAt: 0,
      updatedAt: 0,
    });
    vi.mocked(fetchSkillDetail).mockImplementation(async (slug) => {
      if (slug === "tdd-guide") throw new Error("Skill not found");
      return { slug, displayName: slug };
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /自动化测试/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchSkillSetDetail).toHaveBeenCalledWith("tech-test-automation");
      expect(fetchSkillDetail).toHaveBeenCalledWith("test-case-generator");
    });
    expect(fetchSkillDetail).not.toHaveBeenCalledWith("tdd-guide");
    expect(screen.queryByText(/个技能/)).not.toBeInTheDocument();
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
      "https://cloudcache.tencent-cloud.com/qcloud/tea/app/skillhub/assets/source/ai-buddy-decouple/expert-profiles/finance-quant-backtesting.v20260625.avif",
    );
  });

  it("uses uploaded SkillHub package avatars before generated profile images", async () => {
    vi.mocked(fetchSkillSets).mockResolvedValue({
      skillSets: [{
        id: 1,
        slug: "finance-quant-backtesting",
        displayName: "量化回测",
        summary: "列表摘要",
        remark: "",
        scene: "finance",
        avatarUrl: "https://cdn.example.com/skillhub/quant.png",
        skillCount: 2,
        skillSlugs: ["market-data", "backtest-engine"],
        createdAt: 0,
        updatedAt: 0,
      }],
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    expect(await screen.findByTestId("skill-package-profile-image")).toHaveAttribute(
      "src",
      "https://cdn.example.com/skillhub/quant.png",
    );
  });

  it("falls back from uploaded SkillHub avatars to generated profile images", async () => {
    vi.mocked(fetchSkillSets).mockResolvedValue({
      skillSets: [{
        id: 1,
        slug: "finance-quant-backtesting",
        displayName: "量化回测",
        summary: "列表摘要",
        remark: "",
        scene: "finance",
        avatarUrl: "https://cdn.example.com/skillhub/missing.png",
        skillCount: 2,
        skillSlugs: ["market-data", "backtest-engine"],
        createdAt: 0,
        updatedAt: 0,
      }],
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    fireEvent.error(await screen.findByTestId("skill-package-profile-image"));

    expect(await screen.findByTestId("skill-package-profile-image")).toHaveAttribute(
      "src",
      "https://cloudcache.tencent-cloud.com/qcloud/tea/app/skillhub/assets/source/ai-buddy-decouple/expert-profiles/finance-quant-backtesting.v20260625.avif",
    );
  });

  it("falls back from a missing generated profile image to a default expert avatar", async () => {
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

    await waitFor(() => {
      expect(screen.getByTestId("skill-package-profile-image")).toHaveAttribute(
        "src",
        "https://cloudcache.tencent-cloud.com/qcloud/tea/app/skillhub/assets/source/ai-buddy-decouple/expert-profiles/default-female.v20260625.avif",
      );
    });
  });

  it("falls back to an initial when both generated and default expert profile images fail", async () => {
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
    fireEvent.error(await screen.findByTestId("skill-package-profile-image"));

    expect(await screen.findByTestId("skill-package-profile-fallback")).toHaveTextContent("缺");
  });

  it("uses the parent skills tab as the package title instead of rendering a duplicate package heading", async () => {
    vi.mocked(fetchSkillSets).mockResolvedValue({
      skillSets: [],
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    expect(screen.getByPlaceholderText("搜索技能包")).toHaveClass("lv-skills-search-input", "lv-agent-search-box-input");
    expect(screen.queryByRole("heading", { name: "技能包" })).not.toBeInTheDocument();
  });

  it("keeps the package intro visible while the catalog is loading", async () => {
    let resolveSkillSets: (value: Awaited<ReturnType<typeof fetchSkillSets>>) => void = () => {};
    vi.mocked(fetchSkillSets).mockReturnValue(new Promise((resolve) => {
      resolveSkillSets = resolve;
    }));

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    expect(screen.getByPlaceholderText("搜索技能包")).toBeInTheDocument();
    expect(screen.getByText("正在加载技能包")).toBeInTheDocument();

    resolveSkillSets({ skillSets: [] });
    await waitFor(() => expect(screen.queryByText("正在加载技能包")).not.toBeInTheDocument());
  });

  it("loads SkillHub packages with scenes and filters local dev seed packages without a scene", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async () => ({
      total: 7,
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
            id: 5,
            slug: "content-lyrics",
            displayName: "歌词创作",
            summary: "内容创作摘要",
            remark: "",
            scene: "content-creation",
            subScene: "lyrics-songwriting",
            skillCount: 2,
            createdAt: 0,
            updatedAt: 0,
          }, {
            id: 6,
            slug: "lifestyle-nutrition",
            displayName: "营养健康",
            summary: "生活摘要",
            remark: "",
            scene: "lifestyle",
            skillCount: 2,
            createdAt: 0,
            updatedAt: 0,
          }, {
            id: 4,
            slug: "mysticism-ziwei-doushu",
            displayName: "紫微斗数",
            summary: "新增分类摘要",
            remark: "",
            scene: "mysticism",
            skillCount: 6,
            createdAt: 0,
            updatedAt: 0,
          }, {
            id: 7,
            slug: "assistant-workflow",
            displayName: "万能助手",
            summary: "未知分类摘要",
            remark: "",
            scene: "assistant-lab",
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
    expect(screen.queryByRole("button", { name: /分析师/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /紫微斗数/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /歌词创作/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /营养健康/ })).toBeInTheDocument();
    const assistantCard = screen.getByRole("button", { name: /万能助手/ });
    expect(assistantCard).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /量化回测/ })).toBeInTheDocument();
    expect(screen.getByText("命理占卜顾问")).toBeInTheDocument();
    expect(screen.getByText("歌词创作专家")).toBeInTheDocument();
    expect(screen.getByText("生活健康顾问")).toBeInTheDocument();
    expect(within(assistantCard).getByText("技能包")).toBeInTheDocument();
    expect(screen.queryByText("万能助手专家")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "玄学" })).toBeInTheDocument();
    expect(fetchSkillSets).toHaveBeenCalledWith({
      keyword: "",
      page: 1,
      pageSize: 200,
    });
  });

  it("filters loaded packages by scene immediately without refetching the catalog", async () => {
    let fetchCalls = 0;
    vi.mocked(fetchSkillSets).mockImplementation(() => {
      fetchCalls += 1;
      if (fetchCalls > 1) {
        return new Promise(() => {
          /* keep unresolved so the test catches stale-list behavior */
        });
      }
      return Promise.resolve({
        total: 2,
        skillSets: [{
          id: 1,
          slug: "tech-test-automation",
          displayName: "自动化测试",
          summary: "技术摘要",
          remark: "",
          scene: "tech",
          skillSlugs: ["test-case-generator"],
          skillCount: 1,
          createdAt: 0,
          updatedAt: 0,
        }, {
          id: 2,
          slug: "finance-quant-backtesting",
          displayName: "量化回测",
          summary: "金融摘要",
          remark: "",
          scene: "finance",
          skillSlugs: ["market-data"],
          skillCount: 1,
          createdAt: 0,
          updatedAt: 0,
        }],
      });
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /自动化测试/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /量化回测/ })).toBeInTheDocument();
    expect(fetchSkillSets).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "金融" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: /自动化测试/ })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /量化回测/ })).toBeInTheDocument();
    expect(fetchSkillSets).toHaveBeenCalledTimes(1);
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

    fireEvent.click(await screen.findByRole("button", { name: "召唤" }));

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

    fireEvent.click(await screen.findByRole("button", { name: "召唤" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "已召唤" })).toBeDisabled();
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

    fireEvent.click(await screen.findByRole("button", { name: "召唤" }));

    expect(await screen.findByRole("button", { name: "召唤中 1/2" })).toBeDisabled();
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

    fireEvent.click(await screen.findByRole("button", { name: "召唤" }));

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
      skillCount: 2,
      skillSlugs: ["tdd-guide", "test-case-generator"],
      missing: ["tdd-guide"],
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
      if (command === buildInstallSkillCommand("test-case-generator") && execDebugCommand.mock.calls
        .filter((call) => call[1] === buildInstallSkillCommand("test-case-generator")).length === 1) {
        return {
          status: "failed",
          exitCode: 1,
          output: "[skillhub] 发现新版本 2026.6.23（当前 2026.6.18）。运行 `skillhub self-upgrade` 进行升级。",
        };
      }
      return { status: "success", exitCode: 0, output: "" };
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={execDebugCommand} />);

    fireEvent.click(await screen.findByRole("button", { name: "召唤" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "已召唤" })).toBeDisabled();
    });
    expect(saveExpertPackagesState).toHaveBeenCalledWith("bot-1", {
      installedPackageSlugs: ["tech-test-automation"],
    });
    expect(execDebugCommand).toHaveBeenCalledWith("bot-1", buildSkillHubSelfUpgradeCommand());
    expect(execDebugCommand.mock.calls.map((call) => call[1])).toEqual([
      buildInstalledSkillsListCommand(),
      buildInstallSkillCommand("test-case-generator"),
      buildSkillHubSelfUpgradeCommand(),
      buildInstallSkillCommand("test-case-generator"),
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

    fireEvent.click(await screen.findByRole("button", { name: "召唤" }));

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

    fireEvent.click(await screen.findByRole("button", { name: "召唤" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "已召唤" })).toBeDisabled();
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

    fireEvent.click(await screen.findByRole("button", { name: "召唤" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "已召唤" })).toBeDisabled();
    });

    firstRender.unmount();
    render(<ExpertsPanel botId="bot-1" execDebugCommand={execDebugCommand} />);

    expect(await screen.findByRole("button", { name: "已召唤" })).toBeDisabled();
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

    expect(await screen.findByRole("button", { name: "已召唤" })).toBeDisabled();
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

    const installedButton = await screen.findByRole("button", { name: "已召唤" });
    expect(installedButton).toBeDisabled();
    expect(execDebugCommand).toHaveBeenCalledWith("bot-1", buildInstalledSkillsListCommand());
  });
});
