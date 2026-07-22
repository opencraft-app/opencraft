import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isGlobal } from "@/lib/region";
import type { ExpertsExecDebugCommand } from "../agent-experts-panel";
import {
  getSafeUploadFileName,
  HermesAgentSkillsPanel,
} from "../agent-skills-panel";

const tsshMocks = vi.hoisted(() => ({
  closeMock: vi.fn(),
  connectMock: vi.fn(async () => undefined),
  execCommandMock: vi.fn(),
  getTerminalSessionMock: vi.fn(),
  listPathMock: vi.fn(),
}));

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string, options?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      "学习技能": "Learn a Skill",
      "学习一个技能": "Learn a skill",
      "给你的智能体一个来源，或告诉它任何你想补充的内容，它会把这些内容变成聊天中可复用的技能！":
        "Give your agent a source, or tell it anything you want, and it turns it into a reusable skill in chat!",
      "命名你的技能": "Name your skill",
      "输出：{{name}}.md，会保存到智能体技能": "Output: {{name}}.md in Agent Skills",
      "选择学习来源": "Select learning sources",
      "云端存储": "Cloud storage",
      "上传文档、配置或项目资料，让 Agent 从已有文件中学习。": "Upload documents, configuration, or project materials so your Agent can learn from existing files.",
      "云端存储目录": "Cloud storage directory",
      "浏览云端存储": "Browse cloud storage",
      "还没有选择云端存储文件。": "No cloud storage files selected yet.",
      "https://lightvela.ai/（可从任意网站学习）": "https://lightvela.ai/ (learn from any website)",
      "网址": "URL",
      "粘贴公开教程、文档或网页，让 Agent 提炼成可复用技能。": "Paste a public tutorial, doc, or web page so your Agent can distill it into a reusable skill.",
      "补充说明": "Additional notes",
      "直接写下你的目标和流程，让 Agent 学会你的专属工作方式。": "Write down your goal and process so your Agent can learn your personal workflow.",
      "其他内容 - 描述任何你想补充的信息": "Anything else - describe anything you wish to add",
      "例如：分析某行业最新趋势，并沉淀成可复用技能…": "e.g. analyze the latest trends in an industry and turn them into a reusable skill...",
      "展开补充说明": "Expand additional notes",
      "收起补充说明": "Collapse additional notes",
      "学习技能进度": "Learn skill progress",
      "学习": "Learn",
      "已完成": "Complete",
      "已完成。已创建 {{path}}。正在刷新智能体技能。": "Complete. Created {{path}}. Refreshing Agent Skills.",
    };
    const template = translations[text] ?? text;
    return template.replace(/\{\{\s*([\w$]+)\s*\}\}/g, (raw, name: string) => {
      const value = options?.[name];
      return value === undefined || value === null ? raw : String(value);
    });
  },
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    bots: {
      getTerminalSession: tsshMocks.getTerminalSessionMock,
    },
  }),
}));

vi.mock("@/lib/tencent-tssh-file-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tencent-tssh-file-client")>(
    "@/lib/tencent-tssh-file-client",
  );

  return {
    ...actual,
    TencentTsshFileClient: vi.fn().mockImplementation(function MockTencentTsshFileClient() {
      return {
        close: tsshMocks.closeMock,
        connect: tsshMocks.connectMock,
        execCommand: tsshMocks.execCommandMock,
        isReady: vi.fn(() => true),
        listPath: tsshMocks.listPathMock,
      };
    }),
  };
});

vi.mock("../agent-experts-panel", () => ({
  ExpertsPanel: () => <div>技能包列表</div>,
}));

const renderPanel = (initialSectionSlug?: string) => {
  const execDebugCommand: ExpertsExecDebugCommand = vi.fn();
  render(
    <HermesAgentSkillsPanel
      botId="bot-1"
      execDebugCommand={execDebugCommand}
      initialSectionSlug={initialSectionSlug}
    />,
  );
  return { execDebugCommand };
};

const skillsSearchPlaceholder = isGlobal
  ? "搜索 Skills.sh / Clawhub 中的技能"
  : "搜索 SkillHub 中的技能";

