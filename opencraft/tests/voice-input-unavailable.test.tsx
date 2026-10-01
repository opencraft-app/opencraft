import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";

import { createVoiceInputAction } from "../plugins/voice-input/src/voice-input-action";

test("unavailable voice input ignores pointer and click activation", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const previousReact = (globalThis as any).React;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, React });

  let opened = 0;
  let started = 0;
  const VoiceInputAction = createVoiceInputAction({
    id: "unavailable-test",
    isAvailable: () => false,
    start: () => { started += 1; throw new Error("Unavailable voice input started"); },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await React.act(async () => root.render(React.createElement(VoiceInputAction, {
      disabled: false,
      mutations: { beginTransientTextInput: () => { opened += 1; return null; } },
    } as any)));
    const button = dom.window.document.querySelector("button")!;
    assert.equal(button.disabled, true);
    assert.equal(button.title, "Voice input is unavailable in this browser");

    button.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 180));
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 }));
    assert.equal(opened, 0);
    assert.equal(started, 0);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, { window: previousWindow, document: previousDocument, IS_REACT_ACT_ENVIRONMENT: previousActEnvironment, React: previousReact });
  }
});
