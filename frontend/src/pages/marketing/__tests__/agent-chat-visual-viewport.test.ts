import { afterEach, expect, it, vi } from "vitest";

import { bindChatVisualViewportHeight } from "../agent-chat-visual-viewport";

afterEach(() => vi.unstubAllGlobals());

it("keeps the chat bottom at the visible keyboard edge and restores its CSS fallback", () => {
  const viewport = Object.assign(new EventTarget(), { height: 700, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  const page = document.createElement("div");
  const stop = bindChatVisualViewportHeight(page);

  expect(page.style.getPropertyValue("--lv-agent-chat-viewport-height")).toBe("700px");

  viewport.height = 390;
  viewport.offsetTop = 40;
  viewport.dispatchEvent(new Event("resize"));
  expect(page.style.getPropertyValue("--lv-agent-chat-viewport-height")).toBe("430px");

  viewport.offsetTop = 55;
  viewport.dispatchEvent(new Event("scroll"));
  expect(page.style.getPropertyValue("--lv-agent-chat-viewport-height")).toBe("445px");

  stop();
  expect(page.style.getPropertyValue("--lv-agent-chat-viewport-height")).toBe("");
});
