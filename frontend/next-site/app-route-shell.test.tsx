import { render, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/agents/skills",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ i18n: { language: "es" } }),
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
});
