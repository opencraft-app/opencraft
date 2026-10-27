import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { WorkbenchPresentationActivity, WorkbenchPresentationActivityProvider, useWorkbenchPresentationActive } from "../../apps/workbench-web/src/components/workbench-presentation-activity";

// Real React ownership/visibility transitions; no transport or business command.
test("parked presentation composes parent activity and preserves input identity and selection", async () => {
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const keys = ["window", "document", "React", "IS_REACT_ACT_ENVIRONMENT"];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, React, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const source = new WorkbenchPresentationActivity(true);
  function Consumer() {
    const active = useWorkbenchPresentationActive();
    return <div data-active={String(active)}><input defaultValue="retained draft" /></div>;
  }
  const render = (active: boolean) => act(async () => {
    root.render(<WorkbenchPresentationActivityProvider source={source}><WorkbenchPresentationActivityProvider active={active}><Consumer /></WorkbenchPresentationActivityProvider></WorkbenchPresentationActivityProvider>);
  });
  try {
    await render(true);
    const input = dom.window.document.querySelector("input")!;
    input.setSelectionRange(2, 7);
    const active = () => dom.window.document.querySelector("[data-active]")!.getAttribute("data-active");
    assert.equal(active(), "true");
    await act(async () => source.setActive(false));
    assert.equal(active(), "false");
    await render(false);
    await act(async () => source.setActive(true));
    assert.equal(active(), "false", "a child cannot override a parked parent");
    await render(true);
    assert.equal(active(), "true");
    Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); });
    assert.equal(active(), "false");
    Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => { dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); });
    assert.equal(active(), "true");
    assert.equal(dom.window.document.querySelector("input"), input);
    assert.equal(input.value, "retained draft");
    assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 7);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const key of keys) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
