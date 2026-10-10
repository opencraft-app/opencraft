import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let currentLanguage = "es";
let currentPathname = "/agents/skills";
let sessionAuthReady = true;
let sessionIsAuthenticated = false;

afterEach(() => {
  cleanup();
});

vi.mock("next/navigation", () => ({
  usePathname: () => currentPathname,
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
  bots: [] as Array<{ id: string }>,
  botsError: false,
  botsLoading: false,
  hasResolvedBots: true,
  hasResolvedPasses: true,
  isSubscribed: true,
  latestPass: null as object | null,
  passesError: false as false | string,
  passesLoading: false,
  refreshBots: vi.fn(),
  refreshPasses: vi.fn(),
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
    currentPathname = "/agents/skills";
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

  it("uses My AI Companion for English and switches the title back to Chinese", async () => {
    currentLanguage = "en-US";
    const { rerender } = render(
      <AppRouteShell requireAuth={false}>
        <div>Agent settings</div>
      </AppRouteShell>,
    );

    await waitFor(() => {
      expect(document.title).toBe("My AI Companion | LightVela");
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

    document.title = "My AI Companion | LightVela";

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
    currentPathname = "/agents";
    entitlement = {
      bots: [],
      botsError: false,
      botsLoading: false,
      hasResolvedBots: true,
      hasResolvedPasses: true,
      isSubscribed: true,
      latestPass: null,
      passesError: false,
      passesLoading: false,
      refreshBots: vi.fn(),
      refreshPasses: vi.fn(),
    };
    navigateMock.mockReset();
  });

  it("renders the console for a subscribed account", () => {
    const { container, queryByText } = renderGate();

    expect(queryByText("console")).toBeInTheDocument();
    expect(container.querySelector("div")).not.toBeNull();
  });

  it("sends a subscribed account without a Bot from a deep link to first creation", async () => {
    currentPathname = "/agents/skills";
    const { queryByText } = renderGate();

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/agents?create=1", { replace: true }));
    expect(queryByText("console")).not.toBeInTheDocument();
  });

  it("allows a deep link only after the server Bot list contains a Bot", () => {
    currentPathname = "/agents/skills";
    entitlement = { ...entitlement, bots: [{ id: "bot-1" }] };
    const { queryByText } = renderGate();

    expect(queryByText("console")).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("returns to the homepage before purchase", async () => {
    entitlement = { ...entitlement, isSubscribed: false };

    const { queryByText } = renderGate();

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/", { replace: true }));
    expect(queryByText("console")).not.toBeInTheDocument();
  });

  it("does not redirect while the entitlement snapshot is pending", () => {
    entitlement = { ...entitlement, hasResolvedPasses: false, passesLoading: true };

    renderGate();

    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("waits for the server Bot list before treating an empty account as new", () => {
    entitlement = { ...entitlement, isSubscribed: false, hasResolvedBots: false };
    renderGate();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("lets an expired subscriber reach the console on another device", () => {
    entitlement = { ...entitlement, isSubscribed: false, latestPass: { pass_id: "previous" } };
    const { queryByText } = renderGate();
    expect(queryByText("console")).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("returns an expired account without a Bot from a deep link to management home", async () => {
    currentPathname = "/agents/skills";
    entitlement = { ...entitlement, isSubscribed: false, latestPass: { pass_id: "previous" } };
    const { queryByText } = renderGate();

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/agents", { replace: true }));
    expect(queryByText("console")).not.toBeInTheDocument();
  });

  it("offers retry when the Bot list cannot be checked", () => {
    entitlement = { ...entitlement, isSubscribed: false, hasResolvedBots: false, botsError: true };
    const { getByRole } = renderGate();
    expect(navigateMock).not.toHaveBeenCalled();
    fireEvent.click(getByRole("button", { name: "重试" }));
    expect(entitlement.refreshBots).toHaveBeenCalledTimes(1);
  });

  it("does not kick an existing subscriber when the entitlement request fails", () => {
    entitlement = { ...entitlement, passesError: "boom" };

    const { getByRole } = renderGate();

    expect(navigateMock).not.toHaveBeenCalled();
    fireEvent.click(getByRole("button", { name: "重试" }));
    expect(entitlement.refreshPasses).toHaveBeenCalledTimes(1);
  });
});
