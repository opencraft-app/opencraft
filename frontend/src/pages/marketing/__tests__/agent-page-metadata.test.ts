import React from "react";
import { describe, expect, it, vi } from "vitest";

async function loadAgentMetadata(isGlobal: boolean) {
  vi.resetModules();
  vi.stubGlobal("React", React);
  vi.doMock("@/lib/region", () => ({ isGlobal }));
  vi.doMock("next/navigation", () => ({ notFound: vi.fn() }));
  vi.doMock("@next-site/agents-page-client", () => ({ AgentsPageClient: () => null }));

  const [homeRoute, sectionRoute] = await Promise.all([
    import("@/app/(site)/agents/page.next"),
    import("@/app/(site)/agents/[section]/page.next"),
  ]);

  return {
    homeTitle: homeRoute.metadata.title,
    sectionTitle: sectionRoute.metadata.title,
  };
}

describe("Agent page metadata", () => {
  it("uses English titles in the international build", async () => {
    await expect(loadAgentMetadata(true)).resolves.toEqual({
      homeTitle: "My Agent",
      sectionTitle: "My Agent",
    });
  });

  it("keeps Chinese titles in the domestic build", async () => {
    await expect(loadAgentMetadata(false)).resolves.toEqual({
      homeTitle: "我的智能体伙伴",
      sectionTitle: "我的智能体伙伴",
    });
  });
});
