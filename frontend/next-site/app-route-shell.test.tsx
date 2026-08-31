import { render, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let currentLanguage = "es";

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
vi.mock("@/lib/region", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/region")>();
  return { ...actual, isGlobal: true };
});
vi.mock("./next-app-navigation", () => ({
  NextAppNavigationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { AppRouteShell } from "./app-route-shell";

describe("AppRouteShell document metadata", () => {
  beforeEach(() => {
    currentLanguage = "es";
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
