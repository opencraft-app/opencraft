import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { registerHooks } from "node:module";
import { MemoryUiPreferenceStore, UiPreferencesRuntime } from "@opencraft/ui-preferences";
import type { ServerSpaceCommand, ServerSpaceMember } from "@opencraft/appserver-protocol/server-spaces";

const styles = registerHooks({ load(url, context, next) { return /\.(?:css|scss)$/u.test(new URL(url).pathname) ? { format: "module", source: "export default {};", shortCircuit: true } : next(url, context); } });
const { WorkbenchIntlProvider, WorkbenchLocaleController } = await import("../../apps/workbench-web/src/i18n/workbench-locale");
const { UiPreferencesProvider } = await import("../../apps/workbench-web/src/runtime/ui-preferences-runtime");
const { ServerSpacesContent } = await import("../../apps/workbench-web/src/components/server-spaces-sidebar");
styles.deregister();
type Controller = Parameters<typeof ServerSpacesContent>[0]["controller"];

async function mount(role: "owner" | "member") {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://opencraft.invalid/" });
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT, React: (globalThis as { React?: unknown }).React };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, React });
  const space = { id: "team", name: "Team", role, memberCount: 2, openContact: true };
  let members: ServerSpaceMember[] = [
    { actorId: "alice", displayName: "Alice", role: "owner", kind: "human" },
    { actorId: "bob", displayName: "Bob", role: "member", kind: "human" },
  ];
  const commands: ServerSpaceCommand[] = [];
  const controller = {
    ownerKey: "k", selected: "team", directory: { actorId: "alice", spaces: [space], assignments: [] }, error: null,
    refresh: async () => undefined, select: async () => true, members: async () => members,
    command: async (command: ServerSpaceCommand) => {
      commands.push(command);
      if (command.action === "bots") return { bots: [{ actorId: "alan", displayName: "Alan" }] };
      if (command.action === "addBot") members = [...members, { actorId: "alan", displayName: "Alan", role: "member", kind: "session" }];
      if (command.action === "contact") space.openContact = command.open;
      return {};
    },
  } as unknown as Controller;
  const preferences = await UiPreferencesRuntime.open({ installation: new MemoryUiPreferenceStore() });
  const locale = new WorkbenchLocaleController(preferences, { ideLocale: "en-US" });
  await locale.initialize();
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = () => root.render(<UiPreferencesProvider runtime={preferences}><WorkbenchIntlProvider controller={locale} target={dom.window.document.documentElement}>
    <ServerSpacesContent controller={controller} open={false} onSelected={() => undefined} onClose={() => undefined} />
  </WorkbenchIntlProvider></UiPreferencesProvider>);
  await React.act(async () => render());
  const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
  const detail = () => dom.window.document.querySelector("[data-server-depth='1']")!;
  const click = async (label: RegExp) => {
    const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find(b => label.test(b.textContent ?? "") && !b.closest("[inert]"));
    assert.ok(button, `button ${label}`);
    await React.act(async () => button.click());
    await settle();
  };
  return {
    commands, detail, click, settle, rerender: () => React.act(async () => render()),
    async close() { await React.act(async () => root.unmount()); Object.assign(globalThis, { window: previous.window, document: previous.document, IS_REACT_ACT_ENVIRONMENT: previous.act, React: previous.React }); },
  };
}

test("the owner sees the contact switch, adds an Agent and sees it labelled as one", async () => {
  const view = await mount("owner");
  try {
    await view.click(/^Members/);
    const toggle = view.detail().querySelector<HTMLButtonElement>("[role=switch]")!;
    assert.equal(toggle.getAttribute("aria-label"), "Members can contact each other");
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    await React.act(async () => toggle.click());
    await view.settle();
    assert.deepEqual(view.commands.at(-1), { action: "contact", spaceId: "team", open: false });

    await view.click(/^Add Agent$/);
    assert.deepEqual(view.commands.at(-1), { action: "bots", spaceId: "team" });
    assert.match(view.detail().textContent ?? "", /Alan/);
    await view.click(/^Add$/);
    assert.deepEqual(view.commands.at(-1), { action: "addBot", spaceId: "team", actorId: "alan" });
    const rows = [...view.detail().querySelectorAll(".server-spaces__members li")].map(li => li.textContent);
    assert.ok(rows.some(row => /Alan\s*Agent/.test(row ?? "")), "the new member is shown as an Agent");
  } finally { await view.close(); }
});

test("a member sees no owner controls", async () => {
  const view = await mount("member");
  try {
    await view.click(/^Members/);
    assert.equal(view.detail().querySelector("[role=switch]"), null);
    assert.ok(![...view.detail().querySelectorAll("button")].some(b => /Add Agent/.test(b.textContent ?? "")));
  } finally { await view.close(); }
});
