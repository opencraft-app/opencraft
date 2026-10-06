import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { createWorkbenchWebServer } from "../scripts/serve-workbench-web.mjs";
import { SpeechTranscriptionService, validateSpeechWav } from "../scripts/speech-transcription-service.mjs";
import { encodeSpeechWav, type AudioCapturePort } from "../plugins/voice-input/src/audio-capture";
import { CloudSpeechInputProvider, SpeechServiceClient } from "../plugins/voice-input/src/cloud-speech";
import type { SpeechInputObserver } from "../plugins/voice-input/src/speech-input-provider";
import { MemoryUiPreferenceStore, UiPreferencesRuntime } from "../packages/ui-preferences/src/index";

const audio = () => encodeSpeechWav([new Float32Array(16_000).fill(0.1)], 16_000);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function gateway(t: any, fetcher: typeof fetch, extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "opencraft-speech-test-"));
  await writeFile(join(root, "index.html"), "<!doctype html>");
  const service = new SpeechTranscriptionService({ apiKey: "test-not-a-secret", fetch: fetcher, ...extra });
  const server = await createWorkbenchWebServer({ root, loopbackOnly: true, appServerTarget: null, speechService: service });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  return { service, origin, post: (attempt = "attempt", body = audio().blob, language = "zh", suppliedOrigin = origin) => fetch(`${origin}/__opencraft_speech/transcribe`, {
    method: "POST", headers: { origin: suppliedOrigin, "content-type": "audio/wav", "x-opencraft-speech-session": "session", "x-opencraft-speech-attempt": attempt, "x-opencraft-speech-language": language }, body,
  }) };
}

test("canonical WAV is bounded, mono PCM and validates actual duration; compressed/forged audio rejected", async () => {
  const clip = encodeSpeechWav([new Float32Array(48_000).fill(0.2), new Float32Array(48_000).fill(0.4)], 48_000);
  const bytes = Buffer.from(await clip.blob.arrayBuffer());
  assert.equal(bytes.length, 32_044); assert.equal(validateSpeechWav(bytes), 1000);
  assert.equal(bytes.readInt16LE(44), Math.trunc(0.3 * 32767));
  assert.throws(() => encodeSpeechWav([new Float32Array(1)], 16_000));
  assert.throws(() => encodeSpeechWav([new Float32Array(16_000 * 121)], 16_000));
  assert.throws(() => validateSpeechWav(Buffer.from("not a WAV")));
  const forged = Buffer.from(bytes); forged.writeUInt32LE(8000, 24); assert.throws(() => validateSpeechWav(forged));
});

test("gateway uses backend credential and Base64 once; duplicate attempt is cached, audio binding immutable", async t => {
  let calls = 0;
  const { origin, post } = await gateway(t, async (url, init) => {
    calls++; assert.equal(url, "https://tokenhub.tencentmaas.com/v1/wand/asrproxy/sync_transcribe");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-not-a-secret");
    assert.equal(init?.redirect, "error");
    const value = JSON.parse(String(init?.body)); assert.equal(value.model, "hy-asr-3.0-preview"); assert.equal(value.voice_encode_format, "wav");
    assert.equal(validateSpeechWav(Buffer.from(value.data, "base64")), 1000); assert.equal(value.source, "zh"); assert.equal(value.input_url, undefined);
    return Response.json({ status: "completed", output: { text: "  你好，混元。  " } });
  });
  const capabilities = await (await fetch(`${origin}/__opencraft_speech/capabilities`)).json();
  assert.equal(capabilities.provider, "hunyuan"); assert.equal(JSON.stringify(capabilities).includes("test-not-a-secret"), false);
  assert.deepEqual(await (await post()).json(), { sessionId: "session", attemptId: "attempt", text: "你好，混元。" });
  assert.equal((await post()).status, 200); assert.equal(calls, 1);
  const changed = encodeSpeechWav([new Float32Array(16_000).fill(0.8)], 16_000);
  assert.equal((await post("attempt", changed.blob)).status, 409);
  assert.equal((await post("attempt", audio().blob, "en")).status, 409); assert.equal(calls, 1);
});

test("admission rejects cross-origin and invalid audio before any paid request; failures redact upstream", async t => {
  let calls = 0;
  const { post } = await gateway(t, async () => { calls++; return new Response("private vendor payload", { status: 500 }); });
  assert.equal((await post("bad-origin", audio().blob, "zh", "https://foreign.invalid")).status, 403);
  assert.equal((await post("bad-audio", new Blob(["not audio"], { type: "audio/wav" }))).status, 400);
  assert.equal(calls, 0);
  const result = await post("error"); assert.equal(result.status, 502);
  assert.deepEqual(await result.json(), { error: { code: "service-error", retryable: true } });
  assert.equal((await post("error")).status, 502); assert.equal(calls, 1);
});

