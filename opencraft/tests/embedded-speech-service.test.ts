import assert from "node:assert/strict";
import test from "node:test";
import { EmbeddedSpeechService } from "../apps/workbench-web/src/embedded-chat/embedded-speech-service";
import { CloudSpeechInputProvider, TranscriptionFailure } from "../plugins/voice-input/src/cloud-speech";

const capabilities = () => Response.json({ available: true, model: "ep-hyasr3", max_duration_ms: 120000, max_audio_bytes: 3840044 });
const audio = () => ({ blob: new Blob(["synthetic"], { type: "audio/wav" }), durationMs: 1000 });

test("embedded speech sends multipart with login authority, never a provider Key", async () => {
  const calls: string[] = [];
  const service = new EmbeddedSpeechService("https://api.test/", () => "test-session", async (url, init) => {
    calls.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-session");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    if (String(url).endsWith("capabilities")) return capabilities();
    assert.equal(new Headers(init?.headers).has("content-type"), false, "browser owns multipart boundary");
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get("model"), "ep-hyasr3");
    assert.equal(init.body.get("language"), "zh");
    const file = init.body.get("file"); assert.ok(file instanceof Blob);
    assert.equal(await file.text(), "synthetic");
    return Response.json({ text: " 你好 " });
  });
  await service.refresh();
  assert.equal(service.getSnapshot().phase, "ready");
  assert.equal(await service.transcribe(audio(), "session", "attempt", "zh-CN", new AbortController().signal, service.getSnapshot().binding!), "你好");
  assert.deepEqual(calls, ["https://api.test/api/speech/capabilities", "https://api.test/api/speech/transcriptions"]);
  service.close();
});

test("embedded speech rejects late old-account results and does not use a new token", async () => {
  let token = "account-a";
  let resolve!: (response: Response) => void;
  const service = new EmbeddedSpeechService("https://api.test", () => token, async url => String(url).endsWith("capabilities") ? capabilities() : new Promise<Response>(done => { resolve = done; }));
  await service.refresh();
  const promise = service.transcribe(audio(), "session", "attempt", undefined, new AbortController().signal, service.getSnapshot().binding!);
  token = "account-b"; resolve(Response.json({ text: "old account" }));
  await assert.rejects(promise, error => error instanceof TranscriptionFailure && !error.retryable);
  await assert.rejects(service.transcribe(audio(), "session", "attempt", undefined, new AbortController().signal, service.getSnapshot().binding!));
  service.close();
});

test("unavailable production service does not fall back to local preview or system recognition", async () => {
  const service = new EmbeddedSpeechService("https://api.test", () => "test-session", async () => new Response(null, { status: 404 }));
  await service.refresh();
  assert.equal(service.getSnapshot().phase, "unavailable");
  const provider = new CloudSpeechInputProvider(service, { isAvailable: () => true, start: async () => { throw new Error("must not record"); } });
  assert.equal(provider.isAvailable(), false);
  assert.throws(() => provider.start({ commit() {}, error() {}, end() {} }));
  provider.close(); service.close();
});

test("cancel and close abort response-body reads, not only response headers", async () => {
  let aborted = false;
  let reading!: () => void;
  const bodyStarted = new Promise<void>(resolve => { reading = resolve; });
  const service = new EmbeddedSpeechService("https://api.test", () => "test-session", async (url, init) => {
    if (String(url).endsWith("capabilities")) return capabilities();
    return new Response(new ReadableStream({ start(controller) {
      init?.signal?.addEventListener("abort", () => { aborted = true; controller.error(new DOMException("Cancelled", "AbortError")); }, { once: true });
      reading();
    } }), { headers: { "content-type": "application/json" } });
  });
  await service.refresh();
  const promise = service.transcribe(audio(), "session", "attempt", undefined, new AbortController().signal, service.getSnapshot().binding!);
  const rejection = assert.rejects(promise);
  await bodyStarted; service.close(); await rejection;
  assert.equal(aborted, true);
});

test("cloud capability subscription updates after async discovery", async () => {
  const service = new EmbeddedSpeechService("https://api.test", () => "test-session", async () => capabilities());
  const provider = new CloudSpeechInputProvider(service, { isAvailable: () => true, start: async () => { throw new Error("unused"); } });
  const values: boolean[] = []; const unsubscribe = provider.subscribe(() => values.push(provider.isAvailable()));
  assert.equal(provider.isAvailable(), false); await service.refresh(); assert.deepEqual(values, [true]);
  unsubscribe(); provider.close(); service.close();
});

test("authentication and invalid audio failures are non-retryable", async () => {
  const service = new EmbeddedSpeechService("https://api.test", () => "test-session", async url => String(url).endsWith("capabilities") ? capabilities() : new Response(null, { status: 401 }));
  await service.refresh();
  await assert.rejects(service.transcribe(audio(), "session", "attempt", undefined, new AbortController().signal, service.getSnapshot().binding!), error => error instanceof TranscriptionFailure && !error.retryable);
  await assert.rejects(service.transcribe({ ...audio(), durationMs: 120001 }, "session", "attempt", undefined, new AbortController().signal, service.getSnapshot().binding!));
  service.close();
});
