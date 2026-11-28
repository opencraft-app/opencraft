import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { registerHooks } from "node:module";
import { MemoryUiPreferenceStore, UiPreferencesRuntime } from "@opencraft/ui-preferences";
import type { CrewPhonebook as Phonebook } from "@opencraft/appserver-protocol";
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
const { CrewPhonebook } = await import("../../plugins/im/src/crew-phonebook");
styles.deregister();

const person = (actorId: string, displayName: string, kind: "human" | "session" = "human") => ({
  actorId,
  displayName,
  kind,
});

async function mount(rpc: Partial<ChannelRpc>, locale = "en-US") {
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
  const controller = new WorkbenchLocaleController(preferences, { ideLocale: locale });
  await controller.initialize();
  const errors: string[] = [];
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => {
    root.render(
      <UiPreferencesProvider runtime={preferences}>
        <WorkbenchIntlProvider controller={controller} target={dom.window.document.documentElement}>
          <CrewPhonebook
            rpc={{ connect: async () => undefined, ...rpc } as ChannelRpc}
            botId="bot"
            reportError={(e) => errors.push(e.message)}
          />
        </WorkbenchIntlProvider>
      </UiPreferencesProvider>,
    );
  });
  const settle = () =>
    React.act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  await settle();
  return {
    dom,
    errors,
    settle,
    text: () => dom.window.document.body.textContent ?? "",
    switches: () => [...dom.window.document.querySelectorAll<HTMLButtonElement>("[role=switch]")],
    async close() {
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

test("a Bot outside every Server shows no phonebook", async () => {
  const view = await mount({
    request: (async () => {
      throw Object.assign(Error("channel_denied"), { status: 403 });
    }) as ChannelRpc["request"],
  });
  try {
    assert.equal(view.text(), "");
  } finally {
    await view.close();
  }
});

test("the owner toggles one contact at a time; other rows stay usable", async () => {
  let book: Phonebook = {
    entries: [person("bob", "Bob")],
    members: [person("alice", "Alice"), person("bob", "Bob"), person("zhe", "Zhe", "session")],
    editable: true,
  };
  let release: (() => void) | undefined;
  const calls: unknown[] = [];
  const view = await mount({
    request: (async (method: string, params: { actorId: string; present: boolean }) => {
      if (method === "opencraft/crew/phonebook/list") return book;
      calls.push(params);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      book = { ...book, entries: [...book.entries, person(params.actorId, "Zhe", "session")] };
      return book;
    }) as unknown as ChannelRpc["request"],
  });
  try {
    assert.match(view.text(), /Contacts/);
    assert.match(view.text(), /Agent/);
    assert.deepEqual(
      view.switches().map((s) => s.getAttribute("aria-checked")),
      ["false", "true", "false"],
    );
    await React.act(async () => view.switches()[2]!.click());
    assert.deepEqual(calls, [{ botId: "bot", actorId: "zhe", present: true }]);
    assert.deepEqual(
      view.switches().map((s) => s.disabled),
      [false, false, true],
      "only the pending row waits",
    );
    await React.act(async () => {
      release!();
    });
    await view.settle();
    assert.deepEqual(
      view.switches().map((s) => [s.getAttribute("aria-checked"), s.disabled]),
      [
        ["false", false],
        ["true", false],
        ["true", false],
      ],
    );
  } finally {
    await view.close();
  }
});

test("members read the phonebook but cannot change it", async () => {
  const view = await mount(
    {
      request: (async () => ({
        entries: [],
        members: [person("alice", "Alice")],
        editable: false,
      })) as unknown as ChannelRpc["request"],
    },
    "zh-CN",
  );
  try {
    assert.match(view.text(), /协作联系名录/);
    assert.match(view.text(), /只有团队所有者可以修改协作联系名录/);
    assert.ok(view.switches().every((s) => s.disabled));
  } finally {
    await view.close();
  }
});
