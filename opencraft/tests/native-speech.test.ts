import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { NativeSpeechManager } from "../apps/workbench-electron/src/native-speech.js";
import { NativeSpeechInputProvider } from "../plugins/voice-input/src/native-speech-provider.js";
import { DictationCompletion } from "../plugins/voice-input/src/dictation-completion.js";
import { DictationPressGesture } from "../plugins/voice-input/src/dictation-press-gesture.js";

const utterance = (text: string, phase: "partial" | "final" = "partial") => ({ type: "utterance", utteranceId: "native-task", sequence: 1, phase, text });

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); writes: any[] = [];
  stdin = { write: (line: string) => {
    const frame = JSON.parse(line); this.writes.push(frame);
    if (frame.type === "cancel") queueMicrotask(() => { this.emit("exit", 0); this.emit("close", 0); });
  } };
  kill() { queueMicrotask(() => { this.emit("exit", 0); this.emit("close", 0); }); return true; }
  event(event: any) { this.stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n")); }
}
test("finish waits for final recognition, stops once and canceled results cannot authorize send", async () => {
  const completion = new DictationCompletion(); let stops = 0, settled = false;
  const pending = completion.finish(() => { stops++; }); pending.then(() => { settled = true; });
  assert.equal(completion.finish(() => { stops++; }), pending);
  await Promise.resolve(); assert.equal(settled, false); assert.equal(stops, 1);
  completion.settle(false); completion.settle(true);
  assert.equal(await pending, false);
});
test("Codex hold gesture starts once, release finishes and synthesized click never restarts", () => {
  let fire = () => {}, starts = 0, finishes = 0;
  const gesture = new DictationPressGesture({ schedule(callback) { fire = callback; return () => { fire = () => {}; }; } });
  gesture.press(() => { starts++; }, () => { finishes++; }); fire(); gesture.release(); gesture.release();
  assert.equal(starts, 1); assert.equal(finishes, 1); assert.equal(gesture.consumeClick(), true); assert.equal(gesture.consumeClick(), false);
  gesture.press(() => { starts++; }, () => { finishes++; }); gesture.reset(); fire();
  assert.equal(starts, 1);
});
test("hold release belongs to its pointer even when the trigger becomes inert", () => {
  let fire = () => {}, finishes = 0;
  const gesture = new DictationPressGesture({ schedule(callback) { fire = callback; return () => {}; } });
  gesture.press(() => {}, () => { finishes++; }, 7); fire();
  gesture.release(8); assert.equal(finishes, 0);
  gesture.release(7); assert.equal(finishes, 1);
});

test("native microphone has one owner and late events cannot enter a replacement session", async () => {
  const processes: FakeProcess[] = [], events: any[] = [];
  const manager = new NativeSpeechManager({ spawn: () => { const child = new FakeProcess(); processes.push(child); return child as any; } });
  await manager.start(1, "first", {}, event => events.push(event));
  await assert.rejects(manager.start(2, "other", {}, () => {}), /busy/);
  assert.equal(await manager.cancel(2, "first"), false);
  const old = processes[0]!;
  old.event(utterance("First"));
  await manager.cancel(1, "first");
  await manager.start(1, "second", {}, event => events.push(event));
  old.event(utterance("Late", "final")); old.emit("exit", 0);
  processes[1]!.event(utterance("Second"));
  assert.deepEqual(events.filter(event => event.text).map(event => [event.sessionId, event.text]), [["first", "First"], ["second", "Second"]]);
  await manager.close();
});

