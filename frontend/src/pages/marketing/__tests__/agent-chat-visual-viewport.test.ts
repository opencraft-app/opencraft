import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { agentChatPageMinHeightClass, bindChatVisualViewportHeight } from "../agent-chat-visual-viewport";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function viewportFixture() {
  const viewport = Object.assign(new EventTarget(), { height: 714, offsetTop: 0, pageTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  const page = document.createElement("div");
  let pageTop = 0;
  let bodyTop = 0;
  let rootHeight = 714;
  vi.spyOn(page, "getBoundingClientRect").mockImplementation(() => ({ top: pageTop }) as DOMRect);
  vi.spyOn(document.body, "getBoundingClientRect").mockImplementation(() => ({ top: bodyTop }) as DOMRect);
  vi.spyOn(document.documentElement, "getBoundingClientRect").mockImplementation(() => ({ height: rootHeight }) as DOMRect);
  const stop = bindChatVisualViewportHeight(page);
  return {
    viewport, page, stop,
    setPageShift(shift: number) {
      pageTop = bodyTop = -shift;
      vi.stubGlobal("scrollY", shift);
    },
    setRootHeight(height: number) { rootHeight = height; },
    height() { return Number.parseInt(page.style.getPropertyValue("--lv-agent-chat-viewport-height"), 10); },
  };
}

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

it.each(["resize-first", "page-scroll-first"])("keeps the same screen edge when keyboard opens %s", (order) => {
  const f = viewportFixture();
  f.viewport.height = 376;
  if (order === "resize-first") {
    f.viewport.dispatchEvent(new Event("resize"));
    expect(f.height()).toBe(376);
  }
  f.setPageShift(338);
  window.dispatchEvent(new Event("scroll"));
  expect(f.height()).toBe(714);
  expect(f.height() - 338).toBe(376);
  f.viewport.pageTop = 338;
  f.viewport.offsetTop = 338;
  f.viewport.dispatchEvent(new Event("scroll"));
  expect(f.height() - 338).toBe(376);
  f.stop();
});

it.each(["pageTop-late", "scrollY-late", "both-late"])("bounds keyboard close when %s", (order) => {
  const f = viewportFixture();
  f.setPageShift(338);
  f.viewport.height = 376;
  f.viewport.pageTop = 338;
  f.viewport.dispatchEvent(new Event("resize"));
  f.viewport.height = 714;
  if (order !== "scrollY-late") f.setPageShift(0);
  if (order === "scrollY-late") f.viewport.pageTop = 0;
  if (order === "both-late") f.setPageShift(338);
  f.viewport.dispatchEvent(new Event("resize"));
  expect(f.height()).toBe(714);
  f.setPageShift(0);
  f.viewport.pageTop = 0;
  f.viewport.dispatchEvent(new Event("scroll"));
  expect(f.height()).toBe(714);
  f.stop();
});

it("keeps visual-only pan, clamps negative heights, and measures the current allocation on window resize", () => {
  const f = viewportFixture();
  f.viewport.height = 390;
  f.viewport.pageTop = 55;
  f.viewport.dispatchEvent(new Event("scroll"));
  expect(f.height()).toBe(445);
  f.viewport.pageTop = 0;
  f.viewport.height = 390;
  f.setRootHeight(350);
  window.dispatchEvent(new Event("resize"));
  expect(f.height()).toBe(350);
  f.viewport.height = -10;
  f.viewport.dispatchEvent(new Event("resize"));
  expect(f.height()).toBe(0);
  f.stop();
});

it("preserves browser zoom layout and releases every listener on disposal", () => {
  const f = viewportFixture();
  f.viewport.scale = 2;
  f.viewport.height = 357;
  f.viewport.dispatchEvent(new Event("resize"));
  expect(f.page.style.getPropertyValue("--lv-agent-chat-viewport-height")).toBe("");
  f.viewport.scale = 1;
  f.viewport.height = 714;
  f.viewport.dispatchEvent(new Event("resize"));
  expect(f.height()).toBe(714);
  f.stop();
  window.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new Event("scroll"));
  f.viewport.dispatchEvent(new Event("resize"));
  f.viewport.dispatchEvent(new Event("scroll"));
  expect(f.page.style.getPropertyValue("--lv-agent-chat-viewport-height")).toBe("");
});
