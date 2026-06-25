import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { Window } from "happy-dom";

register(new URL("./css-module-loader.mjs", import.meta.url));

test("composer controls reserve invisible toolbar space while session truth is loading", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ComposerControls } = await import(
      "../src/components/composer-controls/ComposerControls"
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ComposerControls, {
          controls: {
            ready: false,
            disabled: true,
            providerLabel: "",
            modelOptions: [],
            reasoningEffortOptions: [],
            permissionModeOptions: [],
          },
          placement: "secondary",
          onChange: () => {},
        }),
      );
    });

    const reserve = container.querySelector<HTMLElement>(
      '[data-composer-controls-ready="false"]',
    );
    assert.notEqual(reserve, null);
    assert.equal(reserve!.getAttribute("aria-hidden"), "true");
    assert.equal(reserve!.dataset.placement, "secondary");
    assert.equal(container.querySelector(".vela-shell-select"), null);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("composer controls render shared icon components for model reasoning and permission", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ComposerControls } = await import(
      "../src/components/composer-controls/ComposerControls"
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ComposerControls, {
          controls: {
            ready: true,
            disabled: false,
            providerLabel: "Codex",
            selectedModel: { id: "gpt-5.5", label: "GPT-5.5", reasoningEfforts: [] },
            selectedReasoningEffort: { id: "high", label: "High" },
            selectedPermissionMode: { id: "auto", label: "Default permissions" },
            modelOptions: [
              { id: "gpt-5.5", label: "GPT-5.5", reasoningEfforts: [] },
            ],
            reasoningEffortOptions: [{ id: "high", label: "High" }],
            permissionModeOptions: [{ id: "auto", label: "Default permissions" }],
          },
          placement: "all",
          onChange: () => {},
        }),
      );
    });

    const leadingNodes = Array.from(
      container.querySelectorAll<HTMLElement>(".vela-shell-select-trigger-leading"),
    );
    assert.equal(leadingNodes.length, 3);
    assert.equal(leadingNodes.every((node) => node.querySelector("svg")), true);
    assert.equal(container.textContent?.includes("◎"), false);
    assert.equal(container.textContent?.includes("▣"), false);
    assert.equal(container.textContent?.includes("✣"), false);

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
