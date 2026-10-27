import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import messages from "../../apps/workbench-web/src/i18n/locales/zh-CN.json";
import { JSDOM } from "jsdom";
import { DictationFooter } from "../../packages/composer-editor/src/dictation-footer";

function render(phase: "starting" | "listening" | "transcribing") {
  const previous = (globalThis as any).React;
  (globalThis as any).React = React;
  try {
    return new JSDOM(renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={messages}><DictationFooter interaction={{ kind: "dictation", phase,
      startedAt: phase === "starting" ? null : Date.now(), audioLevels: { subscribe: () => () => {} },
      cancel() {}, finish: async () => false,
    }} canSend onSend={() => {}} onCancel={() => {}} /></IntlProvider>));
  } finally { (globalThis as any).React = previous; }
}

test("startup is decorative progress, neutral announcement and cancellable, never permission prose or a waveform", () => {
  const dom = render("starting"), document = dom.window.document;
  try {
    assert.equal(document.querySelectorAll(".ui-progress-indicator[aria-hidden='true']").length, 1);
    assert.equal(document.querySelectorAll(".opencraft-composer-voice-footer__status-label, canvas").length, 0);
    assert.equal(document.querySelector("[role='status']")?.textContent, "正在准备录音");
    assert.equal(document.querySelector(".opencraft-composer-voice-footer__duration")?.textContent, "0:00");
    assert.equal(document.body.textContent?.includes("授权"), false);
    assert.equal(document.querySelector("button[aria-label='取消语音输入']")?.hasAttribute("disabled"), false);
    assert.equal(document.querySelector("button[aria-label='停止并写入文字']")?.hasAttribute("disabled"), true);
    assert.equal(document.querySelector("button[aria-label='识别完成后发送']")?.hasAttribute("disabled"), true);
  } finally { dom.window.close(); }
});

test("confirmed listening replaces startup progress; transcription retains its own status", () => {
  for (const phase of ["listening", "transcribing"] as const) {
    const dom = render(phase), document = dom.window.document;
    try {
      assert.equal(document.querySelectorAll(".ui-progress-indicator").length, 0);
      assert.equal(document.querySelectorAll("canvas").length, phase === "listening" ? 1 : 0);
      assert.equal(document.querySelector("[role='status']")?.textContent, phase === "listening" ? "正在听写" : "正在完成语音识别");
      assert.equal(document.querySelector("button[aria-label='停止并写入文字']")?.hasAttribute("disabled"), phase !== "listening");
    } finally { dom.window.close(); }
  }
});

test("waveform respects live reduced motion and releases paint and listener ownership", async () => {
  const { createRoot } = await import("react-dom/client");
  const dom = new JSDOM('<div id="root"></div>');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom.window, document: dom.window.document, React, IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (paint: FrameRequestCallback) => { frames.set(++frameId, paint); return frameId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  };
  let frameId = 0, strokes = 0, subscribed = false;
  const frames = new Map<number, FrameRequestCallback>();
  let sample: (value: number) => void = () => {};
  const listeners = new Set<() => void>();
  const preference = { matches: true,
    addEventListener: (_: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_: string, listener: () => void) => { listeners.delete(listener); },
  };
  dom.window.matchMedia = (() => preference) as any;
  dom.window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ width: 200, height: 28 } as DOMRect);
  dom.window.HTMLCanvasElement.prototype.getContext = (() => ({
    setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { strokes++; },
  })) as any;
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const flush = () => { for (const [id, paint] of [...frames]) { frames.delete(id); paint(0); } };
  try {
    await React.act(async () => root.render(<IntlProvider locale="zh-CN" messages={messages}><DictationFooter interaction={{ kind: "dictation", phase: "listening",
      startedAt: null, audioLevels: { subscribe(listener) { sample = listener; subscribed = true; return () => { subscribed = false; }; } },
      cancel() {}, finish: async () => false,
    }} canSend onSend={() => {}} onCancel={() => {}} /></IntlProvider>));
    flush(); strokes = 0;
    sample(0.8);
    assert.equal(frames.size, 0, "reduced motion must not repaint for samples");
    preference.matches = false; listeners.forEach(listener => listener()); flush();
    assert.ok(strokes > 0, "live preference change must redraw");
    strokes = 0; sample(0.4); flush(); assert.ok(strokes > 0);
    preference.matches = true; listeners.forEach(listener => listener()); flush();
    strokes = 0; sample(0.6); assert.equal(frames.size, 0);
    preference.matches = false; listeners.forEach(listener => listener());
    assert.equal(frames.size, 1);
  } finally {
    await React.act(async () => root.unmount());
    assert.equal(frames.size, 0); assert.equal(listeners.size, 0); assert.equal(subscribed, false);
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
