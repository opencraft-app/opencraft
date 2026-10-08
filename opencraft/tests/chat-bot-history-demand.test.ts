import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { BotTimelineUnit } from "@opencraft/bot-conversation";
import { useBotConversationViewport } from "../plugins/bot-chat/src/conversation-viewport";

const visible: BotTimelineUnit = { kind: "message", unitKey: "visible", occurredAtMs: 0, messageRuns: [] };
async function mount() {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const saved = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement,
    AbortController: globalThis.AbortController, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  dom.window.HTMLElement.prototype.scrollTo = function (options: ScrollToOptions) { this.scrollTop = options.top ?? 0; };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    AbortController: dom.window.AbortController, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  return { dom, root, async close() { await React.act(async () => root.unmount()); dom.window.close(); Object.assign(globalThis, saved); } };
}
function Fixture({ identity = "room-a", load, initiallyVisible = false }: {
  identity?: string; load: (page: number) => Promise<"empty" | "visible" | "end">; initiallyVisible?: boolean;
}) {
  const [page, setPage] = React.useState(0);
  const [units, setUnits] = React.useState<readonly BotTimelineUnit[]>(initiallyVisible ? [visible] : []);
  const [hasOlder, setHasOlder] = React.useState(true);
  const viewport = useBotConversationViewport(identity, units, {
    enabled: true, hasOlder, loadingOlder: false,
    loadOlder: async () => {
      const next = await load(page);
      setPage((value) => value + 1);
      if (next === "visible") setUnits([visible]);
      if (next === "end") setHasOlder(false);
    },
  });
  return React.createElement("div", { ref: viewport.transcriptRef, "data-units": units.length, "data-pages": page },
    viewport.historyLoading ? React.createElement("p", null, "Loading earlier messages…") : null,
    viewport.historyError ? React.createElement("p", { role: "alert" }, viewport.historyError) : null,
    hasOlder && !viewport.historyLoading ? React.createElement("button", { onClick: viewport.requestOlderHistory },
      viewport.historyError ? "Try again" : "Load earlier messages") : null);
}

test("zero visible Bot units advance multiple older pages without a physical scroll", async () => {
  const view = await mount();
  let calls = 0;
  try {
    await React.act(async () => view.root.render(React.createElement(Fixture, { load: async () => ++calls === 3 ? "visible" : "empty" })));
    assert.equal(calls, 3);
    assert.equal(view.dom.window.document.querySelector("[data-units]")?.getAttribute("data-units"), "1");
  } finally { await view.close(); }
});

test("Bot empty history demand survives React effect-owner rehearsal without duplicate requests", async () => {
  const view = await mount();
  let calls = 0;
  try {
    await React.act(async () => view.root.render(React.createElement(React.StrictMode, null,
      React.createElement(Fixture, { load: async () => ++calls === 3 ? "visible" : "empty" }))));
    assert.equal(calls, 3);
    assert.equal(view.dom.window.document.querySelector("[data-units]")?.getAttribute("data-units"), "1");
  } finally { await view.close(); }
});

test("empty Bot backfill has a bounded automatic budget and an explicit continuation", async () => {
  const view = await mount();
  let calls = 0;
  try {
    await React.act(async () => view.root.render(React.createElement(Fixture, { load: async () => { calls += 1; return "empty"; } })));
    assert.equal(calls, 3);
    const button = view.dom.window.document.querySelector("button")!;
    assert.equal(button.textContent, "Load earlier messages");
    await React.act(async () => button.click());
    assert.equal(calls, 6);
  } finally { await view.close(); }
});

test("Bot history failure stops automatic requests and exposes a working retry", async () => {
  const view = await mount();
  let calls = 0;
  try {
    await React.act(async () => view.root.render(React.createElement(Fixture, { load: async () => {
      if (++calls === 1) throw new Error("History unavailable");
      return "visible";
    } })));
    assert.equal(calls, 1);
    assert.equal(view.dom.window.document.querySelector("[role=alert]")?.textContent, "Could not load earlier messages.");
    const button = view.dom.window.document.querySelector("button")!;
    assert.equal(button.textContent, "Try again");
    await React.act(async () => button.click());
    assert.equal(calls, 2);
    assert.equal(view.dom.window.document.querySelector("[role=alert]"), null);
  } finally { await view.close(); }
});

test("Bot history cancellation on identity replacement ignores late failure", async () => {
  const view = await mount();
  let reject!: (error: Error) => void;
  const pending = new Promise<"empty">((_resolve, fail) => { reject = fail; });
  try {
    await React.act(async () => view.root.render(React.createElement(Fixture, { load: () => pending })));
    await React.act(async () => view.root.render(React.createElement(Fixture, { identity: "room-b", initiallyVisible: true,
      key: "room-b", load: async () => "visible" })));
    await React.act(async () => reject(new Error("Late old room failure")));
    assert.equal(view.dom.window.document.querySelector("[role=alert]"), null);
    assert.equal(view.dom.window.document.querySelector("[data-units]")?.getAttribute("data-units"), "1");
  } finally { await view.close(); }
});
