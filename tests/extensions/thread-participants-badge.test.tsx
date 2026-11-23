import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { IdentityAvatarContext, useIdentityAvatarUrl } from "@opencraft/extension-react";
import zhCN from "../../apps/workbench-web/src/i18n/locales/zh-CN.json" with { type: "json" };
import type {
  ThreadParticipantsSnapshot,
  ThreadParticipantsSource,
} from "../../plugins/thread-participants/src/controller";

const styles = registerHooks({
  load(url, context, next) {
    return /\.(?:css|scss)$/u.test(new URL(url).pathname)
      ? { format: "module", source: "export default {};", shortCircuit: true }
      : next(url, context);
  },
});
const { createThreadParticipantsBadge, participantPeople } =
  await import("../../plugins/thread-participants/src/participants-badge");
styles.deregister();

function source(snapshot: ThreadParticipantsSnapshot, refreshed: string[] = []): ThreadParticipantsSource {
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    watch: () => () => {},
    refresh: (_host, thread) => {
      refreshed.push(thread);
    },
  };
}
const photos = { id: "test", resolve: (kind: string, name: string) => `https://photos.invalid/${kind}/${name}.png` };

async function render(
  contribution: ReturnType<typeof createThreadParticipantsBadge>,
  open: boolean,
  locale = "en-US",
  messages: Record<string, string> = {},
) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const domGlobals = [
    "HTMLElement",
    "Element",
    "Node",
    "NodeFilter",
    "MutationObserver",
    "Event",
    "CustomEvent",
    "FocusEvent",
    "KeyboardEvent",
    "MouseEvent",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const;
  const keys = [
    "window",
    "document",
    "IS_REACT_ACT_ENVIRONMENT",
    "React",
    "getComputedStyle",
    "ResizeObserver",
    ...domGlobals,
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, (globalThis as any)[key]]));
  // Radix measures the anchored popover; jsdom has no layout, so observation is inert.
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    React,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ...Object.fromEntries(
      domGlobals.map((key) => [
        key,
        typeof (dom.window as any)[key] === "function" && /^[a-z]/u.test(key)
          ? (dom.window as any)[key].bind(dom.window)
          : (dom.window as any)[key],
      ]),
    ),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  const changes: boolean[] = [];
  const root = createRoot(dom.window.document.getElementById("root")!);
  const { Component } = contribution;
  await React.act(async () =>
    root.render(
      <IntlProvider locale={locale} messages={messages} onError={() => {}}>
        <IdentityAvatarContext.Provider value={photos}>
          <Component
            hostId="host"
            threadId="thread"
            open={open}
            onOpenChange={(next) => changes.push(next)}
            portalContainer={dom.window.document.body}
          />
        </IdentityAvatarContext.Provider>
      </IntlProvider>,
    ),
  );
  return {
    dom,
    changes,
    async close() {
      await React.act(async () => root.unmount());
      dom.window.close();
      Object.assign(globalThis, previous);
    },
  };
}

test("people order puts a silent creator first and lists other participants once", () => {
  assert.deepEqual(participantPeople({ creator: "alice", participants: ["bob", "carol"] }), {
    creator: "alice",
    people: ["alice", "bob", "carol"],
    others: ["bob", "carol"],
  });
  assert.deepEqual(participantPeople({ creator: "bob", participants: ["bob", "carol"] }), {
    creator: "bob",
    people: ["bob", "carol"],
    others: ["carol"],
  });
  assert.deepEqual(participantPeople(null), { creator: null, people: [], others: [] });
});

test("the badge shows the latest participant photo from the installed resolver and a total", async () => {
  const view = await render(
    createThreadParticipantsBadge(
      "test",
      source({
        phase: "ready",
        data: { threadId: "thread", revision: 2, creator: "alice", participants: ["alice", "bob"] },
      }),
    ),
    false,
  );
  try {
    const button = view.dom.window.document.querySelector("button")!;
    assert.equal(button.getAttribute("aria-label"), "View conversation participants (2)");
    assert.ok(button.classList.contains("ui-disclosure-button"), "the trigger is the shared disclosure control");
    assert.equal(button.querySelector("img")?.getAttribute("src"), "https://photos.invalid/employee/bob.png");
    assert.equal(button.querySelector(".thread-participants__total")?.textContent, "2");
    assert.equal(view.dom.window.document.querySelector(".thread-participants__popover"), null);
  } finally {
    await view.close();
  }
});

