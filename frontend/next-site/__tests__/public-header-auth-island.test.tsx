import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const runtimeMock = vi.hoisted(() => ({
  language: "es",
  authReady: true,
  isAuthenticated: false,
}));
const agentMock = vi.hoisted(() => ({ bots: [] as unknown[], isSubscribed: false }));
const loginModalMock = vi.hoisted(() => ({ onSuccess: undefined as (() => void) | undefined }));
const trackDatongClickMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: runtimeMock.language } }),
}));
vi.mock("@/components/site/login-modal", () => ({
  LoginModal: (props: { onSuccess?: () => void }) => {
    loginModalMock.onSuccess = props.onSuccess;
    return null;
  },
}));
vi.mock("@/components/site/user-avatar-menu", () => ({ UserAvatarMenu: () => null }));
vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => agentMock,
}));
vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    authReady: runtimeMock.authReady,
    isAuthenticated: runtimeMock.isAuthenticated,
  }),
}));
vi.mock("@/lib/oauth", () => ({ oauthErrorMessage: () => null }));
vi.mock("@/lib/region", async () => {
  const actual = await vi.importActual<typeof import("@/lib/region")>("@/lib/region");
  return { ...actual, isGlobal: true };
});
vi.mock("@/observability/datong-tracker", () => ({
  trackDatongClick: trackDatongClickMock,
}));
vi.mock("@next-site/language-switcher", () => ({ renderNextLanguageSwitcher: () => null }));

import { PublicHeaderAuthIsland } from "@next-site/public-header-auth-island";

beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  runtimeMock.language = "es";
  runtimeMock.authReady = true;
  runtimeMock.isAuthenticated = false;
  agentMock.bots = [];
  agentMock.isSubscribed = false;
  loginModalMock.onSuccess = undefined;
});

afterEach(() => {
  cleanup();
  routerMock.push.mockReset();
  trackDatongClickMock.mockReset();
});

describe("PublicHeaderAuthIsland", () => {
  it("keeps locale dictionaries and closed auth UI out of the initial header chunk", () => {
    const source = readFileSync(
      path.join(process.cwd(), "next-site/public-header-auth-island.tsx"),
      "utf8",
    );

    expect(source).not.toContain('import { useTranslation } from \'react-i18next\'');
    expect(source).not.toContain("import { LoginModal }");
    expect(source).not.toContain("import { UserAvatarMenu }");
    expect(source).toContain("import('@/components/site/login-modal')");
    expect(source).toContain("import('@/components/site/user-avatar-menu')");
  });

  it("uses the homepage language-and-login treatment across international public pages", () => {
    render(<PublicHeaderAuthIsland locale="es" showLanguageSwitcher={false} />);

    expect(screen.queryByRole("button", { name: "Crear ahora" })).not.toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Iniciar sesión" })) {
      expect(button).toHaveClass("bg-black/90", "text-white");
    }
  });

  it.each([
    ["zh-CN", "开始使用"],
    ["zh-SG", "开始使用"],
    ["zh-Hant", "開始使用"],
    ["en-US", "Enter LightVela"],
    ["id-ID", "Masuk ke LightVela"],
    ["es", "Entrar a LightVela"],
    ["ja-JP", "LightVelaを開く"],
    ["ko-KR", "LightVela 열기"],
  ] as const)("shows the homepage product entry for %s", (locale, label) => {
    runtimeMock.isAuthenticated = true;
    render(
      <PublicHeaderAuthIsland
        locale={locale}
        showLanguageSwitcher={false}
        showProductEntry
      />,
    );

    const links = screen.getAllByRole("link", { name: label });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/agents");
    }
  });

  it("keeps the product entry off non-home public pages", () => {
    runtimeMock.isAuthenticated = true;
    render(<PublicHeaderAuthIsland locale="en-US" showLanguageSwitcher={false} />);

    expect(screen.queryByRole("link", { name: "Enter LightVela" })).not.toBeInTheDocument();
  });

  it("keeps anonymous homepage actions unchanged", () => {
    render(
      <PublicHeaderAuthIsland
        locale="zh-CN"
        showLanguageSwitcher={false}
        showProductEntry
        promoteFreeTrial
        loginOnly={false}
      />,
    );

    expect(screen.queryByRole("link", { name: "开始使用" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "免费试用" })).toBeInTheDocument();
  });

  it("tracks the desktop product entry without changing its native target", () => {
    runtimeMock.isAuthenticated = true;
    render(
      <PublicHeaderAuthIsland locale="en-US" showLanguageSwitcher={false} showProductEntry />,
    );

    const link = screen.getAllByRole("link", { name: "Enter LightVela" })[0]!;
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);

    expect(trackDatongClickMock).toHaveBeenCalledWith("agent_enter_console_btn", {
      pgid: "home",
      params: { surface: "desktop", target: "/agents" },
    });
  });

  it("supports the international homepage login-only treatment", () => {
    (globalThis as { React?: typeof React }).React = React;
    render(<PublicHeaderAuthIsland locale="en-US" showLanguageSwitcher={false} loginOnly />);

    expect(screen.queryByRole("button", { name: "Create Now" })).not.toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Sign In" })) {
      expect(button).toHaveClass("bg-black/90", "text-white");
    }
  });

  it("keeps login-only auth copy localized", () => {
    (globalThis as { React?: typeof React }).React = React;
    render(<PublicHeaderAuthIsland locale="id-ID" showLanguageSwitcher={false} loginOnly />);

    for (const button of screen.getAllByRole("button", { name: "Masuk" })) {
      expect(button).toHaveClass("bg-black/90", "text-white");
    }
    expect(screen.queryByRole("button", { name: "Sign In" })).not.toBeInTheDocument();
  });

  describe("登录成功后的落地页分流", () => {
    /* LoginModal 走 next/dynamic 异步加载，同步渲染取不到其 props，
       因此对 onSuccess 的分流规则改为校验源码实现，避免依赖异步加载时序。 */
    const source = readFileSync(
      path.join(process.cwd(), "next-site/public-header-auth-island.tsx"),
      "utf8",
    );
    const onSuccessBody = source.slice(
      source.indexOf("onSuccess={() => {"),
      source.indexOf("onSuccess={() => {") + 520,
    );

    it("未订阅时进入订阅页而非控制台", () => {
      expect(onSuccessBody).toContain("if (!isSubscribed)");
      expect(onSuccessBody).toContain("router.push(subscribePath)");
    });

    it("已订阅时按是否已有 Agent 分流到控制台或创建引导", () => {
      expect(onSuccessBody).toContain("bots.length > 0 ? AGENTS_HOME_PATH : getAgentCreatingPath(true)");
    });

    it("不再无条件跳转控制台", () => {
      expect(onSuccessBody).not.toMatch(/onSuccess=\{\(\) => \{\s*router\.push\(AGENTS_HOME_PATH\);\s*\}\}/);
    });
  });
});
