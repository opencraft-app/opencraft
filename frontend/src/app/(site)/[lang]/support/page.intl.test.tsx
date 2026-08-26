import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
vi.mock("@next-site/support-page-client", () => ({
  SupportPageClient: (props: unknown) => React.createElement("support-page", props as object),
}));

vi.stubGlobal("React", React);

describe("localized support route", () => {
  it("publishes the Spanish support page with localized metadata", async () => {
    vi.stubEnv("NEXT_PUBLIC_REGION", "global");
    vi.resetModules();
    const route = await import("./page.intl");

    expect(route.generateStaticParams()).toContainEqual({ lang: "es" });
    await expect(route.generateMetadata({ params: Promise.resolve({ lang: "es" }) })).resolves.toMatchObject({
      title: expect.stringContaining("Ayuda"),
      robots: expect.objectContaining({ index: false }),
    });
    expect(React.isValidElement(await route.default({ params: Promise.resolve({ lang: "es" }) }))).toBe(true);
  });
});
