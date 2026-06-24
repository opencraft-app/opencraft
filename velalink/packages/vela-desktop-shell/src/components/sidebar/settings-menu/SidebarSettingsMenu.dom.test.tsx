import assert from "node:assert/strict";
import test from "node:test";

import { Window } from "happy-dom";

test("sidebar settings menu closes when clicking outside the menu root", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { SidebarSettingsMenu } = await import("./SidebarSettingsMenu");

    const container = document.createElement("div");
    const outside = document.createElement("button");
    outside.textContent = "outside";
    document.body.append(container, outside);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(SidebarSettingsMenu));
    });

    const trigger = getRequiredElement<HTMLButtonElement>(
      container,
      ".vela-settings-menu-trigger",
    );
    assert.equal(trigger.getAttribute("aria-expanded"), "false");

    await act(async () => {
      trigger.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, composed: true }),
      );
    });

    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.notEqual(document.body.querySelector('[role="menu"]'), null);

    await act(async () => {
      outside.dispatchEvent(
        new window.PointerEvent("pointerdown", { bubbles: true, composed: true }),
      );
    });

    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(document.body.querySelector('[role="menu"]'), null);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("sidebar settings menu keeps open when clicking inside the menu root", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { SidebarSettingsMenu } = await import("./SidebarSettingsMenu");

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(SidebarSettingsMenu));
    });

    const trigger = getRequiredElement<HTMLButtonElement>(
      container,
      ".vela-settings-menu-trigger",
    );
    await act(async () => {
      trigger.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, composed: true }),
      );
    });

    const menu = getRequiredElement<HTMLElement>(document.body, '[role="menu"]');
    await act(async () => {
      menu.dispatchEvent(
        new window.PointerEvent("pointerdown", { bubbles: true, composed: true }),
      );
    });

    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.notEqual(document.body.querySelector('[role="menu"]'), null);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("sidebar settings menu portals the popover outside the sidebar root in browser runtime", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { SidebarSettingsMenu } = await import("./SidebarSettingsMenu");

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(SidebarSettingsMenu));
    });

    const trigger = getRequiredElement<HTMLButtonElement>(
      container,
      ".vela-settings-menu-trigger",
    );

    await act(async () => {
      trigger.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, composed: true }),
      );
    });

    const menuRoot = getRequiredElement<HTMLElement>(
      container,
      ".vela-settings-menu-root",
    );
    const popover = getRequiredElement<HTMLElement>(
      document.body,
      ".vela-settings-popover",
    );

    assert.equal(popover.dataset.layer, "portal");
    assert.equal(popover.classList.contains("macos-popover-surface"), false);
    assert.equal(menuRoot.contains(popover), false);

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
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: window.Node,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: window.HTMLElement,
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
      restoreGlobal("window", previous.window);
      restoreGlobal("document", previous.document);
      restoreGlobal("navigator", previous.navigator);
      restoreGlobal("Node", previous.Node);
      restoreGlobal("HTMLElement", previous.HTMLElement);
      restoreGlobal("PointerEvent", previous.PointerEvent);
      restoreGlobal(
        "IS_REACT_ACT_ENVIRONMENT",
        previous.IS_REACT_ACT_ENVIRONMENT,
      );
    },
  };
}

function restoreGlobal(key: string, value: unknown) {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, key);
    return;
  }

  Object.defineProperty(globalThis, key, {
    configurable: true,
    value,
  });
}
