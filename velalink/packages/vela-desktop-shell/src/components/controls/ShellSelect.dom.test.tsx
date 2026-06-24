import assert from "node:assert/strict";
import test from "node:test";

import { Window } from "happy-dom";

test("shell select opens without re-rendering its floating layer indefinitely", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ShellSelect } = await import("./ShellSelect");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ShellSelect, {
          ariaLabel: "Select model",
          density: "compact",
          options: [
            { id: "minimax-m2.7", label: "MiniMax M2.7" },
            { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
          ],
          placement: "top-start",
          value: "minimax-m2.7",
          onValueChange: () => {},
        }),
      );
    });

    const trigger = getRequiredElement<HTMLButtonElement>(
      container,
      ".vela-shell-select-trigger",
    );

    await act(async () => {
      trigger.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, composed: true }),
      );
    });

    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.notEqual(
      document.body.querySelector(".vela-shell-select-popover"),
      null,
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

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
