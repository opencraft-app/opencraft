import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { Window } from "happy-dom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { SessionListItemWire } from "../../vela-chat-client/src";

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

test("session list archive button archives the selected session", async () => {
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

    const archiveButton = document.querySelector<HTMLButtonElement>(
      '[aria-label="归档对话: Archive from menu"]',
    );
    assert.ok(archiveButton);

    await act(async () => {
      archiveButton.click();
    });

    assert.deepEqual(archivedSessionIds, [session.id]);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("session action menu opens from row context menu in a portal layer", async () => {
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

    const row = document.querySelector<HTMLElement>(
      '[data-slot="session-list-surface-item"]',
    );
    assert.ok(row);

    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 80,
        }),
      );
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
    assert.match(menu.getAttribute("style") ?? "", /position:\s*fixed/);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("session action menu closes when clicking the owning row outside the popover", async () => {
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

    const row = document.querySelector<HTMLElement>(
      '[data-slot="session-list-surface-item"]',
    );
    assert.ok(row);

    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 80,
        }),
      );
    });

    assert.notEqual(document.querySelector('[role="menu"][aria-label="Session actions"]'), null);

    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    assert.equal(document.querySelector('[role="menu"][aria-label="Session actions"]'), null);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("session action menu keeps open when clicking inside the popover", async () => {
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

    const row = document.querySelector<HTMLElement>(
      '[data-slot="session-list-surface-item"]',
    );
    assert.ok(row);

    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 80,
        }),
      );
    });

    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Session actions"]');
    assert.ok(menu);

    await act(async () => {
      menu.dispatchEvent(
        new MouseEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    assert.notEqual(document.querySelector('[role="menu"][aria-label="Session actions"]'), null);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("session list rows show the folder location text", async () => {
  const dom = installDomRuntime();
  try {
    const { SessionListSurface } = await import("../src");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SessionListSurface
          sessions={[{ ...session, working_directory: "/Users/skipzhang/velalink" }]}
          currentSessionId={session.id}
          onSelectSession={() => {}}
        />,
      );
    });

    const location = document.querySelector<HTMLElement>(".vela-session-location");
    assert.ok(location);
    assert.equal(location.textContent, "velalink");
    assert.equal(location.title, "/Users/skipzhang/velalink");
    assert.ok(location.querySelector("svg"));

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("session list row focus opens the floating hover card only after the delay", async () => {
  const dom = installDomRuntime();
  try {
    const { SessionListSurface } = await import("../src");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SessionListSurface
          sessions={[{ ...session, title: "读取会话线程", working_directory: "/Users/skipzhang/velalink" }]}
          currentSessionId={session.id}
          onSelectSession={() => {}}
          onArchiveSession={() => {}}
        />,
      );
    });

    const rowButton = document.querySelector<HTMLElement>(
      '[data-slot="session-list-surface-button"]',
    );
    assert.ok(rowButton);
    assert.equal(document.querySelector('[data-slot="session-thumbnail-preview"]'), null);

    await act(async () => {
      rowButton.focus();
    });

    assert.equal(document.querySelector('[data-slot="session-hover-card"]'), null);

    await act(async () => {
      await waitForHoverCardDelay();
    });

    const hoverCard = document.querySelector<HTMLElement>('[data-slot="session-hover-card"]');
    assert.ok(hoverCard);
    assert.equal(hoverCard.parentElement, document.body);
    assert.equal(hoverCard.getAttribute("role"), "tooltip");
    assert.match(hoverCard.textContent ?? "", /读取会话线程/);
    assert.match(hoverCard.textContent ?? "", /velalink/);
    assert.match(hoverCard.textContent ?? "", /codex · gpt-5\.3/);

    await act(async () => {
      rowButton.blur();
    });

    assert.equal(document.querySelector('[data-slot="session-hover-card"]'), null);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("running session rows keep the compact text layout", async () => {
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
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SessionListSurface
          sessions={[runningSession]}
          currentSessionId={runningSession.id}
          onSelectSession={() => {}}
        />,
      );
    });

    const item = document.querySelector<HTMLElement>('[data-slot="session-list-surface-item"]');
    assert.ok(item);
    assert.equal(item.dataset.hasThumbnail, undefined);
    assert.equal(document.querySelector('[data-slot="session-thumbnail-preview"]'), null);
    assert.equal(document.querySelector(".vela-session-preview")?.textContent, runningSession.preview);
    assert.equal(document.querySelector(".vela-session-meta"), null);
    assert.equal(document.querySelector(".vela-session-location")?.textContent, "velaChat");
    assert.ok(document.querySelector(".vela-session-location svg"));

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("session list activity treats waiting for user as distinct from legacy running", async () => {
  const dom = installDomRuntime();
  try {
    const { SessionListSurface } = await import("../src");
    const waitingSession: SessionListItemWire = {
      ...session,
      id: "ses_waiting_activity",
      status: "waiting_for_input",
      pending_request_count: 1,
      running: true,
      activity: {
        phase: "idle",
        attention: "waiting_for_user",
        pending_request_count: 1,
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SessionListSurface
          sessions={[waitingSession]}
          currentSessionId={waitingSession.id}
          onSelectSession={() => {}}
        />,
      );
    });

    const item = document.querySelector<HTMLElement>('[data-slot="session-list-surface-item"]');
    assert.ok(item);
    assert.equal(item.dataset.activity, "waiting_for_input");
    assert.equal(item.dataset.waiting, "true");
    assert.equal(item.dataset.running, undefined);
    assert.doesNotMatch(container.innerHTML, /1 个请求/);
    assert.equal(document.querySelector(".vela-session-badge"), null);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("dragging a session row emits host preview events without selecting", async () => {
  const dom = installDomRuntime();
  try {
    const { SessionListSurface } = await import("../src");
    const selectedSessionIds: string[] = [];
    const previewEvents: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SessionListSurface
          sessions={[session]}
          currentSessionId={session.id}
          onSessionDragPreviewEnd={() => previewEvents.push("end")}
          onSessionDragPreviewMove={(input) =>
            previewEvents.push(`move:${input.sessionId}:${input.point.screenX},${input.point.screenY}`)
          }
          onSessionDragPreviewStart={(input) =>
            previewEvents.push(`start:${input.sessionId}:${input.point.screenX},${input.point.screenY}`)
          }
          onSelectSession={(sessionId) => selectedSessionIds.push(sessionId)}
        />,
      );
    });

    const rowButton = document.querySelector<HTMLElement>(
      '[data-slot="session-list-surface-button"]',
    );
    assert.ok(rowButton);

    await act(async () => {
      rowButton.dispatchEvent(
        new MouseEvent("pointerdown", {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: 20,
          clientY: 20,
          screenX: 220,
          screenY: 320,
        }),
      );
      rowButton.dispatchEvent(
        new MouseEvent("pointermove", {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: 24,
          clientY: 24,
          screenX: 224,
          screenY: 324,
        }),
      );
    });

    assert.deepEqual(previewEvents, []);

    await act(async () => {
      rowButton.dispatchEvent(
        new MouseEvent("pointermove", {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: 80,
          clientY: 90,
          screenX: 280,
          screenY: 390,
        }),
      );
      await waitForAnimationFrame();
    });

    assert.deepEqual(previewEvents, [
      `start:${session.id}:280,390`,
      `move:${session.id}:280,390`,
    ]);
    assert.equal(document.querySelector('[data-slot="session-drag-preview"]'), null);

    await act(async () => {
      rowButton.dispatchEvent(
        new MouseEvent("pointerup", {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: 80,
          clientY: 90,
          screenX: 280,
          screenY: 390,
        }),
      );
      rowButton.click();
    });

    assert.equal(document.querySelector('[data-slot="session-drag-preview"]'), null);
    assert.deepEqual(previewEvents, [
      `start:${session.id}:280,390`,
      `move:${session.id}:280,390`,
      "end",
    ]);
    assert.deepEqual(selectedSessionIds, []);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

function waitForHoverCardDelay() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 820);
  });
}

function waitForAnimationFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

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
