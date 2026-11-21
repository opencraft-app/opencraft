import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { registerHooks } from "node:module";
import { MemoryUiPreferenceStore, UiPreferencesRuntime } from "@opencraft/ui-preferences";
import type { CrewDesk as Desk } from "@opencraft/appserver-protocol";
import type { ChannelRpc } from "../../plugins/im/src/channel-client";

// Radix decides at import time whether a DOM exists, so the document is installed before any import.
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, React, ResizeObserver });
Object.assign(dom.window, { ResizeObserver });
for (const key of Object.getOwnPropertyNames(dom.window))
  if (!(key in globalThis)) { const value = (dom.window as never)[key] as unknown; Object.assign(globalThis, { [key]: typeof value === "function" && !/^[A-Z]/.test(key) ? (value as Function).bind(dom.window) : value }); }
// jsdom's own event classes replace Node's, or dispatching across the two fails.
for (const key of ["Event", "CustomEvent", "EventTarget", "KeyboardEvent", "FocusEvent", "MouseEvent", "PointerEvent", "AbortController", "AbortSignal"] as const)
  if (key in dom.window) Object.assign(globalThis, { [key]: (dom.window as never)[key] });
// jsdom has no layout; the timeline's scroll calls only need to exist.
Object.assign(dom.window.HTMLElement.prototype, { scrollTo() {}, scrollIntoView() {} });
const styles = registerHooks({ load(url, context, next) { return /\.(?:css|scss)$/u.test(new URL(url).pathname) ? { format: "module", source: "export default {};", shortCircuit: true } : next(url, context); } });
const { WorkbenchIntlProvider, WorkbenchLocaleController } = await import("../../apps/workbench-web/src/i18n/workbench-locale");
const { UiPreferencesProvider } = await import("../../apps/workbench-web/src/runtime/ui-preferences-runtime");
const { CrewDesk } = await import("../../plugins/im/src/crew-desk");
styles.deregister();

const person = (actorId: string, displayName: string, kind: "human" | "session" = "human") => ({ actorId, displayName, kind });
const alan = person("alan", "Alan", "session"), bob = person("bob", "Bob"), alice = person("alice", "Alice"), zhe = person("zhe", "Zhe", "session");
const deskFor = (actor: typeof bob): Desk => ({
  environment: { kind: "local" }, model: null, contacts: 1,
  conversations: [{ actor: bob, updatedAt: 2 }, { actor: alice, updatedAt: 1 }],
  selected: { actor, messages: [
    { id: actor.actorId + "-1", role: "user", text: `${actor.displayName}:\nplease`, at: 1, author: actor },
    { id: actor.actorId + "-2", role: "user", text: "Zhe:\nchecked", at: 2, author: zhe },
    { id: actor.actorId + "-3", role: "assistant", text: "done for " + actor.displayName, at: 3 },
  ], works: [{ id: "t", title: "Draft notes", status: "running", updatedAt: 3 }] },
});

async function mount(request: ChannelRpc["request"]) {
  dom.window.document.body.innerHTML = "<div id='root'></div>";
  const preferences = await UiPreferencesRuntime.open({ installation: new MemoryUiPreferenceStore() });
  const locale = new WorkbenchLocaleController(preferences, { ideLocale: "en-US" });
  await locale.initialize();
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => root.render(<UiPreferencesProvider runtime={preferences}><WorkbenchIntlProvider controller={locale} target={dom.window.document.documentElement}>
    <CrewDesk rpc={{ connect: async () => undefined, request } as unknown as ChannelRpc} bot={alan} open onOpenChange={() => undefined} />
  </WorkbenchIntlProvider></UiPreferencesProvider>));
  const settle = () => React.act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });
  await settle();
  return {
    settle, text: () => dom.window.document.body.textContent ?? "",
    item: (name: string) => [...dom.window.document.querySelectorAll<HTMLButtonElement>(".crew-desk__aside button")].find(b => b.textContent?.endsWith(name)),
    async close() { await React.act(async () => root.unmount()); },
  };
}

test("the desk shows its setup, the selected conversation with real authors, and its tasks", async () => {
  const asked: unknown[] = [];
  const view = await mount((async (_method: string, params: { actorId?: string }) => { asked.push(params); return deskFor(params.actorId === "alice" ? alice : bob); }) as unknown as ChannelRpc["request"]);
  try {
    assert.match(view.text(), /Alan’s desk/);
    assert.match(view.text(), /Host machine/);
    assert.match(view.text(), /Not selected/);
    assert.match(view.text(), /1 person/);
    assert.match(view.text(), /Draft notes/);
    assert.match(view.text(), /Working/);
    assert.deepEqual(asked[0], { botId: "alan" });
    await React.act(async () => view.item("Alice")!.click());
    await view.settle();
    assert.deepEqual(asked.at(-1), { botId: "alan", actorId: "alice" });
  } finally { await view.close(); }
});

test("a slow answer for a conversation already left does not replace the new one", async () => {
  let releaseBob: (() => void) | undefined, calls = 0;
  const view = await mount((async (_method: string, params: { actorId?: string }) => {
    calls++;
    if (calls === 1) return deskFor(bob);
    if (params.actorId === "bob") { await new Promise<void>(r => { releaseBob = r; }); return deskFor(bob); }
    return deskFor(alice);
  }) as unknown as ChannelRpc["request"]);
  try {
    // Ask for Bob again (slow), then switch to Alice before Bob's answer arrives.
    await React.act(async () => view.item("Bob")!.click());
    await React.act(async () => view.item("Alice")!.click());
    releaseBob?.();
    await view.settle();
    await new Promise(r => setTimeout(r, 0));
    await view.settle();
    assert.match(view.text(), /done for Alice/, "the switch is shown at once");
    assert.doesNotMatch(view.text(), /done for Bob/, "the late Bob answer was dropped");
  } finally { await view.close(); }
});

test("a stopped Agent says so instead of showing an empty desk", async () => {
  const view = await mount((async () => { throw Object.assign(Error("crew_desk_unavailable"), { code: "crew_desk_unavailable" }); }) as unknown as ChannelRpc["request"]);
  try { assert.match(view.text(), /This Agent is not running/); } finally { await view.close(); }
});