test("native renderer cancels pending session and never delivers partial or late final text", async () => {
  const calls: any[] = []; let listener: (event: any) => void = () => {};
  let accepted!: () => void; const pending = new Promise<void>(resolve => { accepted = resolve; });
  const port = { start: async (...args: any[]) => { calls.push(["start", ...args]); await pending; },
    stop: async (id: string) => { calls.push(["stop", id]); }, cancel: async (id: string) => { calls.push(["cancel", id]); },
    onEvent: (next: typeof listener) => { listener = next; return () => {}; } };
  const provider = new NativeSpeechInputProvider(port as any, { createId: () => "session" });
  const output: any[] = [];
  const session = provider.start({ commit: text => output.push(["final", text]), end: () => output.push(["end"]), error: error => output.push(["error", error]) });
  listener({ sessionId: "foreign", ...utterance("Wrong", "final") });
  listener({ sessionId: "session", ...utterance("Hello") });
  listener({ sessionId: "session", ...utterance("Hello world", "final"), sequence: 2 });
  session.cancel(); accepted();
  listener({ sessionId: "session", ...utterance("Late", "final"), sequence: 3 });
  await provider.settled();
  assert.deepEqual(output, []);
  assert.equal(calls.some(call => call[0] === "cancel"), true);
});
test("native Chinese text survives stdout chunks split inside UTF-8 characters", async () => {
  const child = new FakeProcess(), output: any[] = [];
  const manager = new NativeSpeechManager({ spawn: () => child as any });
  try {
    await manager.start(1, "utf8", {}, event => output.push(event));
    const encoded = Buffer.from(JSON.stringify(utterance("你好")) + "\n");
    const boundary = encoded.indexOf(Buffer.from("你")) + 1;
    child.stdout.emit("data", encoded.subarray(0, boundary));
    child.stdout.emit("data", encoded.subarray(boundary));
    assert.equal(output[0]?.text, "你好");
  } finally { await manager.close(); }
});
test("cancel asks native recognition to release its task before process termination", async () => {
  const child = new FakeProcess(), manager = new NativeSpeechManager({ spawn: () => child as any });
  await manager.start(1, "cancel", {}, () => {});
  await manager.cancel(1, "cancel");
  assert.equal(child.writes.at(-1)?.type, "cancel");
});
test("process exit does not discard the final stdout frames before close", async () => {
  const child = new FakeProcess(), output: any[] = [], manager = new NativeSpeechManager({ spawn: () => child as any });
  try {
    await manager.start(1, "drain", {}, event => output.push(event));
    child.emit("exit", 0);
    child.event(utterance("最终文字", "final")); child.event({ type: "end" }); child.emit("close", 0);
    assert.deepEqual(output.map(event => event.type), ["utterance", "end"]);
  } finally { await manager.close(); }
});
test("stop is idempotent while native finalization is pending", async () => {
  const child = new FakeProcess(), manager = new NativeSpeechManager({ spawn: () => child as any });
  try {
    await manager.start(1, "stop", {}, () => {});
    await manager.stop(1, "stop"); await manager.stop(1, "stop");
    assert.equal(child.writes.filter(frame => frame.type === "stop").length, 1);
  } finally { await manager.close(); }
});
test("owner teardown drains capture and rejects all late native results", async () => {
  const child = new FakeProcess(), events: any[] = [], manager = new NativeSpeechManager({ spawn: () => child as any });
  await manager.start(1, "unmount", {}, event => events.push(event));
  const draining = manager.releaseOwner(1);
  child.event(utterance("Late after renderer teardown", "final"));
  await draining;
  assert.deepEqual(events, []);
  await manager.close();
  await assert.rejects(manager.start(1, "after-close", {}, () => {}), /closing/);
});
test("stop timeout reports one error and releases physical ownership", async () => {
  const child = new FakeProcess(), events: any[] = [], manager = new NativeSpeechManager({ spawn: () => child as any, stopTimeoutMs: 5 });
  await manager.start(1, "timeout", {}, event => events.push(event));
  await manager.stop(1, "timeout");
  await new Promise(resolve => setTimeout(resolve, 20));
  child.event(utterance("Late after timeout", "final"));
  assert.deepEqual(events.map(event => event.type), ["error"]);
  assert.equal(child.writes.at(-1)?.type, "cancel");
  await manager.close();
});
test("native audio meter is numeric, session stamped and rejects out-of-range data", async () => {
  const child = new FakeProcess(), output: any[] = [], manager = new NativeSpeechManager({ spawn: () => child as any });
  try {
    await manager.start(1, "meter", {}, event => output.push(event));
    child.event({ type: "level", level: 0.4, sessionId: "forged", audio: "not forwarded" });
    assert.deepEqual(output[0], { sessionId: "meter", type: "level", level: 0.4 });
    child.event({ type: "level", level: 2 });
    assert.equal(output.at(-1)?.type, "error");
  } finally { await manager.close(); }
});
