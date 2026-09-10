import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { describe, expect, it, vi } from "vitest";

const readSettingsPageSource = () =>
  readFileSync(join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"), "utf8");

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
  it("passes the active Bot Profile to advanced settings", () => {
    const page = readSettingsPageSource();
    const panelStart = page.indexOf("<AgentCommonSettingsPanel");
    const panelEnd = page.indexOf('{activeSection === "files"');
    expect(panelStart).toBeGreaterThanOrEqual(0);
    expect(panelEnd).toBeGreaterThan(panelStart);
    const panel = page.slice(panelStart, panelEnd);

    expect(panel).toContain("botId={activeBot.id}");
    expect(panel).toContain("profileId={activeBot.profileId}");
  });

  it("generates and resolves the settings route on the domestic site", async () => {
    const { notFound, route } = await loadRoute(false);

    expect(route.generateStaticParams()).toContainEqual({ section: "settings" });
    await expect(route.default({ params: Promise.resolve({ section: "settings" }) })).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("generates and resolves the settings route on the global site", async () => {
    const { notFound, route } = await loadRoute(true);

    expect(route.generateStaticParams()).toContainEqual({ section: "settings" });
    await expect(route.default({ params: Promise.resolve({ section: "settings" }) })).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("生成并解析 websites 路由（国内国际均可用，不再 global-only）", async () => {
    const domestic = await loadRoute(false);

    expect(domestic.route.generateStaticParams()).toContainEqual({ section: "channels" });
    expect(domestic.route.generateStaticParams()).toContainEqual({ section: "websites" });
    await expect(domestic.route.default({ params: Promise.resolve({ section: "websites" }) })).resolves.toBeTruthy();
    expect(domestic.notFound).not.toHaveBeenCalled();

    const global = await loadRoute(true);

    expect(global.route.generateStaticParams()).toContainEqual({ section: "channels" });
    expect(global.route.generateStaticParams()).toContainEqual({ section: "websites" });
    await expect(global.route.default({ params: Promise.resolve({ section: "websites" }) })).resolves.toBeTruthy();
    expect(global.notFound).not.toHaveBeenCalled();
  });
});
