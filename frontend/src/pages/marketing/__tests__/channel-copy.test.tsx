import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { ChangelogPage, VisualCard } from "@/pages/marketing/changelog-page";
import { WhereToUseSection } from "@/pages/marketing/landing/where-to-use-section";

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

vi.mock("@/components/site/login-modal", () => ({
  LoginModal: () => null,
}));

vi.mock("@/components/site/legal-footer", () => ({
  LegalFooter: () => null,
}));

vi.mock("@/components/site/public-site-header", () => ({
  PublicSiteHeader: () => <div>navbar</div>,
}));

afterEach(() => {
  cleanup();
  void i18n.changeLanguage("zh-CN");
});

describe("marketing channel copy", () => {
  it("uses the domestic skill package visual when the revamped card is reused on the domestic site", () => {
    render(<VisualCard variant="skillPackagesRevamp" />);

    const skillPackageImage = screen.getByAltText("LightVela 支持技能包");
    expect(skillPackageImage).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skill-package-cn.webp"),
    );
    expect(skillPackageImage.parentElement).toHaveStyle({ aspectRatio: "1166 / 680" });
  });

  it("announces reliable Skill invocation for automations in the July changelog", () => {
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("2026 年 7 月")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "自动任务支持调用技能" })).toBeInTheDocument();
    const skillsPageImage = screen.getByAltText("技能页面全新升级");
    expect(skillsPageImage).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skills-page-domestic-zh.webp"),
    );
    expect(skillsPageImage.parentElement).toHaveStyle({ aspectRatio: "1161 / 785" });
    expect(
      screen.getByText(
        "创建或编辑自动任务时，可以选择需要调用的技能。Agent 会在执行任务前加载该技能，帮助自动任务更稳定地调用技能。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByAltText("自动任务调用技能设置")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/automation-skill-invocation.png"),
    );
  });

  it("shows WeCom as a supported homepage channel", () => {
    render(<WhereToUseSection />);

    expect(screen.getByRole("heading", { name: "企业微信" })).toBeInTheDocument();
    expect(screen.queryByText("企业微信（即将支持）")).not.toBeInTheDocument();
  });

  it("shows WeCom channel support in the domestic June changelog", () => {
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("2026 年 6 月")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "诊断中心上线，让 Agent 排查更简单" })).toBeInTheDocument();
    expect(screen.getByText("集中查看 Hermes Agent 最近日志，并执行模型配置重置、Agent 重装等维护操作，帮助快速定位和解决问题。")).toBeInTheDocument();
    expect(screen.getByAltText("诊断中心上线，让 Agent 排查更简单")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-diagnostics-domestic-zh.webp"),
    );
    expect(screen.getByRole("heading", { name: "LightVela 支持企业微信通道" })).toBeInTheDocument();
    expect(screen.getByText("现在可以将 Hermes Agent 接入企业微信，在企业微信会话中直接与云端智能伙伴对话。")).toBeInTheDocument();
  });

  it("uses the updated domestic launch and skill package changelog visuals", () => {
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("支持一键创建云端 Hermes Agent，支持快速接入 QQ、微信、飞书通道，支持主流模型 API 接入，支持一键安装 Skill 技能。")).toBeInTheDocument();
    expect(screen.getByAltText("LightVela 产品内测上线")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-launch.webp"),
    );
    expect(screen.getByText("快速安装技能组合，让 Agent 从单点技能走向完整工作流。")).toBeInTheDocument();
    const skillPackageImage = screen.getByAltText("LightVela 支持技能包");
    expect(skillPackageImage).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skill-package-cn.webp"),
    );
    expect(skillPackageImage.parentElement).toHaveStyle({ aspectRatio: "1166 / 680" });
    expect(screen.queryByRole("heading", { name: "新增技能包功能" })).not.toBeInTheDocument();
  });

  it("mentions automations in the May changelog", () => {
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("2026 年 5 月")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "LightVela 支持查看 Hermes Agent 记忆" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "LightVela 支持设置自动任务" })).toBeInTheDocument();
    expect(screen.getByText("为 Agent 设置周期、间隔或单次自动任务，让它按计划执行提醒、总结、通知等日常工作。")).toBeInTheDocument();
  });

  it("describes the April launch with channels, model APIs, and Skill support", () => {
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("heading", { name: "LightVela 产品内测上线" }).length).toBeGreaterThan(0);
    expect(screen.getByText("支持一键创建云端 Hermes Agent，支持快速接入 QQ、微信、飞书通道，支持主流模型 API 接入，支持一键安装 Skill 技能。")).toBeInTheDocument();
  });

  it("shows the Soul persona entry in the domestic May changelog", () => {
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("2026 年 5 月")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Soul 人设能力上线" })).toBeInTheDocument();
    expect(screen.getByText("为 Hermes Agent 抽取并保存专属 Soul 人设，一键注入后通过 /new 开启带有新人设的新会话。")).toBeInTheDocument();
    expect(screen.getByAltText("Soul 人设能力上线")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/soul-persona-domestic-zh.webp"),
    );
    const headings = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(headings.indexOf("Soul 人设能力上线")).toBeLessThan(headings.indexOf("LightVela 支持网页内对话"));
  });

  it("uses dedicated English screenshots in the English changelog", async () => {
    await i18n.changeLanguage("en-US");

    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Automations Now Support Skill Invocation" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "When creating or editing an automation, you can choose the Skill it should use. The Agent loads the Skill before running the task to make Skill invocation more reliable.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByAltText("LightVela Supports Cloud Storage Management")).toHaveAttribute("src", expect.stringContaining("/assets/changelog/lightvela-cloud-storage-en.png"));
    expect(screen.getByAltText("LightVela Now Supports Achievements")).toHaveAttribute("src", expect.stringContaining("/assets/changelog/lightvela-achievements-en.png"));
    expect(screen.getByAltText("LightVela Now Supports Web Chat")).toHaveAttribute("src", expect.stringContaining("/assets/changelog/agentchat-web-chat-en.png"));
    expect(screen.getByAltText("LightVela Now Supports Viewing Hermes Agent Memory")).toHaveAttribute("src", expect.stringContaining("/assets/changelog/hermes-memory-en.png"));
    expect(screen.getByAltText("LightVela Now Supports Automations")).toHaveAttribute("src", expect.stringContaining("/assets/changelog/scheduled-tasks-en.png"));
    expect(screen.getByAltText("Automation Skill invocation settings")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/automation-skill-invocation-en.png"),
    );
  });
});
