import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { ChangelogPage } from "@/pages/marketing/changelog-page";

vi.mock("@/lib/region", async (importOriginal) => ({
  ...(await importOriginal()),
  isGlobal: true,
  isCN: false,
  DEFAULT_LOCALE: "en-US",
}));

vi.mock("framer-motion", () => ({
  motion: new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        const MotionTag = ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => {
          const {
            variants: _variants,
            initial: _initial,
            animate: _animate,
            whileInView: _whileInView,
            viewport: _viewport,
            custom: _custom,
            ...domProps
          } = props as React.HTMLAttributes<HTMLElement> & Record<string, unknown>;
          return React.createElement(tag, domProps, children);
        };
        return MotionTag;
      },
    },
  ),
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    isAuthenticated: false,
    session: { stage: "anonymous", user: null },
  }),
}));

vi.mock("@/components/site/login-modal", () => ({ LoginModal: () => null }));
vi.mock("@/components/site/legal-footer", () => ({ LegalFooter: () => null }));
vi.mock("@/components/site/public-site-header", () => ({ PublicSiteHeader: () => <div>navbar</div> }));

afterEach(() => {
  cleanup();
  void i18n.changeLanguage("zh-CN");
});

describe("global changelog skill package entry", () => {
  it("shows the new global August updates in every global locale", async () => {
    await i18n.changeLanguage("zh-CN");
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("2026 年 8 月")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "LightVela 支持上传自定义人设文件" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "自动任务支持关联上游任务" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "创建或编辑自动任务时，可以关联一个上游任务。后续该任务执行时，会使用上游任务最近一次的输出作为上下文。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "LightVela 支持钉钉通道" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "技能页面支持批量安装与来源查看" })).toBeInTheDocument();
    expect(screen.getByText("安装多个 Skill 时可以查看实时进度，并从技能页面直接打开 ClawHub 或 skills.sh 的原始来源页面。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "自动任务模板" })).toBeInTheDocument();
    expect(screen.getByText("选择一个现成的自动任务模板，先运行一次，确认效果后再将其转为持续执行的自动任务。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "支持在 QQ 群聊中 @ 机器人" })).toBeInTheDocument();
    expect(screen.getByText("将 Hermes Agent 添加到 QQ 群后，@ 机器人即可开始对话。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "支持繁体中文" })).toBeInTheDocument();
    expect(screen.getByText("现在可以使用繁体中文浏览 LightVela 的公开页面、产品文档和账号流程。")).toBeInTheDocument();
    expect(screen.getByAltText("自动任务支持关联上游任务")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-automation-upstream-task.png"),
    );
    expect(screen.getByAltText("技能页面支持批量安装与来源查看")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skills-bulk-install-global-zh.png"),
    );
    expect(screen.getByAltText("自动任务模板")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-automation-templates-global-zh.png"),
    );
    expect(screen.getByAltText("支持在 QQ 群聊中 @ 机器人")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-qq-group-mentions-global-zh.png"),
    );
    expect(screen.getByAltText("支持繁体中文")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-traditional-chinese-global-all.png"),
    );
    const zhHeadings = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(zhHeadings).not.toContain("定价支持更多套餐与订阅方式");

    cleanup();
    await i18n.changeLanguage("en-US");
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(
      screen.queryByRole("heading", { name: "LightVela Now Supports Custom Persona File Uploads" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Automation Tasks Can Now Link to Upstream Tasks" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "When creating or editing an automation task, you can link an upstream task. When the task runs later, it uses the upstream task's most recent output as context.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Skills Page Gets Faster Installs and Clearer Sources" })).toBeInTheDocument();
    expect(screen.getByText("Install multiple Skills with live progress and open their original ClawHub or skills.sh source pages directly from the Skills page.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ready-Made Automation Templates" })).toBeInTheDocument();
    expect(screen.getByText("Choose a ready-made automation template, run it once, and turn it into an ongoing task when it works for you.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "QQ Group @Mentions Are Now Supported" })).toBeInTheDocument();
    expect(screen.getByText("Add your Hermes Agent to a QQ group and @mention it to start a conversation.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Traditional Chinese Is Now Available" })).toBeInTheDocument();
    expect(screen.getByText("Browse LightVela's public pages, documentation, and account flows in Traditional Chinese.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pricing Is Now Available with More Flexible Billing" })).not.toBeInTheDocument();
    expect(screen.getByAltText("Automation Tasks Can Now Link to Upstream Tasks")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-automation-upstream-task.png"),
    );
    expect(screen.getByAltText("Skills Page Gets Faster Installs and Clearer Sources")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skills-bulk-install-global-en.png"),
    );
    expect(screen.getByAltText("Ready-Made Automation Templates")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-automation-templates-global-en.png"),
    );
    expect(screen.getByAltText("QQ Group @Mentions Are Now Supported")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-qq-group-mentions-global-en.png"),
    );
    expect(screen.getByAltText("Traditional Chinese Is Now Available")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-traditional-chinese-global-all.png"),
    );

    cleanup();
    await i18n.changeLanguage("zh-Hant");
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(
      screen.queryByRole("heading", { name: "LightVela 支持上傳自定義人設文件" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "自動任務支持關聯上游任務" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "技能頁面支持批量安裝與來源查看" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "自動任務模板" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "支持在 QQ 群聊中 @ 機器人" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "支持繁體中文" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "定價支持更多套餐與訂閲方式" })).not.toBeInTheDocument();
    expect(screen.getByAltText("技能頁面支持批量安裝與來源查看")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skills-bulk-install-global-zh.png"),
    );
    expect(screen.getByAltText("自動任務模板")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-automation-templates-global-zh.png"),
    );
    expect(screen.getByAltText("支持在 QQ 群聊中 @ 機器人")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-qq-group-mentions-global-zh.png"),
    );
    expect(screen.getByAltText("支持繁體中文")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-traditional-chinese-global-all.png"),
    );

    cleanup();
    await i18n.changeLanguage("id-ID");
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(
      screen.queryByRole("heading", { name: "LightVela kini mendukung unggahan file persona kustom" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Tugas Otomatis Kini Dapat Ditautkan ke Tugas Hulu" }),
    ).toBeInTheDocument();
  });

  it("uses locale-specific skill package copy and screenshots", async () => {
    await i18n.changeLanguage("zh-CN");
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "技能页面全新升级" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "LightVela 支持技能包" })).toBeInTheDocument();
    expect(screen.getByAltText("LightVela 支持技能包")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skill-packages-global-zh.webp"),
    );
    expect(screen.getByRole("heading", { name: "诊断中心上线，让 Agent 排查更简单" })).toBeInTheDocument();
    expect(screen.getByAltText("诊断中心上线，让 Agent 排查更简单")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-diagnostics-global-zh.webp"),
    );
    expect(screen.getByRole("heading", { name: "Soul 人设能力上线" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "LightVela 支持查看 Hermes Agent 记忆" })).toBeInTheDocument();
    expect(screen.getByAltText("Soul 人设能力上线")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/soul-persona-global-zh.webp"),
    );
    expect(screen.getByAltText("LightVela 产品内测上线")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-launch-global-zh.webp"),
    );
    expect(
      screen.getByText(
        "支持一键创建云端 Hermes Agent，支持快速接入 Telegram、WhatsApp、Discord、Slack 等通道，支持主流模型 API 接入，支持一键安装 Skill 技能。",
      ),
    ).toBeInTheDocument();

    cleanup();
    await i18n.changeLanguage("en-US");
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "The Skills Page, Reimagined" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "LightVela Supports Skill Packages" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Install skill combinations quickly, helping your Agent move from individual Skills to complete workflows.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByAltText("LightVela Supports Skill Packages")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skill-packages-global-en.webp"),
    );
    expect(screen.getByRole("heading", { name: "Diagnostics Center Is Here for Faster Agent Troubleshooting" })).toBeInTheDocument();
    expect(screen.getByAltText("Diagnostics Center Is Here for Faster Agent Troubleshooting")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-diagnostics-global-en.webp"),
    );
    expect(screen.getByRole("heading", { name: "Soul Personas Are Now Available" })).toBeInTheDocument();
    expect(screen.getByAltText("Soul Personas Are Now Available")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/soul-persona-global-en.webp"),
    );
    expect(screen.getByAltText("LightVela Product Beta Launch")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-launch-global-en.webp"),
    );
  });
});
