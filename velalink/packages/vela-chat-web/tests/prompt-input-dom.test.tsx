import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { Window } from "happy-dom";

register(new URL("./css-module-loader.mjs", import.meta.url));

test("prompt input ignores implicit form submit for long pasted drafts", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { PromptInput } = await import("../src/primitives/prompt-input/PromptInput");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let submitCount = 0;

    await act(async () => {
      root.render(
        React.createElement(PromptInput, {
          canSubmit: true,
          isRunning: false,
          onChange: () => {},
          onSubmit: () => {
            submitCount += 1;
          },
          placeholder: "Message",
          value: "散".repeat(500),
        }),
      );
    });

    const form = container.querySelector("form");
    assert.notEqual(form, null);
    const implicitSubmit = new window.Event("submit", {
      bubbles: true,
      cancelable: true,
    });
    form!.dispatchEvent(implicitSubmit);

    assert.equal(submitCount, 0);
    assert.equal(implicitSubmit.defaultPrevented, true);

    const button = container.querySelector<HTMLButtonElement>(".sendButton");
    assert.notEqual(button, null);
    assert.equal(button!.type, "button");
    button!.click();

    assert.equal(submitCount, 1);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

function installDomRuntime() {
  const window = new Window({ url: "http://127.0.0.1:3000/chat" });
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
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
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        configurable: true,
        value: previous.IS_REACT_ACT_ENVIRONMENT,
      });
    },
  };
}
