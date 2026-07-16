import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExpertsExecDebugCommand } from "../hermes-agent-experts-panel";
import {
  getSafeUploadFileName,
  getInitialAgentSkillsTab,
  HermesAgentSkillsPanel,
} from "../hermes-agent-skills-panel";

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

vi.mock("../hermes-agent-experts-panel", () => ({
  ExpertsPanel: () => <div>技能包列表</div>,
}));

function TestSkillPanel({ skillHubApiUrl }: { skillHubApiUrl?: string }) {
  return (
    <div data-testid="sdk-skill-panel" data-skillhub-api-url={skillHubApiUrl}>
      单技能安装面板
      <input className="lh-std-skill-panel__installed-search-input" placeholder="搜索技能名称" />
    </div>
  );
}

const renderPanel = (initialSectionSlug?: string, showSkillPackages = true) => {
  const execDebugCommand: ExpertsExecDebugCommand = vi.fn();
  render(
    <HermesAgentSkillsPanel
      botId="bot-1"
      execDebugCommand={execDebugCommand}
      featureFlags={{} as never}
      initialSectionSlug={initialSectionSlug}
      instance={{ InstanceId: "bot-1", RegionId: 1 }}
      productConfig={{} as never}
      showSkillPackages={showSkillPackages}
      SkillPanel={TestSkillPanel}
    />,
  );
  return { execDebugCommand };
};

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

  it("defaults to the domestic Skills Demo and can switch to Experts", async () => {
    renderPanel("skills");

    const outerTabs = within(screen.getByRole("tablist", { name: "技能页面切换" }));
    const demoTabs = within(screen.getByRole("tablist", { name: "技能市场页面切换" }));
    const skillsTab = outerTabs.getByRole("tab", { name: "技能" });
    const expertsTab = demoTabs.getByRole("tab", { name: "技能包" });

    expect(skillsTab).toHaveAttribute("aria-selected", "true");
    expect(skillsTab).toHaveStyle({ fontSize: "18px", fontWeight: "600", lineHeight: "24px" });
    expect(expertsTab).toBeInTheDocument();
    expect(screen.getByText("从 SkillHub 搜索、安装和管理技能，也可以创建属于你的技能。")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索 SkillHub 中的技能")).toBeInTheDocument();

    await userEvent.click(expertsTab);

    expect(expertsTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("技能包列表")).toBeInTheDocument();
  });

  it("defaults to the package tab for package routes", () => {
    expect(getInitialAgentSkillsTab("experts")).toBe("packages");
    expect(getInitialAgentSkillsTab("packages")).toBe("packages");

    renderPanel("experts");

    expect(screen.getByRole("tab", { name: "技能包" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("技能包列表")).toBeInTheDocument();
  });

  it("keeps the Skills demo package tab independent of the legacy outer tab", async () => {
    expect(getInitialAgentSkillsTab("experts", false)).toBe("skills");
    expect(getInitialAgentSkillsTab("packages", false)).toBe("skills");

    renderPanel("packages", false);

    expect(within(screen.getByRole("tablist", { name: "技能页面切换" })).getByRole("tab", { name: "技能" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "技能包" })).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("tablist", { name: "技能市场页面切换" })).getByRole("tab", { name: "技能" }));
    expect(screen.getByPlaceholderText("搜索 SkillHub 中的技能")).toBeInTheDocument();
  });

  it("hides the Create Skill tab for now", () => {
    renderPanel("skills", false);

    expect(screen.queryByRole("tab", { name: "创建技能" })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索 SkillHub 中的技能")).toBeInTheDocument();
  });
});

describe("inline upload file names", () => {
  it("keeps uploaded files inside the configured remote directory", () => {
    expect(getSafeUploadFileName("../../secrets.txt")).toBe("secrets.txt");
    expect(getSafeUploadFileName("..")).toBe("uploaded-file");
    expect(getSafeUploadFileName("report.pdf")).toBe("report.pdf");
  });
});
