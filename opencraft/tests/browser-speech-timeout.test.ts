import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSpeechInputProvider } from "../plugins/voice-input/src/speech-input-provider";

test("missing browser speech callbacks time out; cancel and late events remain safe", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "SpeechRecognition");
  let recognition: any;
  class Recognition {
    onstart: any; onend: any; onerror: any; onresult: any;
    aborts = 0;
    start() { recognition = this; }
    stop() {}
    abort() { this.aborts++; throw new Error("browser abort failed"); }
  }
  Object.defineProperty(globalThis, "SpeechRecognition", { configurable: true, value: Recognition });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "SpeechRecognition", descriptor); else Reflect.deleteProperty(globalThis, "SpeechRecognition"); });
  const events: string[] = [];
  const provider = new BrowserSpeechInputProvider();
  const observer = { status: (value: string) => events.push(value), commit: () => events.push("commit"), end: () => events.push("end"), error: () => events.push("error") };
  const pending = provider.start(observer);
  assert.equal(pending.phase, "starting");
  t.mock.timers.tick(15_000);
  assert.deepEqual(events, ["error"]);
  assert.equal(recognition.aborts, 1);
  recognition.onstart(); recognition.onend(); recognition.onerror({ error: "network" });
  assert.deepEqual(events, ["error"]);

  events.length = 0;
  const session = provider.start(observer);
  recognition.onstart();
  assert.equal(session.phase, "listening");
  t.mock.timers.tick(20_000);
  assert.deepEqual(events, ["listening"]);
  session.stop();
  t.mock.timers.tick(8_000);
  recognition.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "late text" } }] });
  recognition.onend();
  assert.deepEqual(events, ["listening", "error"]);

  events.length = 0;
  const cancelled = provider.start(observer);
  assert.doesNotThrow(() => cancelled.cancel());
  t.mock.timers.tick(30_000);
  recognition.onend();
  assert.deepEqual(events, []);
});

test("normal speech completion clears deadlines and commits only once", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "SpeechRecognition");
  let recognition: any;
  class Recognition { onstart: any; onend: any; onerror: any; onresult: any; start() { recognition = this; } stop() {} abort() {} }
  Object.defineProperty(globalThis, "SpeechRecognition", { configurable: true, value: Recognition });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "SpeechRecognition", descriptor); else Reflect.deleteProperty(globalThis, "SpeechRecognition"); });
  const events: string[] = [];
  const session = new BrowserSpeechInputProvider().start({ commit: text => events.push(text), end: () => events.push("end"), error: () => events.push("error") });
  recognition.onstart();
  recognition.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "确认文字" } }] });
  session.stop(); recognition.onend();
  t.mock.timers.tick(30_000);
  recognition.onend(); recognition.onerror({ error: "aborted" });
  assert.deepEqual(events, ["确认文字", "end"]);
});