test("deadline aborts upstream; incomplete or empty result never becomes transcript", async t => {
  let aborted = false;
  const { post } = await gateway(t, async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("private failure")); }, { once: true });
  }), { timeoutMs: 20 });
  assert.equal((await post()).status, 502); assert.equal(aborted, true);
  const empty = await gateway(t, async () => Response.json({ status: "completed", output: { text: " " } }));
  assert.equal((await empty.post()).status, 422);
  const incomplete = await gateway(t, async () => Response.json({ status: "queued", output: { text: "must not commit" } }));
  assert.equal((await incomplete.post()).status, 502);
});

test("two admitted calls bound concurrency; shutdown aborts both and closes capability", async t => {
  let calls = 0, aborted = 0;
  const { service, post } = await gateway(t, async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { aborted++; reject(new Error("private shutdown diagnostic")); }, { once: true });
    });
  });
  const pending = [post("first"), post("second")];
  for (let tries = 0; tries < 50 && calls < 2; tries++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 2);
  assert.equal((await post("third")).status, 429); assert.equal(calls, 2);
  service.close();
  assert.equal(service.capabilities().available, false);
  for (const result of await Promise.all(pending)) {
    assert.equal(result.status, 502);
    assert.deepEqual(await result.json(), { error: { code: "service-error", retryable: true } });
  }
  assert.equal(aborted, 2); assert.equal((await post("closed")).status, 503);
});

test("shutdown releases an admitted partial upload before the upload deadline", { timeout: 2000 }, async t => {
  let calls = 0, entered!: () => void;
  const admitted = new Promise<void>(resolve => { entered = resolve; });
  const { service, origin } = await gateway(t, async () => { calls++; throw new Error("must not submit partial audio"); });
  const handle = service.handle.bind(service);
  service.handle = (...args: any[]) => { const result = handle(...args); entered(); return result; };
  const client = httpRequest(`${origin}/__opencraft_speech/transcribe`, { method: "POST", headers: {
    origin, "content-type": "audio/wav", "content-length": audio().blob.size,
    "x-opencraft-speech-session": "slow", "x-opencraft-speech-attempt": "partial",
  } });
  t.after(() => client.destroy());
  const closed = new Promise<void>(resolve => client.once("error", () => resolve()));
  client.write(Buffer.from(await audio().blob.arrayBuffer()).subarray(0, 44));
  await admitted; service.close(); await closed;
  assert.equal(calls, 0);
});

