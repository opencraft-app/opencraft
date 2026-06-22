import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { ChangelogPage } from "@/pages/marketing/changelog-page";
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
  it("shows WeCom as a supported homepage channel", () => {
    render(<WhereToUseSection />);

    expect(screen.getByRole("heading", { name: "企业微信" })).toBeInTheDocument();
    expect(screen.queryByText("企业微信（即将支持）")).not.toBeInTheDocument();
  });

  it("omits WeCom channel support from the June changelog", () => {
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("2026 年 6 月")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "LightVela 支持企业微信通道" })).not.toBeInTheDocument();
    expect(screen.queryByText("现在可以将 Hermes Agent 接入企业微信，在企业微信会话中直接与云端智能伙伴对话。")).not.toBeInTheDocument();
  });

  it("mentions automations in the May changelog", () => {
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("2026 年 5 月")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "LightVela 支持设置自动任务" })).toBeInTheDocument();
    expect(screen.getByText("为 Agent 设置周期、间隔或单次自动任务，让它按计划执行提醒、总结、通知等日常工作。")).toBeInTheDocument();
  });

  it("describes the April launch with channels, model APIs, and Skill support", () => {
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("heading", { name: "LightVela内测上线" }).length).toBeGreaterThan(0);
    expect(screen.getByText("支持一键创建云端 Hermes，支持快速接入 QQ、微信、飞书通道，支持主流模型 API 接入，支持一键安装 Skill 技能。")).toBeInTheDocument();
  });

  it("omits the Soul persona entry from the May changelog", () => {
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("2026 年 5 月")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Soul 人设能力上线" })).not.toBeInTheDocument();
    expect(screen.queryByText("为 Hermes Agent 抽取并保存专属 Soul 人设，一键注入后通过 /new 开启带有新人设的新会话。")).not.toBeInTheDocument();
  });

  it("uses dedicated English screenshots in the English changelog", async () => {
    await i18n.changeLanguage("en-US");

    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByAltText("LightVela now supports cloud storage")).toHaveAttribute("src", expect.stringContaining("/assets/changelog/lightvela-cloud-storage-en.png"));
    expect(screen.getByAltText("LightVela now supports achievements")).toHaveAttribute("src", expect.stringContaining("/assets/changelog/lightvela-achievements-en.png"));
    expect(screen.getByAltText("LightVela now supports web chat")).toHaveAttribute("src", expect.stringContaining("/assets/changelog/agentchat-web-chat-en.png"));
    expect(screen.getByAltText("LightVela now supports viewing Hermes Agent memory")).toHaveAttribute("src", expect.stringContaining("/assets/changelog/hermes-memory-en.png"));
    expect(screen.getByAltText("LightVela now supports automations")).toHaveAttribute("src", expect.stringContaining("/assets/changelog/scheduled-tasks-en.png"));
  });
});
