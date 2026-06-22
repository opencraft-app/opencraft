import { describe, expect, it } from "vitest";

import {
  isPublicSiteDocumentPath,
  markAgentChatLoadedInDocument,
  shouldReloadForAgentChatNavigation,
} from "@/lib/agentchat-navigation-guard";

describe("agentchat-navigation-guard", () => {
  it("recognizes public site document paths", () => {
    expect(isPublicSiteDocumentPath("/")).toBe(true);
    expect(isPublicSiteDocumentPath("/docs/overview")).toBe(true);
    expect(isPublicSiteDocumentPath("/en-us/docs/overview")).toBe(true);
    expect(isPublicSiteDocumentPath("/zh-sg/about")).toBe(true);
    expect(isPublicSiteDocumentPath("/changelog")).toBe(true);
    expect(isPublicSiteDocumentPath("/agents")).toBe(false);
    expect(isPublicSiteDocumentPath("/account")).toBe(false);
    expect(isPublicSiteDocumentPath("/subscribe")).toBe(false);
  });

  it("only reloads public site navigation after AgentChat has loaded in the document", () => {
    expect(shouldReloadForAgentChatNavigation("/")).toBe(false);

    markAgentChatLoadedInDocument();

    expect(shouldReloadForAgentChatNavigation("/")).toBe(true);
    expect(shouldReloadForAgentChatNavigation("/docs/overview")).toBe(true);
    expect(shouldReloadForAgentChatNavigation("/about?from=agents")).toBe(true);
    expect(shouldReloadForAgentChatNavigation("/agents")).toBe(false);
    expect(shouldReloadForAgentChatNavigation("/account")).toBe(false);
    expect(shouldReloadForAgentChatNavigation("https://example.com/docs/overview")).toBe(false);
  });
});
