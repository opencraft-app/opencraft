import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { shouldTypeToCompose } from "../apps/workbench-web/src/type-to-compose.ts";

let window;
let document;
const elementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Element");
beforeEach(() => {
  ({ window } = new JSDOM("<!doctype html><body></body>"));
  document = window.document;
  Object.defineProperty(globalThis, "Element", { configurable: true, value: window.Element });
});
afterEach(() => {
  window.close();
  if (elementDescriptor) Object.defineProperty(globalThis, "Element", elementDescriptor);
  else Reflect.deleteProperty(globalThis, "Element");
});

// Exercise the window listener after native Shadow DOM event retargeting.
function dispatch(target, init = {}) {
  let result;
  let observedTarget = null;
  const listener = (event) => {
    observedTarget = event.target;
    result = shouldTypeToCompose(event);
  };
  window.addEventListener("keydown", listener);
  try {
    target.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "n", bubbles: true, composed: true, cancelable: true, ...init,
    }));
  } finally { window.removeEventListener("keydown", listener); }
  return { result, observedTarget };
}

describe("embedded type-to-compose input ownership", () => {
  it("does not insert the first Pinyin key from the shadow editor before isComposing becomes true", () => {
    const host = document.createElement("opencraft-embedded-workbench");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const paragraph = document.createElement("p");
    editor.append(paragraph);
    shadow.append(editor);
    assert.deepEqual(dispatch(paragraph), { result: false, observedTarget: host });
    assert.equal(dispatch(paragraph, { key: "s" }).result, false);
  });

  it("leaves shadow inputs, buttons, and menus in control of their keys", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    for (const tag of ["input", "textarea", "button"]) {
      const element = document.createElement(tag);
      shadow.append(element);
      assert.equal(dispatch(element).result, false);
    }
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    shadow.append(menu);
    assert.equal(dispatch(menu).result, false);
  });

  it("keeps plain page typing but ignores composition start, active composition, shortcuts and prevented keys", () => {
    assert.equal(dispatch(document.body).result, true);
    assert.equal(dispatch(document.body, { keyCode: 229 }).result, false);
    assert.equal(dispatch(document.body, { isComposing: true }).result, false);
    assert.equal(dispatch(document.body, { ctrlKey: true }).result, false);
    const input = document.createElement("input");
    document.body.append(input);
    assert.equal(dispatch(input).result, false);
    input.addEventListener("keydown", (event) => event.preventDefault());
    assert.equal(dispatch(input).result, false);
  });
});