test("public speech requires separate operator opt-in even with an API credential", async t => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-speech-public-test-"));
  await writeFile(join(root, "index.html"), "<!doctype html>");
  const service = new SpeechTranscriptionService({ apiKey: "test-not-a-secret", fetch: async () => { throw new Error("must not call"); } });
  const server = await createWorkbenchWebServer({ root, speechService: service, speechPublicAccess: false });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/__opencraft_speech/capabilities`)).status, 403);
});

async function providerFixture(run: (body: any, signal: AbortSignal) => Promise<Response>) {
  let captures = 0, stops = 0, releases = 0;
  const service = new SpeechServiceClient(async (url, init) => url === "/__opencraft_speech/capabilities" ? Response.json({ available: true, binding: "a".repeat(64), provider: "hunyuan", maxDurationMs: 120_000, maxAudioBytes: 3_840_044 }) : run(init, init!.signal!));
  await service.refresh();
  const capture: AudioCapturePort = { isAvailable: () => true, async start() {
    captures++; return { async stop() { stops++; return audio(); }, cancel() { releases++; } };
  } };
  const provider = new CloudSpeechInputProvider(service, capture), events: unknown[] = [];
  let retry: (() => void) | undefined;
  const observer: SpeechInputObserver = { commit: text => events.push(["commit", text]), end: () => events.push(["end"]),
    error: error => events.push(["error", error.message]), recover: (error, action) => { events.push(["recover", error.message]); retry = action; } };
  return { provider, observer, events, retry: () => retry?.(), stats: () => ({ captures, stops, releases }) };
}
const transcript = (init: RequestInit, text = "你好") => Response.json({ sessionId: new Headers(init.headers).get("x-opencraft-speech-session"), attemptId: new Headers(init.headers).get("x-opencraft-speech-attempt"), text });

test("cloud stop coalesces, finalized transcript once; capture is exclusive and cancellation fences late result", async () => {
  let finish!: (value: Response) => void, pending: RequestInit;
  const fixture = await providerFixture(async init => { pending = init; return new Promise(resolve => { finish = resolve; }); });
  const session = fixture.provider.start(fixture.observer); assert.throws(() => fixture.provider.start(fixture.observer));
  session.stop(); session.stop(); await tick(); assert.equal(fixture.stats().stops, 1);
  session.cancel(); finish(transcript(pending!)); await tick(); assert.deepEqual(fixture.events, []);
  const next = fixture.provider.start(fixture.observer); next.stop(); await tick(); finish(transcript(pending!)); await tick();
  assert.deepEqual(fixture.events, [["commit", "你好"], ["end"]]); fixture.provider.close();
});

test("explicit retry uses immutable same audio and new attempt, without recapture or automatic retry", async () => {
  const bodies: Blob[] = [], ids: string[] = [];
  const fixture = await providerFixture(async init => {
    bodies.push(init.body); ids.push(new Headers(init.headers).get("x-opencraft-speech-attempt")!);
    return bodies.length === 1 ? Response.json({ error: { code: "service-error", retryable: true } }, { status: 502 }) : transcript(init);
  });
  fixture.provider.start(fixture.observer).stop(); await tick(); assert.equal(bodies.length, 1);
  assert.equal((fixture.events[0] as any)[0], "recover"); fixture.retry(); fixture.retry(); await tick();
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); assert.notEqual(ids[0], ids[1]);
  assert.equal(fixture.stats().captures, 1); assert.deepEqual(fixture.events.slice(1), [["commit", "你好"], ["end"]]);
});

test("voice preference uses shared CAS persistence, validates values and survives reopening", async () => {
  const store = new MemoryUiPreferenceStore(), first = await UiPreferencesRuntime.open({ installation: store });
  assert.equal(first.get("voice.inputProvider"), "auto"); await first.set("voice.inputProvider", "hunyuan");
  const second = await UiPreferencesRuntime.open({ installation: store }); assert.equal(second.get("voice.inputProvider"), "hunyuan");
  await assert.rejects(first.set("voice.inputProvider", "bad" as any)); await first.close(); await second.close();
});

test("capability contract mismatch, closed service and provider cannot record or upload", async () => {
  const service = new SpeechServiceClient(async () => Response.json({ available: true, provider: "hunyuan", maxDurationMs: 999_999, maxAudioBytes: 1 }));
  await service.refresh(); assert.equal(service.getSnapshot().phase, "unavailable"); service.close();
  await assert.rejects(service.transcribe(audio(), "session", "attempt", undefined, new AbortController().signal));
  const fixture = await providerFixture(async init => transcript(init)); fixture.provider.close();
  assert.equal(fixture.provider.isAvailable(), false); assert.throws(() => fixture.provider.start(fixture.observer));
});

test("pending microphone completion after cancel is released and cannot publish listening or submit", async () => {
  let complete!: (session: any) => void, releases = 0, calls = 0;
  const service = new SpeechServiceClient(async url => {
    if (url === "/__opencraft_speech/capabilities") return Response.json({ available: true, binding: "a".repeat(64), provider: "hunyuan", maxDurationMs: 120_000, maxAudioBytes: 3_840_044 });
    calls++; throw new Error("must not upload");
  });
  await service.refresh();
  const provider = new CloudSpeechInputProvider(service, { isAvailable: () => true, start: () => new Promise(resolve => { complete = resolve; }) });
  const events: any[] = [];
  const session = provider.start({ commit: text => events.push(text), end: () => events.push("end"), error: error => events.push(error), status: status => events.push(status) });
  session.stop(); session.cancel(); complete({ stop: async () => { throw new Error("must not stop/transcribe"); }, cancel: () => { releases++; } });
  await tick(); assert.equal(calls, 0); assert.deepEqual(events, ["transcribing"]); assert.ok(releases >= 1); provider.close(); service.close();
});

test("retry audio expires, cancellation revokes retry, and no failure automatically creates a new attempt", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = await providerFixture(async () => Response.json({ error: { code: "busy", retryable: true } }, { status: 429 }));
  const session = fixture.provider.start(fixture.observer); session.stop(); await tick();
  fixture.retry(); await tick(); // Reset the expiry under the test clock.
  t.mock.timers.tick(120_001); await tick();
  assert.equal((fixture.events.at(-1) as any)[0], "error"); assert.equal(fixture.stats().captures, 1);
  const before = fixture.events.length; fixture.retry(); await tick(); assert.equal(fixture.events.length, before);
  fixture.provider.close();
});

test("duplicate running attempts and admission quota never multiply paid calls", async t => {
  let release!: () => void, calls = 0;
  const { post } = await gateway(t, async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); return Response.json({ status: "completed", output: { text: "done" } }); });
  const first = post("one");
  for (let tries = 0; tries < 20 && calls === 0; tries++) await tick();
  assert.equal(calls, 1); assert.equal((await post("one")).status, 409); assert.equal(calls, 1);
  release(); assert.equal((await first).status, 200);
  const quota = await gateway(t, async () => Response.json({ status: "completed", output: { text: "done" } }));
  for (let index = 0; index < 10; index++) assert.equal((await quota.post(`quota-${index}`)).status, 200);
  assert.equal((await quota.post("overflow")).status, 429);
});
