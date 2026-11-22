import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { registerHooks } from "node:module";
import { MemoryUiPreferenceStore, UiPreferencesRuntime } from "@opencraft/ui-preferences";
import type { CrewTeam } from "@opencraft/appserver-protocol";
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
const { CrewTeams } = await import("../../plugins/im/src/crew-teams");
// The settings dialog is loaded on demand; load it now so the test does not wait on a lazy chunk.
await import("../../plugins/im/src/crew-team-settings");
styles.deregister();

const member = (actorId: string, displayName: string, kind: "human" | "session", role: "owner" | "member" = "member") => ({ actorId, displayName, kind, role });
const team = (role: "owner" | "member", openContact = true): CrewTeam => ({ id: "team", name: "Growth", role, openContact,
  members: [member("alice", "Alice", "human", "owner"), member("bob", "Bob", "human"), member("alan", "Alan", "session"), member("zhe", "Zhe", "session")] });

async function mount(request: ChannelRpc["request"]) {
  dom.window.document.body.innerHTML = "<div id='root'></div>";
  const preferences = await UiPreferencesRuntime.open({ installation: new MemoryUiPreferenceStore() });
  const locale = new WorkbenchLocaleController(preferences, { ideLocale: "en-US" });
  await locale.initialize();
  const teamed: ReadonlySet<string>[] = [], rows: [string, boolean][] = [];
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => root.render(<UiPreferencesProvider runtime={preferences}><WorkbenchIntlProvider controller={locale} target={dom.window.document.documentElement}>
    <CrewTeams rpc={{ connect: async () => undefined, request } as unknown as ChannelRpc} signal={new AbortController().signal} reportError={() => undefined}
      onTeamed={ids => teamed.push(ids)} renderMember={(person, reachable, trailing) => { rows.push([person.displayName, reachable]); return <div className="row">{person.displayName}{trailing}</div>; }} />
  </WorkbenchIntlProvider></UiPreferencesProvider>));
  const settle = () => React.act(async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); });
  await settle();
  const doc = dom.window.document;
  return {
    settle, teamed, rows, text: () => doc.body.textContent ?? "",
    button: (name: RegExp) => [...doc.querySelectorAll<HTMLButtonElement>("button")].find(b => name.test(b.getAttribute("aria-label") ?? b.textContent ?? "")),
    switches: () => [...doc.querySelectorAll<HTMLButtonElement>("[role=switch]")],
    async close() { await React.act(async () => root.unmount()); },
  };
}

test("a member sees their team with its people and Agents, and no management", async () => {
  const view = await mount((async () => ({ teams: [team("member", false)] })) as unknown as ChannelRpc["request"]);
  try {
    assert.match(view.text(), /Growth/);
    assert.match(view.text(), /4 members/);
    assert.deepEqual(view.rows.slice(-4), [["Alice", false], ["Bob", false], ["Alan", true], ["Zhe", true]], "Agents are reachable; people only when the team allows contact");
    assert.deepEqual([...view.teamed.at(-1)!].sort(), ["alan", "alice", "bob", "zhe"]);
    assert.equal(view.button(/Manage Growth/), undefined);
    assert.ok(view.button(/Open Alan’s desk/), "an Agent row opens its desk");
  } finally { await view.close(); }
});

test("the owner manages contact and Agents from the team settings", async () => {
  const calls: unknown[] = [];
  let current = team("owner");
  const view = await mount((async (method: string, params: { action?: string; actorId?: string; open?: boolean }) => {
    if (method === "opencraft/crew/teams") return { teams: [current] };
    calls.push(params);
    if (params.action === "candidates") return { bots: [{ actorId: "nova", displayName: "Nova" }] };
    if (params.action === "contact") current = { ...current, openContact: params.open! };
    if (params.action === "removeAgent") current = { ...current, members: current.members.filter(m => m.actorId !== params.actorId) };
    if (params.action === "addAgent") current = { ...current, members: [...current.members, member(params.actorId!, "Nova", "session")] };
    if (method === "opencraft/crew/phonebook/list") return { entries: [], members: [], editable: true };
    return { teams: [current] };
  }) as unknown as ChannelRpc["request"]);
  try {
    await React.act(async () => view.button(/Manage Growth/)!.click());
    await view.settle();
    assert.match(view.text(), /Members can contact each other/);
    assert.match(view.text(), /Nova/, "the owner's own assistants not yet in a team can be added");
    await React.act(async () => view.switches()[0]!.click());
    await view.settle();
    assert.deepEqual(calls.find(c => (c as { action: string }).action === "contact"), { action: "contact", spaceId: "team", open: false });
    assert.equal(view.switches()[0]!.getAttribute("aria-checked"), "false");
    const remove = [...dom.window.document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].filter(b => b.textContent === "Remove");
    assert.equal(remove.length, 2, "only Agents can be removed here");
    await React.act(async () => remove[1]!.click());
    await view.settle();
    assert.deepEqual(calls.find(c => (c as { action: string }).action === "removeAgent"), { action: "removeAgent", spaceId: "team", actorId: "zhe" });
    await React.act(async () => [...dom.window.document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find(b => b.textContent === "Add")!.click());
    await view.settle();
    assert.deepEqual(calls.find(c => (c as { action: string }).action === "addAgent"), { action: "addAgent", spaceId: "team", actorId: "nova" });
    assert.match(view.text(), /3 members|4 members/);
  } finally { await view.close(); }
});

test("a Host without teams leaves the Members tab as it was", async () => {
  const view = await mount((async () => { throw Object.assign(Error("crew_teams_unavailable"), { status: 503 }); }) as unknown as ChannelRpc["request"]);
  try {
    assert.equal(view.text(), "");
    assert.equal(view.teamed.at(-1)?.size ?? 0, 0);
  } finally { await view.close(); }
});

test("with no team yet, the Members tab offers to start or join one", async () => {
  const view = await mount((async () => ({ teams: [] })) as unknown as ChannelRpc["request"]);
  try {
    assert.ok(view.button(/^New team$/));
    assert.ok(view.button(/^Join a team$/));
  } finally { await view.close(); }
});
