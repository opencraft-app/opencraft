import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSkillFile, fetchSkillFiles, fetchSkillSetDetail, fetchSkillSets } from "@/lib/skillhub-api";

import {
  buildInstalledSkillsListCommand,
  buildInstallSkillCommand,
  ExpertsPanel,
  getSkillHubErrorMessage,
  getSkillPackageInstallFailureMessage,
  getSkillPackageTags,
  getUniqueSkillSlugs,
  parseInstalledSkillSlugs,
  stripMarkdownFrontmatter,
} from "../openclaw-experts-panel";

vi.mock("@/lib/skillhub-api", () => ({
  fetchSkillFile: vi.fn(),
  fetchSkillFiles: vi.fn(),
  fetchSkillSets: vi.fn(),
  fetchSkillSetDetail: vi.fn(),
}));

describe("openclaw experts panel", () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    window.localStorage.clear();
  });

  it("deduplicates skill slugs while preserving order", () => {
    expect(getUniqueSkillSlugs([" finance-news ", "market", "finance-news", "", "market"])).toEqual([
      "finance-news",
      "market",
    ]);
  });

  it("builds a single-skill acli install command", () => {
    expect(buildInstallSkillCommand("report's-helper")).toBe("acli skills install 'report'\\''s-helper'");
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
    }, t)).toBe("专家安装：成功 1 项，失败 1 项。失败：backtest-engine；错误：line2；line3；line4");
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

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /量化回测/ }));

    await waitFor(() => {
      expect(fetchSkillSetDetail).toHaveBeenCalledWith("quant-backtest");
    });
    expect(await screen.findByText("技能模块")).toBeInTheDocument();
    expect(await screen.findByText("完整技能详情")).toBeInTheDocument();
    expect(screen.getAllByText("Market Data").length).toBeGreaterThan(0);
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

  it("switches between list and card views", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "finance"
        ? [{
            id: 1,
            slug: "quant-backtest",
            displayName: "量化回测",
            summary: "列表摘要",
            remark: "",
            skillCount: 2,
            createdAt: 0,
            updatedAt: 0,
          }]
        : [],
    }));

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /量化回测/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "卡片" }));
    expect(screen.getByRole("button", { name: "卡片" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "列表" }));
    expect(screen.getByRole("button", { name: "列表" })).toHaveAttribute("aria-pressed", "true");
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
      expect(execDebugCommand).toHaveBeenCalledWith("bot-1", "acli skills install 'backtest-engine'");
    });
    const installCommands = execDebugCommand.mock.calls.map((call) => call[1]).filter((command) => command.startsWith("acli skills install"));
    expect(installCommands).toEqual(["acli skills install 'market-data'", "acli skills install 'backtest-engine'"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
      expect(execDebugCommand).toHaveBeenCalledWith("bot-1", "acli skills install 'backtest-engine'");
    });
    const installCommands = execDebugCommand.mock.calls.map((call) => call[1]).filter((command) => command.startsWith("acli skills install"));
    expect(installCommands).toEqual([
      "acli skills install 'market-data'",
      "acli skills install 'backtest-engine'",
      "acli skills install 'backtest-engine'",
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

  it("marks a package as installed when all package skills are already installed", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: !params?.scene || params.scene === "finance"
        ? [{
            id: 1,
            slug: "quant-backtest",
            displayName: "量化回测",
            summary: "列表摘要",
            remark: "",
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
