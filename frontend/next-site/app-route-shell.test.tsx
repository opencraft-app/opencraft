import { cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let currentLanguage = "es";
let sessionAuthReady = true;
let sessionIsAuthenticated = false;

afterEach(() => {
  cleanup();
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/agents/skills",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ i18n: { language: currentLanguage } }),
  };
});

vi.mock("@/observability/rum-user-bridge", () => ({ RumUserBridge: () => null }));
vi.mock("@/theme/theme-style", () => ({ ThemeStyleInjector: () => null }));
vi.mock("@/components/site/legal-footer", () => ({
  LegalFooter: () => <footer data-testid="legal-footer" />,
}));
vi.mock("@/components/site/login-modal", () => ({ LoginModal: () => null }));
vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    authReady: sessionAuthReady,
    isAuthenticated: sessionIsAuthenticated,
  }),
}));

const navigateMock = vi.hoisted(() => vi.fn());
let entitlement = {
  hasResolvedPasses: true,
  isSubscribed: true,
  passesError: false as false | string,
  passesLoading: false,
};

vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => entitlement,
}));
vi.mock("@/lib/app-navigation", () => ({ useAppNavigate: () => navigateMock }));
vi.mock("@/i18n/t", () => ({ useT: () => (key: string) => key }));
vi.mock("@/lib/region", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/region")>();
  return { ...actual, isGlobal: true };
});
vi.mock("./next-app-navigation", () => ({
  NextAppNavigationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { AppRouteShell, NextAgentEntitlementGate } from "./app-route-shell";

describe("AppRouteShell document metadata", () => {
  beforeEach(() => {
    currentLanguage = "es";
    sessionAuthReady = true;
    sessionIsAuthenticated = false;
    document.title = "Agent Console | LightVela";
    document.documentElement.lang = "en-US";
  });

  it("uses Spanish title and html lang for an unprefixed product route", async () => {
    render(
      <AppRouteShell requireAuth={false}>
        <div>Contenido</div>
      </AppRouteShell>,
    );

    await waitFor(() => {
      expect(document.title).toContain("Habilidades");
      expect(document.documentElement.lang).toBe("es");
    });
  });

  it("uses Japanese title and html lang for a future published product route", async () => {
    currentLanguage = "ja-JP";
    render(
      <AppRouteShell requireAuth={false}>
        <div>スキル</div>
      </AppRouteShell>,
    );

    await waitFor(() => {
      expect(document.title).toContain("スキル");
      expect(document.documentElement.lang).toBe("ja-JP");
    });
  });

  it("uses Korean title and html lang for a future published product route", async () => {
    currentLanguage = "ko-KR";
    render(
      <AppRouteShell requireAuth={false}>
        <div>스킬</div>
      </AppRouteShell>,
    );

    await waitFor(() => {
      expect(document.title).toContain("스킬");
      expect(document.documentElement.lang).toBe("ko-KR");
    });
  });

  it("uses My Agent for English and switches the title back to Chinese", async () => {
    currentLanguage = "en-US";
    const { rerender } = render(
      <AppRouteShell requireAuth={false}>
        <div>Agent settings</div>
      </AppRouteShell>,
    );

    await waitFor(() => {
      expect(document.title).toBe("My Agent | LightVela");
      expect(document.documentElement.lang).toBe("en-US");
    });

    currentLanguage = "zh-CN";
    rerender(
      <AppRouteShell requireAuth={false}>
        <div>智能体设置</div>
      </AppRouteShell>,
    );

    await waitFor(() => {
      expect(document.title).toBe("我的智能体伙伴 | LightVela");
      expect(document.documentElement.lang).toBe("zh-CN");
    });

    document.title = "My Agent | LightVela";

    await waitFor(() => {
      expect(document.title).toBe("我的智能体伙伴 | LightVela");
      expect(document.head.querySelectorAll("title")).toHaveLength(1);
    });
  });
});

describe("AppRouteShell auth-gate footer", () => {
  it("keeps the auth-gate footer by default", () => {
    const { container } = render(
      <AppRouteShell>
        <div>private</div>
      </AppRouteShell>,
    );

    expect(container.querySelector('[data-testid="legal-footer"]')).toBeInTheDocument();
  });

  it("can omit the auth-gate footer for app-style routes", () => {
    const { container } = render(
      <AppRouteShell showAuthGateFooter={false}>
        <div>private</div>
      </AppRouteShell>,
    );

    expect(container.querySelector('[data-testid="legal-footer"]')).not.toBeInTheDocument();
  });
});

describe("NextAgentEntitlementGate", () => {
  const renderGate = () =>
    render(
      <NextAgentEntitlementGate loadingFallback={<div>loading</div>}>
        <div>console</div>
      </NextAgentEntitlementGate>,
    );

  beforeEach(() => {
    entitlement = {
      hasResolvedPasses: true,
      isSubscribed: true,
      passesError: false,
      passesLoading: false,
    };
    navigateMock.mockReset();
  });

  it("renders the console for a subscribed account", () => {
    const { container, queryByText } = renderGate();

    expect(queryByText("console")).toBeInTheDocument();
    expect(container.querySelector("div")).not.toBeNull();
  });

  it("redirects to the subscribe page before purchase", async () => {
    entitlement = { ...entitlement, isSubscribed: false };

    const { queryByText } = renderGate();

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/subscribe", { replace: true }));
    expect(queryByText("console")).not.toBeInTheDocument();
  });

  it("does not redirect while the entitlement snapshot is pending", () => {
    entitlement = { ...entitlement, hasResolvedPasses: false, passesLoading: true };

    renderGate();

    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("does not kick an existing subscriber when the entitlement request fails", () => {
    entitlement = { ...entitlement, passesError: "boom" };

    renderGate();

    expect(navigateMock).not.toHaveBeenCalled();
  });
});