test("the open popover lists the creator separately from the other participants", async () => {
  const view = await render(
    createThreadParticipantsBadge(
      "test",
      source({
        phase: "ready",
        data: { threadId: "thread", revision: 2, creator: "alice", participants: ["alice", "bob", "carol"] },
      }),
    ),
    true,
  );
  try {
    const popover = view.dom.window.document.querySelector(".thread-participants__popover")!;
    assert.ok(popover, "Radix renders the popover into the Shell portal");
    assert.equal(popover.querySelector(".thread-participants__creator-section")?.textContent, "Creatoralice");
    assert.deepEqual(
      [...popover.querySelectorAll("li")].map((item) => item.textContent),
      ["bob", "carol"],
    );
    assert.deepEqual(
      [...popover.querySelectorAll("li img")].map((image) => image.getAttribute("src")),
      ["https://photos.invalid/employee/bob.png", "https://photos.invalid/employee/carol.png"],
    );
  } finally {
    await view.close();
  }
});

test("loading, empty, failure and unsupported states keep their own slot", async () => {
  const loading = await render(createThreadParticipantsBadge("test", source({ phase: "loading", data: null })), true);
  try {
    const document = loading.dom.window.document;
    assert.equal(document.querySelector("[role=status]")?.textContent, "Loading…");
    assert.equal(document.querySelector("button img"), null, "no photo is invented while loading");
    assert.equal(document.querySelector("button")?.getAttribute("aria-label"), "View conversation participants");
  } finally {
    await loading.close();
  }
  const empty = await render(
    createThreadParticipantsBadge(
      "test",
      source({ phase: "ready", data: { threadId: "thread", revision: 0, participants: [], creator: null } }),
    ),
    true,
  );
  try {
    assert.match(
      empty.dom.window.document.querySelector(".thread-participants__popover")!.textContent!,
      /No identified participants yet/,
    );
  } finally {
    await empty.close();
  }
  const refreshed: string[] = [];
  const failed = await render(
    createThreadParticipantsBadge(
      "test",
      source(
        { phase: "error", data: { threadId: "thread", revision: 1, participants: ["bob"], creator: null } },
        refreshed,
      ),
    ),
    true,
  );
  try {
    const document = failed.dom.window.document;
    assert.deepEqual(
      [...document.querySelectorAll("li")].map((item) => item.textContent),
      ["bob"],
      "last verified rows stay visible",
    );
    const retry = [...document.querySelectorAll(".thread-participants__notice button")][0] as HTMLButtonElement;
    assert.equal(retry.textContent, "Retry");
    await React.act(async () => retry.click());
    assert.deepEqual(refreshed, ["thread"]);
  } finally {
    await failed.close();
  }
  const unsupported = await render(
    createThreadParticipantsBadge("test", source({ phase: "unsupported", data: null })),
    false,
  );
  try {
    assert.equal(
      unsupported.dom.window.document.getElementById("root")!.innerHTML,
      "",
      "an unsupported Host renders no badge",
    );
  } finally {
    await unsupported.close();
  }
});

test("copy follows the active locale catalog", async () => {
  const view = await render(
    createThreadParticipantsBadge(
      "test",
      source({ phase: "ready", data: { threadId: "thread", revision: 1, creator: "alice", participants: ["bob"] } }),
    ),
    true,
    "zh-CN",
    zhCN as Record<string, string>,
  );
  try {
    const popover = view.dom.window.document.querySelector(".thread-participants__popover")!;
    assert.deepEqual(
      [...popover.querySelectorAll(".thread-participants__heading")].map((node) => node.textContent),
      ["创建者", "参与者"],
    );
    assert.equal(view.dom.window.document.querySelector("button")!.getAttribute("aria-label"), "查看会话参与者（2）");
  } finally {
    await view.close();
  }
});

test("the avatar hook is provider-neutral and empty without a resolver", async () => {
  const seen: (string | null)[] = [];
  function Probe({ name }: { name: string | null }) {
    seen.push(useIdentityAvatarUrl("employee", name));
    return null;
  }
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await React.act(async () =>
      root.render(
        <>
          <Probe name="alice" />
          <IdentityAvatarContext.Provider value={photos}>
            <Probe name="alice" />
            <Probe name={null} />
          </IdentityAvatarContext.Provider>
        </>,
      ),
    );
    assert.deepEqual(seen, [null, "https://photos.invalid/employee/alice.png", null]);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});
