import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { normalizePcmWav, encodeSpeechWav } from "../plugins/voice-input/src/audio-capture";
import { encodeBotBridgeMessage, parseBotCommand, parseBotToHostMessage } from "../packages/mobile-bot-bridge/src/index";
import { createRequire } from "node:module";
const requireFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { JSDOM } = requireFrontend("jsdom");

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
test("native audio wire rejects stale, malformed and oversized frames", () => {
  const event = { type: "native-audio-event" as const, id: "attempt-a", event: "chunk" as const, index: 0, base64: "AAAA" };
  assert.ok(parseBotCommand(encodeBotBridgeMessage("runtime-a", event), "runtime-a"));
  assert.equal(parseBotCommand(encodeBotBridgeMessage("runtime-a", event), "runtime-b"), null);
  for (const invalid of [{ ...event, index: 100 }, { ...event, base64: "A!AA" }, { ...event, base64: "A".repeat(65540) }]) assert.equal(parseBotCommand(JSON.stringify({ protocol: 1, runtimeId: "r", payload: invalid }), "r"), null);
  assert.equal(parseBotToHostMessage(JSON.stringify({ protocol: 1, runtimeId: "r", payload: { type: "native-audio-request", id: "a", action: "eval" } }), "r"), null);
});
test("normalization validates actual WAV and rejects renamed compressed/truncated audio", async () => {
  const source = encodeSpeechWav([new Float32Array(4800).fill(.2)], 16000);
  const bytes = new Uint8Array(await source.blob.arrayBuffer());
  const normalized = normalizePcmWav(bytes);
  assert.equal(normalized.durationMs, 300); assert.equal(normalized.blob.size, source.blob.size);
  const extra = new Uint8Array(bytes.length + 12); extra.set(bytes.subarray(0, 12)); extra.set([74, 85, 78, 75, 4, 0, 0, 0, 0, 0, 0, 0], 12); extra.set(bytes.subarray(12), 24); new DataView(extra.buffer).setUint32(4, extra.length - 8, true);
  assert.equal(normalizePcmWav(extra).durationMs, 300);
  assert.throws(() => normalizePcmWav(bytes.subarray(0, -1)));
  const compressed = bytes.slice(); compressed[20] = 3; assert.throws(() => normalizePcmWav(compressed));
});

