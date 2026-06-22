import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSkillSetDetail, fetchSkillSets } from "@/lib/skillhub-api";

import {
  buildInstallSkillPackageCommand,
  ExpertsPanel,
  getSkillHubErrorMessage,
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

  it("builds one batched acli skills install command", () => {
    const command = buildInstallSkillPackageCommand(["finance-news", "report's-helper", "finance-news"]);

    expect(command).toBe("acli skills install 'finance-news' 'report'\\''s-helper'");
    expect(command.match(/acli skills install 'finance-news'/g)).toHaveLength(1);
  });

  it("returns a no-op command for an empty package", () => {
    expect(buildInstallSkillPackageCommand([" ", ""])).toBe("echo 'No skills to install.'");
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

  it("does not open detail when the install button is clicked", async () => {
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
      expect(execDebugCommand).toHaveBeenCalled();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
