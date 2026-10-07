import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { DictationFooter } from "../packages/codex-composer/src/dictation-footer";

function render(phase: "starting" | "listening" | "transcribing") {
  const previous = (globalThis as any).React;
  (globalThis as any).React = React;
  try {
    return new JSDOM(renderToStaticMarkup(<DictationFooter interaction={{ kind: "dictation", phase,
      startedAt: phase === "starting" ? null : Date.now(), audioLevels: { subscribe: () => () => {} },
      cancel() {}, finish: async () => false,
    }} canSend onSend={() => {}} onCancel={() => {}} />));
  } finally { (globalThis as any).React = previous; }
}

test("startup is decorative progress, neutral announcement and cancellable, never permission prose or a waveform", () => {
  const dom = render("starting"), document = dom.window.document;
  try {
    assert.equal(document.querySelectorAll(".ui-progress-indicator[aria-hidden='true']").length, 1);
    assert.equal(document.querySelectorAll(".codex-composer-voice-footer__status-label, canvas").length, 0);
    assert.equal(document.querySelector("[role='status']")?.textContent, "正在准备录音");
    assert.equal(document.querySelector(".codex-composer-voice-footer__duration")?.textContent, "0:00");
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
