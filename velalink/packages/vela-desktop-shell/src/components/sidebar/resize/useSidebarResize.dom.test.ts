import assert from "node:assert/strict";
import test from "node:test";

import { Window } from "happy-dom";

test("sidebar resize commits and clears drag state when the window blurs", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { VelaDesktopShell } = await import("../../../VelaDesktopShell");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const committedWidths: number[] = [];

    await act(async () => {
      root.render(
        React.createElement(
          VelaDesktopShell,
          {
            isSidebarVisible: true,
            onSidebarWidthChange: (widthPx: number) => committedWidths.push(widthPx),
            onToggleSidebar: () => {},
            sidebar: React.createElement("aside", null, "Sidebar"),
            sidebarPresentation: "docked",
            sidebarWidthPx: 300,
          },
          React.createElement("main", null, "Main"),
        ),
      );
    });

    const shell = getRequiredElement<HTMLElement>(
      container,
      '[data-slot="sidebar-shell"]',
    );
    Object.defineProperty(shell, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 600,
        height: 600,
        left: 0,
        right: 900,
        top: 0,
        width: 900,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    const handle = getRequiredElement<HTMLElement>(
      container,
      '[data-slot="sidebar-resize-handle"]',
    );

    await act(async () => {
      handle.dispatchEvent(pointerEvent("pointerdown", { button: 0, clientX: 300 }));
      window.dispatchEvent(pointerEvent("pointermove", { clientX: 360 }));
      await flushAnimationFrame();
    });

    assert.equal(shell.getAttribute("data-sidebar-dragging"), "true");
    assert.equal(shell.style.getPropertyValue("--vela-sidebar-width"), "360px");

    await act(async () => {
      window.dispatchEvent(new window.Event("blur"));
    });

    assert.equal(shell.getAttribute("data-sidebar-dragging"), null);
    assert.equal(shell.style.getPropertyValue("--vela-sidebar-width"), "");
    assert.deepEqual(committedWidths, [360]);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

function pointerEvent(type: string, init: PointerEventInit = {}) {
  return new window.PointerEvent(type, {
    bubbles: true,
    button: 0,
    clientX: 0,
    clientY: 0,
    pointerId: 1,
    ...init,
  });
}

function flushAnimationFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function getRequiredElement<T extends Element>(
  root: ParentNode,
  selector: string,
): T {
  const element = root.querySelector(selector);
  assert.notEqual(element, null, `missing ${selector}`);
  return element as T;
}

function installDomRuntime() {
  const window = new Window({ url: "http://127.0.0.1:5173/" });
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    PointerEvent: globalThis.PointerEvent,
    window: globalThis.window,
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: window.document,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: window.navigator,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: window.HTMLElement,
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: window.Node,
  });
  Object.defineProperty(globalThis, "PointerEvent", {
    configurable: true,
    value: window.PointerEvent,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });

  return {
    restore() {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previous.window,
      });
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previous.document,
      });
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: previous.navigator,
      });
      Object.defineProperty(globalThis, "HTMLElement", {
        configurable: true,
        value: previous.HTMLElement,
      });
      Object.defineProperty(globalThis, "Node", {
        configurable: true,
        value: previous.Node,
      });
      Object.defineProperty(globalThis, "PointerEvent", {
        configurable: true,
        value: previous.PointerEvent,
      });
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        configurable: true,
        value: previous.IS_REACT_ACT_ENVIRONMENT,
      });
    },
  };
}
