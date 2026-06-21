import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { lazyNamed, lazyRoute } from "../lazy-page";

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => text,
}));

vi.mock("@/lib/region", () => ({
  isGlobal: false,
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    isAuthenticated: false,
  }),
}));

vi.mock("@/components/site/brand-mark", () => ({
  BrandMark: () => <a href="/">LightVela</a>,
}));

vi.mock("@/components/site/legal-footer", () => ({
  LegalFooter: () => <footer>legal footer</footer>,
}));

vi.mock("@/components/site/language-switcher", () => ({
  LanguageSwitcher: () => null,
}));

vi.mock("@/components/site/user-avatar-menu", () => ({
  UserAvatarMenu: () => null,
}));

describe("lazy route helpers", () => {
  it("loads named page exports behind the shared route fallback", async () => {
    function DeferredPage() {
      return <div>Deferred page loaded</div>;
    }

    let resolveModule!: (module: { DeferredPage: typeof DeferredPage }) => void;
    const modulePromise = new Promise<{ DeferredPage: typeof DeferredPage }>((resolve) => {
      resolveModule = resolve;
    });

    const LazyPage = lazyNamed(
      async () => modulePromise,
      "DeferredPage",
    );

    render(lazyRoute(LazyPage));

    expect(screen.queryByText("Deferred page loaded")).not.toBeInTheDocument();
    await act(async () => {
      resolveModule({ DeferredPage });
      await modulePromise;
    });
    expect(await screen.findByText("Deferred page loaded")).toBeInTheDocument();
  });

  it("renders custom route fallback while the page chunk is pending", async () => {
    function DeferredPage() {
      return <div>Custom fallback page loaded</div>;
    }

    let resolveModule!: (module: { DeferredPage: typeof DeferredPage }) => void;
    const modulePromise = new Promise<{ DeferredPage: typeof DeferredPage }>((resolve) => {
      resolveModule = resolve;
    });

    const LazyPage = lazyNamed(
      async () => modulePromise,
      "DeferredPage",
    );

    render(lazyRoute(LazyPage, { fallback: <div>Route fallback visible</div> }));

    expect(screen.getByText("Route fallback visible")).toBeInTheDocument();
    await act(async () => {
      resolveModule({ DeferredPage });
      await modulePromise;
    });
    expect(await screen.findByText("Custom fallback page loaded")).toBeInTheDocument();
  });

  it("renders product chrome for product route fallbacks", async () => {
    function DeferredPage() {
      return <div>Product page loaded</div>;
    }

    let resolveModule!: (module: { DeferredPage: typeof DeferredPage }) => void;
    const modulePromise = new Promise<{ DeferredPage: typeof DeferredPage }>((resolve) => {
      resolveModule = resolve;
    });

    const LazyPage = lazyNamed(
      async () => modulePromise,
      "DeferredPage",
    );

    render(
      <MemoryRouter>
        {lazyRoute(LazyPage, { chrome: "product" })}
      </MemoryRouter>,
    );

    expect(screen.getByText("返回首页")).toBeInTheDocument();
    expect(screen.getByText("legal footer")).toBeInTheDocument();
    expect(screen.queryByText("Product page loaded")).not.toBeInTheDocument();

    await act(async () => {
      resolveModule({ DeferredPage });
      await modulePromise;
    });
    expect(await screen.findByText("Product page loaded")).toBeInTheDocument();
  });
});
