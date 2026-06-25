import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { Window } from "happy-dom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { SessionListItemWire } from "../../vela-chat-client/src";
import type { ChatRenderModel } from "../../vela-chat-render-model/src";

register(new URL("./css-module-loader.mjs", import.meta.url));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session: SessionListItemWire = {
  id: "ses_archive_menu",
  title: "Archive from menu",
  backend: "codex",
  status: "idle",
  working_directory: "/Users/skipzhang/code/velaChat",
  created_at: "2026-06-23T00:00:00.000Z",
  updated_at: "2026-06-23T00:00:00.000Z",
  last_activity_at: "2026-06-23T00:00:00.000Z",
  preview: "A session that can be archived",
  pending_request_count: 0,
  running: false,
  model: "gpt-5.3",
  agent_config: {
    model: "gpt-5.3",
    permission_mode: "auto",
    feature_values: {},
  },
};

test("session list item menu archives the selected session", async () => {
  const dom = installDomRuntime();
  try {
    const { SessionListSurface } = await import("../src");
    const archivedSessionIds: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SessionListSurface
          sessions={[session]}
          currentSessionId={session.id}
          onSelectSession={() => {}}
          onArchiveSession={(sessionId) => archivedSessionIds.push(sessionId)}
        />,
      );
    });

    const menuTrigger = document.querySelector<HTMLButtonElement>(
      '[aria-label="Session actions for Archive from menu"]',
    );
    assert.ok(menuTrigger);

    await act(async () => {
      menuTrigger.click();
    });

    const archiveItem = document.querySelector<HTMLButtonElement>(
      '[role="menuitem"][data-action="archive-session"]',
    );
    assert.ok(archiveItem);

    await act(async () => {
      archiveItem.click();
    });

    assert.deepEqual(archivedSessionIds, [session.id]);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("session action menu uses a portal layer outside the session item", async () => {
  const dom = installDomRuntime();
  try {
    const { SessionListSurface } = await import("../src");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SessionListSurface
          sessions={[session]}
          currentSessionId={session.id}
          onSelectSession={() => {}}
          onArchiveSession={() => {}}
        />,
      );
    });

    const menuTrigger = document.querySelector<HTMLButtonElement>(
      '[aria-label="Session actions for Archive from menu"]',
    );
    assert.ok(menuTrigger);

    await act(async () => {
      menuTrigger.click();
    });

    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Session actions"]');
    const item = document.querySelector<HTMLElement>('[data-slot="session-list-surface-item"]');
    assert.ok(menu);
    assert.ok(item);
    assert.equal(menu.parentElement, document.body);
    assert.equal(item.contains(menu), false);
    assert.equal(menu.classList.contains("vela-popover-surface"), true);
    assert.equal(menu.classList.contains("vela-session-actions-popover"), true);
    assert.equal(menu.classList.contains("vela-settings-popover"), false);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("running session rows render a scaled thumbnail preview", async () => {
  const dom = installDomRuntime();
  try {
    const { SessionListSurface } = await import("../src");
    const runningSession: SessionListItemWire = {
      ...session,
      id: "ses_running_thumbnail",
      title: "Streaming task",
      preview: "Assistant is writing a response",
      status: "running",
      running: true,
    };
    const preview = chatPreviewModel(runningSession.id);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SessionListSurface
          sessions={[runningSession]}
          currentSessionId={runningSession.id}
          sessionPreviews={{ [runningSession.id]: preview }}
          onSelectSession={() => {}}
        />,
      );
    });

    const item = document.querySelector<HTMLElement>('[data-slot="session-list-surface-item"]');
    const previewElement = document.querySelector<HTMLElement>(
      '[data-slot="session-thumbnail-preview"]',
    );
    assert.ok(item);
    assert.ok(previewElement);
    assert.equal(item.dataset.hasThumbnail, "true");
    assert.equal(document.querySelector(".vela-session-preview"), null);
    assert.equal(document.querySelector(".vela-session-meta"), null);
    assert.match(container.innerHTML, /transform:\s*scale\(0\.15\)/);
    assert.match(container.innerHTML, /width:\s*126px/);
    assert.match(container.innerHTML, /height:\s*78px/);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

function installDomRuntime() {
  const win = new Window();
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    Node: globalThis.Node,
    ResizeObserver: globalThis.ResizeObserver,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    window: globalThis.window,
  };

  class TestResizeObserver {
    disconnect() {}
    observe() {}
    unobserve() {}
  }

  const requestAnimationFrame = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number;
  const cancelAnimationFrame = (id: number) => {
    clearTimeout(id);
  };

  Object.assign(globalThis, {
    cancelAnimationFrame,
    document: win.document,
    HTMLElement: win.HTMLElement,
    MouseEvent: win.MouseEvent,
    Node: win.Node,
    ResizeObserver: TestResizeObserver,
    requestAnimationFrame,
    window: win,
  });
  Object.assign(win, {
    cancelAnimationFrame,
    ResizeObserver: TestResizeObserver,
    requestAnimationFrame,
  });

  return {
    restore() {
      Object.assign(globalThis, previous);
    },
  };
}

function chatPreviewModel(sessionId: string): ChatRenderModel {
  return {
    session_id: sessionId,
    host: { kind: "desktop_shell" },
    requests: { items: [] },
    composer: {
      placeholder: "要求后续变更",
      can_send: true,
      is_running: true,
    },
    rows: [
      {
        kind: "user_message",
        id: `${sessionId}:user`,
        key: `${sessionId}:user`,
        text: "Summarize the current work",
        copy_text: "Summarize the current work",
        collapsed: false,
        parts: [{ id: `${sessionId}:user:text`, type: "text", text: "Summarize the current work" }],
        createdAt: "2026-06-23T00:00:01.000Z",
        debug: debug(`${sessionId}:user`),
      },
      {
        kind: "assistant_message",
        id: `${sessionId}:assistant`,
        key: `${sessionId}:assistant`,
        blocks: [{ id: `${sessionId}:assistant:block`, text: "Working through the session" }],
        status: "streaming",
        streaming: true,
        revision: 1,
        createdAt: "2026-06-23T00:00:02.000Z",
        debug: debug(`${sessionId}:assistant`),
      },
    ],
  };
}

function debug(id: string) {
  return {
    projection: "conversation" as const,
    source_event_ids: [`evt_${id}`],
    source_event_ranges: [],
  };
}