describe("HermesAgentSkillsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    tsshMocks.closeMock.mockClear();
    tsshMocks.connectMock.mockClear();
    tsshMocks.execCommandMock.mockReset();
    tsshMocks.getTerminalSessionMock.mockReset();
    tsshMocks.listPathMock.mockReset();
  });

  it("defaults to the mono2 Skills Demo and can switch to Experts", async () => {
    renderPanel("skills");

    const outerTabs = within(screen.getByRole("tablist", { name: "技能页面切换" }));
    const demoTabs = within(screen.getByRole("tablist", { name: "技能市场页面切换" }));
    const skillsTab = outerTabs.getByRole("tab", { name: "技能" });
    const expertsTab = demoTabs.getByRole("tab", { name: "技能包" });

    expect(skillsTab).toHaveAttribute("aria-selected", "true");
    expect(skillsTab).toHaveStyle({ fontSize: "18px", fontWeight: "600", lineHeight: "24px" });
    expect(expertsTab).toBeInTheDocument();
    const description = isGlobal
      ? "为智能体安装技能。支持 ClawHub 与 skills.sh 两个技能市场，安装后可在对话中自动调用。"
      : "为你的智能体安装技能（Skill），安装后 Agent 执行任务时可自动调用";
    expect(screen.getByText(description)).toBeInTheDocument();
    expect(within(screen.getByText(description).closest("p") as HTMLElement).queryByRole("link")).toBeNull();
    expect(screen.getByPlaceholderText(skillsSearchPlaceholder)).toBeInTheDocument();

    await userEvent.click(expertsTab);

    expect(expertsTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("技能包列表")).toBeInTheDocument();
  });

  it.each(["experts", "packages"])("defaults to the Experts tab for the %s route", (route) => {
    renderPanel(route);

    expect(screen.getByRole("tab", { name: "技能包" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("技能包列表")).toBeInTheDocument();
  });

  it("hides the Create Skill tab for now", () => {
    renderPanel("skills");

    expect(screen.queryByRole("tab", { name: "创建技能" })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(skillsSearchPlaceholder)).toBeInTheDocument();
  });

  it("remounts the skills workspace when switching Agents", () => {
    const execDebugCommand: ExpertsExecDebugCommand = vi.fn();
    const renderForAgent = (botId: string) => (
      <HermesAgentSkillsPanel
        botId={botId}
        execDebugCommand={execDebugCommand}
        initialSectionSlug="skills"
      />
    );
    const { rerender } = render(renderForAgent("bot-1"));
    const searchInput = screen.getByPlaceholderText(skillsSearchPlaceholder);
    fireEvent.change(searchInput, { target: { value: "old-agent-query" } });
    expect(searchInput).toHaveValue("old-agent-query");

    rerender(renderForAgent("bot-2"));

    expect(screen.getByPlaceholderText(skillsSearchPlaceholder)).toHaveValue("");
  });

  it("keeps the Skills route outside the TEA SDK runtime boundary", () => {
    const settingsPageSource = readFileSync(
      resolve(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"),
      "utf8",
    );
    const skillsPanelSource = readFileSync(
      resolve(process.cwd(), "src/pages/marketing/agent-skills-panel.tsx"),
      "utf8",
    );
    const stableHostSource = readFileSync(
      resolve(process.cwd(), "src/pages/marketing/agent-settings-sdk-stable-host.tsx"),
      "utf8",
    );

    expect(settingsPageSource).not.toContain("HermesAgentSkillsRuntimePanel");
    expect(settingsPageSource).not.toContain("runtime.SkillPanel");
    expect(settingsPageSource).toContain(
      'const TEA_SDK_SECTIONS = new Set<AgentSettingsSectionId>(["channel", "model"]);',
    );
    expect(skillsPanelSource).not.toMatch(/\bSkillPanel\b/);
    expect(skillsPanelSource).not.toContain("lv-agent-skills-sdk-panel");
    expect(stableHostSource).not.toContain("lh-std-skill-panel");
  });
});

describe("inline upload file names", () => {
  it("keeps uploaded files inside the configured remote directory", () => {
    expect(getSafeUploadFileName("../../secrets.txt")).toBe("secrets.txt");
    expect(getSafeUploadFileName("..")).toBe("uploaded-file");
    expect(getSafeUploadFileName("report.pdf")).toBe("report.pdf");
  });
});
