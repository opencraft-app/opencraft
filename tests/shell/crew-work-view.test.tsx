import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { registerHooks } from "node:module";
import { MemoryUiPreferenceStore, UiPreferencesRuntime } from "@opencraft/ui-preferences";
import type { CrewInboxItem } from "@opencraft/appserver-protocol";
import type { ChannelRpc } from "../../plugins/im/src/channel-client";

const styles = registerHooks({
  load(url, context, next) {
    return /\.(?:css|scss)$/u.test(new URL(url).pathname)
      ? { format: "module", source: "export default {};", shortCircuit: true }
      : next(url, context);
  },
});
const { WorkbenchIntlProvider, WorkbenchLocaleController } =
  await import("../../apps/workbench-web/src/i18n/workbench-locale");
const { UiPreferencesProvider } = await import("../../apps/workbench-web/src/runtime/ui-preferences-runtime");
const { CrewWorkList } = await import("../../plugins/im/src/crew-work-view");
styles.deregister();

const person = (actorId: string, displayName: string, kind: "human" | "session" = "human") => ({
  actorId,
  displayName,
  kind,
});
const alan = person("alan", "Alan", "session"),
  bob = person("bob", "Bob"),
  alice = person("alice", "Alice");
const item = (
  id: string,
  over: Partial<CrewInboxItem["work"]> = {},
  waiting: CrewInboxItem["waiting"] = null,
  updatedAt = Date.now(),
): CrewInboxItem => ({
  work: {
    id,
    state: "open",
    origin: "member",
    assigneeId: "alan",
    requesterId: "bob",
    parentId: null,
    rootId: id,
    messageId: "m",
    chain: [bob, alice],
    budget: { used: 0, limit: 8 },
    request: "Release notes for 2.3\nwith details",
    openChildren: 0,
    assignee: alan,
    ...over,
  },
  waiting,
  updatedAt,
});

async function mount(request: ChannelRpc["request"]) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    React: (globalThis as { React?: unknown }).React,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    React,
  });
  const preferences = await UiPreferencesRuntime.open({ installation: new MemoryUiPreferenceStore() });
  const locale = new WorkbenchLocaleController(preferences, { ideLocale: "en-US" });
  await locale.initialize();
  const opened: string[] = [],
    errors: string[] = [],
    life = new AbortController();
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () =>
    root.render(
      <UiPreferencesProvider runtime={preferences}>
        <WorkbenchIntlProvider controller={locale} target={dom.window.document.documentElement}>
          <CrewWorkList
            rpc={{ connect: async () => undefined, request } as unknown as ChannelRpc}
            signal={life.signal}
            placeholder={<p>loading</p>}
            onOpenChat={(id) => opened.push(id)}
            reportError={(e) => errors.push(e.message)}
          />
        </WorkbenchIntlProvider>
      </UiPreferencesProvider>,
    ),
  );
  const settle = () =>
    React.act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  await settle();
  return {
    opened,
    errors,
    settle,
    headings: () => [...dom.window.document.querySelectorAll("h3")].map((h) => h.textContent),
    rows: () => [...dom.window.document.querySelectorAll<HTMLButtonElement>(".people-group")],
    text: () => dom.window.document.body.textContent ?? "",
    async close() {
      life.abort();
      await React.act(async () => root.unmount());
      Object.assign(globalThis, {
        window: previous.window,
        document: previous.document,
        IS_REACT_ACT_ENVIRONMENT: previous.act,
        React: previous.React,
      });
    },
  };
}

test("work is grouped by what needs the reader, and opens the conversation with whoever asked", async () => {
  const calls: unknown[] = [];
  const view = await mount((async (method: string, params: { actorId: string }) => {
    calls.push([method, params]);
    if (method === "opencraft/crew/work/inbox")
      return {
        items: [
          item("w1", {}, { from: alan, content: "2.3 or 2.3.1?", at: Date.now() }),
          item("w2", { openChildren: 2, request: null }),
          item("w3", { state: "closed" }),
        ],
      };
    if (method === "opencraft/channels/direct/open") return { id: "dm-" + params.actorId };
    throw Error(method);
  }) as unknown as ChannelRpc["request"]);
  try {
    assert.deepEqual(view.headings(), ["Waiting on you", "In progress", "Done recently"]);
    assert.match(view.text(), /Release notes for 2\.3/);
    assert.doesNotMatch(view.text(), /with details/, "only the first line titles a row");
    assert.match(view.text(), /Alan: 2\.3 or 2\.3\.1\?/);
    assert.match(view.text(), /Work for Alan/);
    assert.match(view.text(), /Handed 2 parts on/);
    await React.act(async () => view.rows()[0]!.click());
    await view.settle();
    assert.deepEqual(view.opened, ["dm-alan"]);
  } finally {
    await view.close();
  }
});

test("an empty Inbox explains how work starts; a failed open reports without moving the list", async () => {
  const empty = await mount((async () => ({ items: [] })) as unknown as ChannelRpc["request"]);
  try {
    assert.match(empty.text(), /No work yet/);
  } finally {
    await empty.close();
  }
  const again = await mount((async (method: string) => {
    if (method === "opencraft/crew/work/inbox") return { items: [item("w1")] };
    throw Object.assign(Error("channel_denied"), { status: 403 });
  }) as unknown as ChannelRpc["request"]);
  try {
    await React.act(async () => again.rows()[0]!.click());
    await again.settle();
    assert.deepEqual(again.errors, ["Could not open this conversation."]);
    assert.equal(again.rows().length, 1);
    assert.equal(again.rows()[0]!.disabled, false, "the row is usable again");
  } finally {
    await again.close();
  }
});
