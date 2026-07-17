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
      expect.stringContaining("/assets/changelog/lightvela-skill-packages-global-zh.png"),
    );
    expect(screen.getByRole("heading", { name: "诊断中心上线，让 Agent 排查更简单" })).toBeInTheDocument();
    expect(screen.getByAltText("诊断中心上线，让 Agent 排查更简单")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-diagnostics-global-zh.png"),
    );
    expect(screen.getByRole("heading", { name: "Soul 人设能力上线" })).toBeInTheDocument();
    expect(screen.getByAltText("Soul 人设能力上线")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/soul-persona-global-zh.png"),
    );
    expect(screen.getByAltText("LightVela 产品内测上线")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-launch-global-zh.png"),
    );

    cleanup();
    await i18n.changeLanguage("en-US");
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "The Skills Page, Reimagined" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "LightVela supports Skill Packages" })).toBeInTheDocument();
    expect(screen.getByAltText("LightVela supports Skill Packages")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skill-packages-global-en.png"),
    );
    expect(screen.getByRole("heading", { name: "Diagnostics Center Is Here for Faster Agent Troubleshooting" })).toBeInTheDocument();
    expect(screen.getByAltText("Diagnostics Center Is Here for Faster Agent Troubleshooting")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-diagnostics-global-en.png"),
    );
    expect(screen.getByRole("heading", { name: "Soul personas are now available" })).toBeInTheDocument();
    expect(screen.getByAltText("Soul personas are now available")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/soul-persona-global-en.png"),
    );
    expect(screen.getByAltText("LightVela Product Beta Launch")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-launch-global-en.png"),
    );
  });
});
