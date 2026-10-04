import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { agentChatPageMinHeightClass, bindChatVisualViewportHeight } from "../agent-chat-visual-viewport";

afterEach(() => vi.unstubAllGlobals());

it("allows embedded chat to shrink without removing ordinary pages' viewport minimum", () => {
  expect(agentChatPageMinHeightClass(true)).toBe("min-h-0");
  expect(agentChatPageMinHeightClass(false)).toBe("min-h-dvh");
});

it("uses the viewport minimum selector on the root that owns the height binding", () => {
  const source = readFileSync(resolve(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"), "utf8");
  const rootClasses = source.match(/ref=\{chatPageRef\}[\s\S]*?style=/)?.[0];
  expect(rootClasses).toContain("agentChatPageMinHeightClass(useMobileChatLayout)");
  expect(rootClasses).not.toContain("min-h-dvh");
});

it("retains the CSS fallback when visualViewport is unavailable", () => {
  vi.stubGlobal("visualViewport", null);
  const page = document.createElement("div");
  const stop = bindChatVisualViewportHeight(page);
  expect(page.style.getPropertyValue("--lv-agent-chat-viewport-height")).toBe("");
  expect(() => stop()).not.toThrow();
});

it("keeps the chat bottom at the visible keyboard edge and restores its CSS fallback", () => {
  const viewport = Object.assign(new EventTarget(), { height: 700, offsetTop: 0, pageTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  const page = document.createElement("div");
  let pageTop = 0;
  let bodyTop = 0;
  vi.spyOn(page, "getBoundingClientRect").mockImplementation(() => ({ top: pageTop }) as DOMRect);
  vi.spyOn(document.body, "getBoundingClientRect").mockImplementation(() => ({ top: bodyTop }) as DOMRect);
  const stop = bindChatVisualViewportHeight(page);

  expect(page.style.getPropertyValue("--lv-agent-chat-viewport-height")).toBe("700px");

  viewport.height = 390;
  viewport.offsetTop = 40;
  viewport.pageTop = 40;
  viewport.dispatchEvent(new Event("resize"));
  expect(page.style.getPropertyValue("--lv-agent-chat-viewport-height")).toBe("430px");

  viewport.offsetTop = 55;
  viewport.pageTop = 55;
  viewport.dispatchEvent(new Event("scroll"));
  expect(page.style.getPropertyValue("--lv-agent-chat-viewport-height")).toBe("445px");

  // iOS WebViews can scroll the document to reveal a focused contenteditable.
  // The chat container must still end at the visible keyboard edge.
  pageTop = -180;
  bodyTop = -180;
  viewport.pageTop = 235;
  window.dispatchEvent(new Event("scroll"));
  const pageHeight = Number.parseInt(page.style.getPropertyValue("--lv-agent-chat-viewport-height"), 10);
  expect(pageTop + pageHeight).toBe(viewport.height + viewport.offsetTop);

  // Some WebKit WebViews pan the body without changing document scrollTop;
  // pageTop can then differ from offsetTop.
  pageTop = -84;
  bodyTop = -84;
  viewport.offsetTop = 55;
  viewport.pageTop = 84;
  viewport.dispatchEvent(new Event("scroll"));
  expect(page.style.getPropertyValue("--lv-agent-chat-viewport-height")).toBe("474px");

  pageTop = 0;
  bodyTop = 0;
  viewport.height = 700;
  viewport.offsetTop = 0;
  viewport.pageTop = 0;
  viewport.dispatchEvent(new Event("resize"));
  expect(page.style.getPropertyValue("--lv-agent-chat-viewport-height")).toBe("700px");

  stop();
  expect(page.style.getPropertyValue("--lv-agent-chat-viewport-height")).toBe("");
  window.dispatchEvent(new Event("scroll"));
  viewport.dispatchEvent(new Event("scroll"));
  expect(page.style.getPropertyValue("--lv-agent-chat-viewport-height")).toBe("");
});
