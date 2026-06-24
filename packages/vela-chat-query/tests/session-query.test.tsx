import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { Window } from "happy-dom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type {
  ArchiveSessionInput,
  ArchiveSessionWireResponse,
  SessionListOptions,
  SessionListViewWireResponse,
  VeladClient,
} from "../../vela-chat-client/src";
import {
  VelaQueryProvider,
  velaQueryKeys,
  useArchiveSessionMutation,
  useSessionListViewQuery,
} from "../src";

register(new URL("../../vela-chat-web/tests/css-module-loader.mjs", import.meta.url));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessions = [
  {
    id: "ses_a",
    title: "First",
    backend: "codex",
    status: "idle",
    working_directory: "/repo",
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
    last_activity_at: "2026-06-23T00:00:00.000Z",
    preview: "first",
    pending_request_count: 0,
    running: false,
    model: "gpt-5.3",
    agent_config: {
      model: "gpt-5.3",
      permission_mode: "auto",
      feature_values: {},
    },
  },
  {
    id: "ses_b",
    title: "Second",
    backend: "codex",
    status: "idle",
    working_directory: "/repo",
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
    last_activity_at: "2026-06-23T00:00:00.000Z",
    preview: "second",
    pending_request_count: 0,
    running: false,
    model: "gpt-5.3",
    agent_config: {
      model: "gpt-5.3",
      permission_mode: "auto",
      feature_values: {},
    },
  },
] satisfies SessionListViewWireResponse["sessions"];

test("session query keys are stable and scoped by options", () => {
  assert.deepEqual(velaQueryKeys.sessionListView({ limit: 80 }), [
    "vela",
    "sessions",
    "view",
    { limit: 80 },
  ]);
  assert.deepEqual(velaQueryKeys.session("ses_a"), ["vela", "sessions", "detail", "ses_a"]);
});

test("archive session mutation removes archived session and selects the next visible session", async () => {
  const dom = installDomRuntime();
  try {
    const archived: ArchiveSessionInput[] = [];
    const archivedServerSessionIds = new Set<string>();
    const selectedSessionIds: string[] = [];
    const client = createFakeClient({
      archiveSession: async (input) => {
        archived.push(input);
        archivedServerSessionIds.add(input.sessionId);
        return {
          session: {
            ...sessions[0],
            status: "archived",
          },
        } satisfies ArchiveSessionWireResponse;
      },
      getSessionListView: async () => ({
        sessions: sessions.filter((session) => !archivedServerSessionIds.has(session.id)),
        cursor: {
          limit: 80,
          next_after_id: null,
          has_more: false,
        },
      }),
    });
    const seenLists: string[][] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Probe() {
      const list = useSessionListViewQuery({ client, options: { limit: 80 } });
      const archive = useArchiveSessionMutation({
        client,
        currentSessionId: "ses_a",
        sessionListOptions: { limit: 80 },
        onSelectSession: (sessionId) => selectedSessionIds.push(sessionId),
      });

      React.useEffect(() => {
        if (list.data) seenLists.push(list.data.sessions.map((session) => session.id));
      }, [list.data]);

      return (
        <button
          type="button"
          onClick={() => archive.mutate({ sessionId: "ses_a" })}
        >
          Archive
        </button>
      );
    }

    await act(async () => {
      root.render(
        <VelaQueryProvider>
          <Probe />
        </VelaQueryProvider>,
      );
    });
    await flushUntil(dom, () => seenLists.length > 0);

    const button = document.querySelector<HTMLButtonElement>("button");
    assert.ok(button);
    await act(async () => {
      button.click();
    });
    await flushUntil(dom, () => archived.length === 1 && selectedSessionIds.length === 1);
    await flushUntil(dom, () => seenLists.at(-1)?.join(",") === "ses_b");

    assert.deepEqual(archived, [{ sessionId: "ses_a" }]);
    assert.deepEqual(selectedSessionIds, ["ses_b"]);
    assert.deepEqual(seenLists.at(-1), ["ses_b"]);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

function createFakeClient(overrides: Partial<VeladClient> = {}): VeladClient {
  return {
    async archiveSession(input) {
      return overrides.archiveSession?.(input) ?? {
        session: {
          ...sessions[0],
          status: "archived",
        },
      };
    },
    async getSessionListView(_options?: SessionListOptions) {
      if (overrides.getSessionListView) return overrides.getSessionListView(_options);
      return {
        sessions: [...sessions],
        cursor: {
          limit: 80,
          next_after_id: null,
          has_more: false,
        },
      };
    },
  } as VeladClient;
}

async function flushUntil(dom: InstalledDomRuntime, predicate: () => boolean) {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });
  }
  assert.equal(predicate(), true);
}

interface InstalledDomRuntime {
  restore: () => void;
  window: Window;
}

function installDomRuntime(): InstalledDomRuntime {
  const win = new Window();
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    Node: globalThis.Node,
    window: globalThis.window,
  };

  Object.assign(globalThis, {
    document: win.document,
    HTMLElement: win.HTMLElement,
    MouseEvent: win.MouseEvent,
    Node: win.Node,
    window: win,
  });

  return {
    restore() {
      Object.assign(globalThis, previous);
    },
    window: win,
  };
}
