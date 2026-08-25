import React from "react";
import { describe, expect, it, vi } from "vitest";

const loadRoute = async (isGlobal: boolean) => {
  vi.resetModules();
  vi.stubGlobal("React", React);
  const notFound = vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  vi.doMock("@/lib/region", () => ({ isGlobal }));
  vi.doMock("next/navigation", () => ({ notFound }));
  vi.doMock("@next-site/agents-page-client", () => ({ AgentsPageClient: () => null }));

  const route = await import("@/app/(site)/agents/[section]/page.next");
  return { notFound, route };
};

describe("Agent common settings region boundary", () => {
  it("generates and resolves the settings route on the domestic site", async () => {
    const { notFound, route } = await loadRoute(false);

    expect(route.generateStaticParams()).toContainEqual({ section: "settings" });
    await expect(route.default({ params: Promise.resolve({ section: "settings" }) })).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("omits the settings route and rejects direct access on the global site", async () => {
    const { notFound, route } = await loadRoute(true);

    expect(route.generateStaticParams()).not.toContainEqual({ section: "settings" });
    await expect(route.default({ params: Promise.resolve({ section: "settings" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });
});