test("native device cancellation holds ownership through pending permission and discards late recording", async () => {
  const output = await build({ entryPoints: ["apps/workbench-expo/src/runtime/mobile-native-audio.ios.ts"], bundle: true, write: false, format: "iife", globalName: "NativeAudio", plugins: [{ name: "device-boundary", setup(builder) {
    builder.onResolve({ filter: /^(expo-audio|expo-file-system)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    builder.onResolve({ filter: /mobile-developer-log$/ }, () => ({ path: "log", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "expo-audio" ? `export const AudioModule = window.device.module; export const AudioQuality = {HIGH:1}; export const IOSOutputFormat = {LINEARPCM:'lpcm'}; export const requestRecordingPermissionsAsync = window.device.permission; export const setAudioModeAsync = async value => { window.device.modes.push(value); };` : args.path === "expo-file-system" ? `export const File = window.device.File;` : `export const mobileDeveloperLog = { log() {} };` }));
  } }] });
  const dom = new JSDOM("", { runScripts: "outside-only" }), w = dom.window;
  let allow!: (permission: { granted: boolean }) => void;
  const recording = encodeSpeechWav([new Float32Array(4800)], 16000);
  const recordingBase64 = Buffer.from(await recording.blob.arrayBuffer()).toString("base64");
  let deleted = 0;
  const recorder = { started: 0, released: 0, isRecording: false, uri: "file:///synthetic.wav", prepareToRecordAsync: async () => {}, record() { this.started++; this.isRecording = true; }, async stop() { this.isRecording = false; }, release() { this.released++; }, getStatus: () => ({ isRecording: true, metering: -80 }) };
  w.device = { modes: [], permission: () => new Promise(resolve => { allow = resolve; }), module: { AudioRecorder: function() { return recorder; } }, File: class { exists = true; size = recording.blob.size; async base64() { return recordingBase64; } delete() { deleted++; } } };
  w.eval(output.outputFiles[0]!.text + ";window.NativeAudio = typeof NativeAudio === 'undefined' ? undefined : NativeAudio; window.Capture = typeof Capture === 'undefined' ? undefined : Capture;");
  const events: { id: string; event: string; reason?: string }[] = [], capture = new w.NativeAudio.MobileNativeAudio((event: typeof events[number]) => events.push(event));
  capture.handle({ type: "native-audio-request", id: "a", action: "start" });
  assert.equal(recorder.started, 0); capture.cancel();
  capture.handle({ type: "native-audio-request", id: "b", action: "start" });
  assert.ok(events.some(event => event.id === "b" && event.reason === "capture"));
  const replacement = new w.NativeAudio.MobileNativeAudio((event: typeof events[number]) => events.push(event));
  replacement.handle({ type: "native-audio-request", id: "next-runtime", action: "start" });
  assert.ok(events.some(event => event.id === "next-runtime" && event.reason === "capture"));
  allow({ granted: true }); await tick(); await tick(); assert.equal(recorder.started, 0);
  capture.handle({ type: "native-audio-request", id: "c", action: "start" }); allow({ granted: true }); await tick();
  assert.equal(recorder.started, 1);
  capture.handle({ type: "native-audio-request", id: "retired", action: "cancel" }); assert.equal(recorder.released, 0);
  capture.cancel(); await tick(); await tick(); assert.equal(recorder.released, 1); assert.equal(deleted, 1);
  capture.handle({ type: "native-audio-request", id: "d", action: "start" }); allow({ granted: true }); await tick();
  capture.handle({ type: "native-audio-request", id: "d", action: "stop" });
  await tick(); await tick(); await tick();
  assert.ok(events.some(event => event.id === "d" && event.event === "complete"));
  assert.equal(recorder.released, 2); assert.equal(deleted, 2); dom.window.close();
});

test("DOM native capture never calls Web microphone, preserves ordered frames and ignores retired request", async () => {
  const output = await build({ entryPoints: ["apps/workbench-web/src/embedded-chat/embedded-native-audio.ts"], bundle: true, write: false, format: "iife", globalName: "Capture" });
  const dom = new JSDOM("", { runScripts: "outside-only", url: "https://lightvela.com" }), w = dom.window;
  const requests: { id: string; action: string }[] = [];
  w.__OPENCRAFT_NATIVE_AUDIO__ = true; w.__LIGHTVELA_BOT_RUNTIME_ID__ = "r";
  w.__LIGHTVELA_BOT_POST__ = (value: typeof requests[number]) => requests.push(value);
  w.Blob = Blob; w.AbortController = AbortController; w.TextEncoder = TextEncoder;
  w.navigator.mediaDevices = { getUserMedia() { throw new Error("Web microphone must not be called"); } };
  w.eval(output.outputFiles[0]!.text + ";window.NativeAudio = typeof NativeAudio === 'undefined' ? undefined : NativeAudio; window.Capture = typeof Capture === 'undefined' ? undefined : Capture;");
  const capture = new w.Capture.EmbeddedNativeAudioCapture(), lifetime = new AbortController();
  const started = capture.start(() => {}, lifetime.signal), id = requests[0]!.id;
  const emit = (event: unknown) => w.dispatchEvent(new w.CustomEvent("opencraft-mobile-bot-command", { detail: JSON.stringify({ protocol: 1, runtimeId: "r", payload: { type: "native-audio-event", id, ...(event as object) } }) }));
  emit({ event: "ready", id: "old" }); emit({ event: "ready" });
  const session = await started, audio = session.stop();
  const fixture = encodeSpeechWav([new Float32Array(4800)], 16000);
  emit({ event: "chunk", index: 0, base64: Buffer.from(await fixture.blob.arrayBuffer()).toString("base64") }); emit({ event: "complete", chunks: 1 });
  assert.equal((await audio).durationMs, 300); assert.equal(requests[1]!.action, "stop");
  const next = capture.start(() => {}, lifetime.signal); lifetime.abort(); await assert.rejects(next);
  assert.equal(requests.at(-1)!.action, "cancel"); dom.window.close();
});
