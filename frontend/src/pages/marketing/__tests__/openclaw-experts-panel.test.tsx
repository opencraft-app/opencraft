import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSkillSetDetail, fetchSkillSets } from "@/lib/skillhub-api";

import {
  buildInstallSkillCommand,
  ExpertsPanel,
  getSkillHubErrorMessage,
  getSkillPackageInstallFailureMessage,
  getSkillPackageTags,
  getUniqueSkillSlugs,
  stripMarkdownFrontmatter,
} from "../openclaw-experts-panel";

vi.mock("@/lib/skillhub-api", () => ({
  fetchSkillSets: vi.fn(),
  fetchSkillSetDetail: vi.fn(),
}));

describe("openclaw experts panel", () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
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

  it("builds compact card tags from the package name and skill count", () => {
    expect(getSkillPackageTags({ displayName: " 量化回测 ", skillCount: 6 })).toEqual(["量化回测", "6 skills"]);
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

  it("opens skill package detail when a card is clicked", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: params?.scene === "finance"
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
      content: "完整技能包详情",
      createdAt: 0,
      updatedAt: 0,
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /量化回测/ }));

    await waitFor(() => {
      expect(fetchSkillSetDetail).toHaveBeenCalledWith("quant-backtest");
    });
    expect(await screen.findByRole("dialog")).toHaveTextContent("完整技能包详情");
    expect(screen.getByText("market-data")).toBeInTheDocument();
  });

  it("opens skill package detail when a card tag is clicked", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: params?.scene === "finance"
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
      content: "完整技能包详情",
      createdAt: 0,
      updatedAt: 0,
    });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={vi.fn()} />);

    fireEvent.click(await screen.findByText("2 skills"));

    await waitFor(() => {
      expect(fetchSkillSetDetail).toHaveBeenCalledWith("quant-backtest");
    });
    expect(await screen.findByRole("dialog")).toHaveTextContent("完整技能包详情");
  });

  it("installs package skills one by one without opening detail", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: params?.scene === "finance"
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
    const execDebugCommand = vi.fn().mockResolvedValue({ status: "success", exitCode: 0, output: "" });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={execDebugCommand} />);

    fireEvent.click(await screen.findByRole("button", { name: "安装" }));

    await waitFor(() => {
      expect(execDebugCommand).toHaveBeenCalledTimes(2);
    });
    expect(execDebugCommand).toHaveBeenNthCalledWith(1, "bot-1", "acli skills install 'market-data'");
    expect(execDebugCommand).toHaveBeenNthCalledWith(2, "bot-1", "acli skills install 'backtest-engine'");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("retries failed package skills once", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: params?.scene === "finance"
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
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce({ status: "success", exitCode: 0, output: "" })
      .mockResolvedValueOnce({ status: "failed", exitCode: 1, output: "" })
      .mockResolvedValueOnce({ status: "success", exitCode: 0, output: "" });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={execDebugCommand} />);

    fireEvent.click(await screen.findByRole("button", { name: "安装" }));

    await waitFor(() => {
      expect(execDebugCommand).toHaveBeenCalledTimes(3);
    });
    expect(execDebugCommand).toHaveBeenNthCalledWith(3, "bot-1", "acli skills install 'backtest-engine'");
  });

  it("shows failed skill slugs when package installation still fails after retry", async () => {
    vi.mocked(fetchSkillSets).mockImplementation(async (params) => ({
      skillSets: params?.scene === "finance"
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
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce({ status: "success", exitCode: 0, output: "" })
      .mockResolvedValueOnce({ status: "failed", exitCode: 1, output: "preflight failed\nmissing dependency" })
      .mockResolvedValueOnce({ status: "failed", exitCode: 1, output: "install failed\nmissing dependency" });

    render(<ExpertsPanel botId="bot-1" execDebugCommand={execDebugCommand} />);

    fireEvent.click(await screen.findByRole("button", { name: "安装" }));

    expect(await screen.findByText(/失败：backtest-engine/)).toHaveTextContent("missing dependency");
  });
});
