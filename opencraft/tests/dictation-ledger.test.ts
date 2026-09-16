import assert from "node:assert/strict";
import test from "node:test";
import { DictationTranscriptLedger } from "../plugins/voice-input/src/dictation-transcript-ledger.js";
import { NativeSpeechInputProvider } from "../plugins/voice-input/src/native-speech-provider.js";
import { BrowserSpeechInputProvider } from "../plugins/voice-input/src/speech-input-provider.js";
import { resolveDictationKeyAction } from "../packages/codex-composer/src/dictation-keyboard.js";

test("partial revision cannot replace confirmed history or another utterance", () => {
  const ledger = new DictationTranscriptLedger();
  ledger.accept({ utteranceId: "one", sequence: 1, phase: "final", text: "第一句。" });
  ledger.accept({ utteranceId: "two", sequence: 2, phase: "partial", text: "第二句猜测" });
  ledger.accept({ utteranceId: "two", sequence: 3, phase: "partial", text: "新猜测" });
  ledger.accept({ utteranceId: "one", sequence: 4, phase: "partial", text: "不能抹除历史" });
  assert.throws(() => ledger.finish(), /尚未确认/);
  ledger.accept({ utteranceId: "two", sequence: 5, phase: "final", text: "第二句。" });
  assert.equal(ledger.finish(), "第一句。 第二句。");
});
test("dictation keyboard belongs to the read-only input, not native button Enter activation", () => {
  const enter = { key: "Enter", shiftKey: false, altKey: false, isComposing: false };
  assert.equal(resolveDictationKeyAction(enter, true), "send");
  assert.equal(resolveDictationKeyAction(enter, false), null);
  assert.equal(resolveDictationKeyAction({ ...enter, isComposing: true }, true), null);
  assert.equal(resolveDictationKeyAction({ ...enter, shiftKey: true }, true), null);
  assert.equal(resolveDictationKeyAction({ ...enter, key: "Escape" }, false), "cancel");
});
test("same-ID final replay is idempotent, late revisions ignored, correction isolated", () => {
  const ledger = new DictationTranscriptLedger();
  ledger.accept({ utteranceId: "one", sequence: 1, phase: "final", text: "One" });
  ledger.accept({ utteranceId: "two", sequence: 2, phase: "final", text: "Two" });
  ledger.accept({ utteranceId: "one", sequence: 3, phase: "final", text: "Corrected one" });
  ledger.accept({ utteranceId: "one", sequence: 1, phase: "final", text: "Old" });
  assert.equal(ledger.finish(), "Corrected one Two");
});
test("native utterance final leaves session capturing and delivers joined finals only after stop/end", async () => {
  let receive = (event: any) => {}; const output: any[] = [];
  const port = { onEvent(listener: typeof receive) { receive = listener; return () => {}; }, async start() {}, async stop() {}, async cancel() {} };
  const provider = new NativeSpeechInputProvider(port as any, { createId: () => "session" });
  const session = provider.start({ commit: text => output.push(["commit", text]), end: () => output.push(["end"]), error: error => output.push(["error", error]) });
  await provider.settled();
  receive({ sessionId: "session", type: "utterance", utteranceId: "one", sequence: 1, phase: "final", text: "One" });
  receive({ sessionId: "session", type: "utterance", utteranceId: "two", sequence: 2, phase: "partial", text: "changing hypothesis" });
  assert.deepEqual(output, []);
  session.stop(); await provider.settled();
  receive({ sessionId: "session", type: "utterance", utteranceId: "two", sequence: 3, phase: "final", text: "Two" });
  receive({ sessionId: "session", type: "end" });
  assert.deepEqual(output, [["commit", "One Two"], ["end"]]);
  await provider.settled();
});
test("browser result indices form a final-only ledger; replay and partial cannot overwrite confirmed text", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "SpeechRecognition"); let recognizer: any;
  class Recognition { onresult: any; onend: any; onerror: any; start() { recognizer = this; } stop() {} abort() {} }
  Object.defineProperty(globalThis, "SpeechRecognition", { configurable: true, value: Recognition });
  try {
    const output: any[] = [], provider = new BrowserSpeechInputProvider();
    const session = provider.start({ commit: text => output.push(["commit", text]), end: () => output.push(["end"]), error: error => output.push(["error", error]) });
    const result = (text: string, isFinal: boolean) => ({ isFinal, length: 1, 0: { transcript: text } });
    recognizer.onresult({ resultIndex: 0, results: [result("One", true), result("changing", false)] });
    recognizer.onresult({ resultIndex: 0, results: [result("One", true), result("Two", true)] });
    assert.deepEqual(output, []);
    session.stop(); recognizer.onend();
    assert.deepEqual(output, [["commit", "One Two"], ["end"]]);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "SpeechRecognition", descriptor);
    else delete (globalThis as any).SpeechRecognition;
  }
});
test("unexpected session end or unfinished utterance cannot authorize a partial commit", async () => {
  for (const requestedStop of [false, true]) {
    let receive = (event: any) => {}; const output: any[] = [];
    const port = { onEvent(listener: typeof receive) { receive = listener; return () => {}; }, async start() {}, async stop() {}, async cancel() {} };
    const provider = new NativeSpeechInputProvider(port as any, { createId: () => "session" });
    const session = provider.start({ commit: text => output.push(["commit", text]), end: () => output.push(["end"]), error: () => output.push(["error"]) });
    await provider.settled();
    receive({ sessionId: "session", type: "utterance", utteranceId: "one", sequence: 1, phase: "final", text: "Confirmed" });
    if (requestedStop) {
      receive({ sessionId: "session", type: "utterance", utteranceId: "two", sequence: 2, phase: "partial", text: "Incomplete" });
      session.stop(); await provider.settled();
    }
    receive({ sessionId: "session", type: "end" });
    receive({ sessionId: "session", type: "utterance", utteranceId: "two", sequence: 3, phase: "final", text: "Late" });
    assert.deepEqual(output, [["error"]]); await provider.settled();
  }
});
