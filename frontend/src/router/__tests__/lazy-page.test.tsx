import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { lazyNamed, lazyRoute } from "../lazy-page";

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
});
