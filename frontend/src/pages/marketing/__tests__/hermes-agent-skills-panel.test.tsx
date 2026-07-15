import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TsshFileInfo } from "@/lib/tencent-tssh-file-client";
import type { ExpertsExecDebugCommand } from "../hermes-agent-experts-panel";
import {
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

const tsshEntry = (name: string, type: TsshFileInfo["type"]): TsshFileInfo => ({
  accessTime: 0,
  modifyTime: 0,
  name,
  size: 0,
  type,
});

const tsshRecentEntry = (name: string, type: TsshFileInfo["type"]): TsshFileInfo => ({
  ...tsshEntry(name, type),
  modifyTime: Math.floor(Date.now() / 1000),
});

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

  it("defaults to the skill tab and can switch to skill packages", async () => {
    renderPanel("skills");

    const skillsTab = screen.getByRole("tab", { name: "技能" });
    const packagesTab = screen.getByRole("tab", { name: "技能包" });

    expect(skillsTab).toHaveAttribute("aria-selected", "true");
    expect(skillsTab).toHaveStyle({ fontSize: "18px", fontWeight: "600", lineHeight: "24px" });
    expect(packagesTab).toHaveStyle({ color: "rgba(0, 0, 0, 0.38)", fontSize: "18px" });
    expect(screen.getByText("单技能安装面板")).toBeInTheDocument();
    expect(screen.getByTestId("sdk-skill-panel").closest(".lv-agent-skills-sdk-panel")).not.toBeNull();
    expect(screen.getByTestId("sdk-skill-panel")).toHaveAttribute("data-skillhub-api-url", "https://api.skillhub.cn");
    expect(screen.getByPlaceholderText("搜索已安装技能名称")).toBeInTheDocument();

    await userEvent.click(packagesTab);

    expect(screen.getByRole("tab", { name: "技能包" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "技能包" })).toHaveStyle({ color: "rgba(0, 0, 0, 0.95)" });
    expect(screen.getByText("技能包列表")).toBeInTheDocument();
  });

  it("defaults to the package tab for package routes", () => {
    expect(getInitialAgentSkillsTab("experts")).toBe("packages");
    expect(getInitialAgentSkillsTab("packages")).toBe("packages");

    renderPanel("experts");

    expect(screen.getByRole("tab", { name: "技能包" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("技能包列表")).toBeInTheDocument();
  });

  it("hides the skill package tab outside the CN site", () => {
    expect(getInitialAgentSkillsTab("experts", false)).toBe("skills");
    expect(getInitialAgentSkillsTab("packages", false)).toBe("skills");

    renderPanel("packages", false);

    expect(screen.getByRole("tab", { name: "技能" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "技能包" })).not.toBeInTheDocument();
    expect(screen.queryByText("技能包列表")).not.toBeInTheDocument();
    expect(screen.getByText("单技能安装面板")).toBeInTheDocument();
  });

  it("shows the learn skill dialog on the international skills page", async () => {
    const { execDebugCommand } = renderPanel("skills", false);
    tsshMocks.getTerminalSessionMock.mockResolvedValue({
      wsUrl: "wss://example.test/tssh",
      token: "terminal-session-token",
    });
    tsshMocks.execCommandMock.mockResolvedValue({
      exitCode: 0,
      output: "Learning...\n__LIGHTVELA_HERMES_LEARN_COMPLETE__\n",
    });
    tsshMocks.listPathMock.mockImplementation(async (path: string) => {
      if (path === "/home/agentuser/.hermes/skills") {
        return [tsshEntry("MySkill", "d")];
      }
      if (path === "/home/agentuser/.hermes/skills/MySkill") {
        return [tsshEntry("SKILL.md", "-")];
      }
      return [];
    });

    await userEvent.click(screen.getByRole("button", { name: "Learn a Skill" }));

    expect(screen.getByRole("heading", { name: "Learn a skill" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name your skill")).toHaveAttribute("placeholder", "MySkill");
    expect(screen.getByText("Select learning sources")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cloud storage. Upload documents, configuration, or project materials so your Agent can learn from existing files." })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "URL. Paste a public tutorial, doc, or web page so your Agent can distill it into a reusable skill." })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Additional notes. Write down your goal and process so your Agent can learn your personal workflow." })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Cloud storage directory")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Browse cloud storage" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Drag or upload files" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("URL")).toHaveAttribute(
      "placeholder",
      "https://lightvela.ai/ (learn from any website)",
    );
    expect(screen.getByLabelText("Additional notes")).toHaveAttribute(
      "placeholder",
      "e.g. analyze the latest trends in an industry and turn them into a reusable skill...",
    );
    expect(screen.getByRole("button", { name: "Expand additional notes" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Expand additional notes" }));
    expect(screen.getByRole("button", { name: "Collapse additional notes" })).toBeInTheDocument();

    await userEvent.click(screen.getByText("Paste a public tutorial, doc, or web page so your Agent can distill it into a reusable skill."));
    expect(screen.getByRole("button", { name: "URL. Paste a public tutorial, doc, or web page so your Agent can distill it into a reusable skill." })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByText("Paste a public tutorial, doc, or web page so your Agent can distill it into a reusable skill."));
    expect(screen.getByRole("button", { name: "URL. Paste a public tutorial, doc, or web page so your Agent can distill it into a reusable skill." })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByText("Write down your goal and process so your Agent can learn your personal workflow."));
    expect(screen.getByRole("button", { name: "Additional notes. Write down your goal and process so your Agent can learn your personal workflow." })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByText("Write down your goal and process so your Agent can learn your personal workflow."));
    expect(screen.getByRole("button", { name: "Additional notes. Write down your goal and process so your Agent can learn your personal workflow." })).toHaveAttribute("aria-pressed", "false");

    await userEvent.type(screen.getByLabelText("Name your skill"), "MySkill");
    await userEvent.type(screen.getByLabelText("URL"), "https://lightvela.ai/docs");
    await userEvent.type(
      screen.getByLabelText("Additional notes"),
      "how to find the best trends",
    );
    expect(screen.getByRole("button", { name: "URL. Paste a public tutorial, doc, or web page so your Agent can distill it into a reusable skill." })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Additional notes. Write down your goal and process so your Agent can learn your personal workflow." })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Learn" }));

    expect(tsshMocks.execCommandMock).toHaveBeenCalledOnce();
    const [command, timeout] = tsshMocks.execCommandMock.mock.calls[0] as [string, number];
    expect(timeout).toBe(900);
    expect(command).toContain("hermes");
    expect(command).toContain("chat --toolsets \"$TOOLSETS\" -q");
    expect(command).toContain("web,terminal,file,skills");
    expect(command).toContain("/learn Create a reusable Hermes skill named");
    expect(command).toContain("web_extract");
    expect(command).toContain("MySkill");
    expect(command).toContain("https://lightvela.ai/docs");
    expect(execDebugCommand).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Complete. Created /home/agentuser/.hermes/skills/MySkill/SKILL.md. Refreshing Agent Skills."),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Learn skill progress" })).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getAllByText(/Complete/).length).toBeGreaterThan(0);
  });

  it("accepts a recently created slugged skill folder for non-English skill names", async () => {
    renderPanel("skills", false);
    tsshMocks.getTerminalSessionMock.mockResolvedValue({
      wsUrl: "wss://example.test/tssh",
      token: "terminal-session-token",
    });
    tsshMocks.execCommandMock.mockResolvedValue({
      exitCode: 0,
      output: "Learning...\n__LIGHTVELA_HERMES_LEARN_COMPLETE__\n",
    });
    tsshMocks.listPathMock.mockImplementation(async (path: string) => {
      if (path === "/home/agentuser/.hermes/skills") {
        return [tsshRecentEntry("wechat-configure-steps", "d")];
      }
      if (path === "/home/agentuser/.hermes/skills/wechat-configure-steps") {
        return [tsshRecentEntry("SKILL.md", "-")];
      }
      return [];
    });

    await userEvent.click(screen.getByRole("button", { name: "Learn a Skill" }));
    await userEvent.type(screen.getByLabelText("Name your skill"), "微信配置steps");
    await userEvent.type(
      screen.getByLabelText("Additional notes"),
      "微信配置步骤",
    );
    await userEvent.click(screen.getByRole("button", { name: "Learn" }));

    expect(
      await screen.findByText(
        "Complete. Created /home/agentuser/.hermes/skills/wechat-configure-steps/SKILL.md. Refreshing Agent Skills.",
      ),
    ).toBeInTheDocument();
  });
});
