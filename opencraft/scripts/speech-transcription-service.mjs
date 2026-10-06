import { createHash, randomBytes } from "node:crypto";

const MAX_DURATION_MS = 120_000;
const MAX_AUDIO_BYTES = 44 + 16_000 * 2 * MAX_DURATION_MS / 1000;
const ID = /^[a-zA-Z0-9_-]{1,80}$/u;
const ENDPOINT = "https://tokenhub.tencentmaas.com/v1/wand/asrproxy/sync_transcribe";
const TTL = 5 * 60_000;

class SpeechFailure extends Error {
  constructor(code, status = 400, retryable = false) { super(code); Object.assign(this, { code, status, retryable }); }
}
const failure = (code, status, retryable) => new SpeechFailure(code, status, retryable);
function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

/** Only the bounded, mono 16kHz PCM WAV emitted by our capture adapter is accepted. */
export function validateSpeechWav(bytes) {
  if (bytes.length < 44 || bytes.length > MAX_AUDIO_BYTES
    || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE"
    || bytes.toString("ascii", 12, 16) !== "fmt " || bytes.readUInt32LE(16) !== 16
    || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1
    || bytes.readUInt32LE(24) !== 16_000 || bytes.readUInt32LE(28) !== 32_000
    || bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16
    || bytes.toString("ascii", 36, 40) !== "data"
    || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.readUInt32LE(40) !== bytes.length - 44
    || (bytes.length - 44) % 2 !== 0) throw failure("invalid-audio", 400);
  const durationMs = (bytes.length - 44) / 32;
  if (durationMs < 250 || durationMs > MAX_DURATION_MS) throw failure("invalid-audio", 400);
  return durationMs;
}

async function boundedBytes(stream, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw failure("too-large", 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Application service, independent of Agent/SSH Server. No automatic paid-request retries. */
export class SpeechTranscriptionService {
  #config;
  #records = new Map();
  #active = new Set();
  #window = { start: 0, count: 0 };
  #closed = false;
  #configuration;
  constructor({ configuration, apiKey, model = "hy-asr-3.0-preview", fetch: fetcher = globalThis.fetch,
    timeoutMs = 90_000, now = Date.now } = {}) {
    if (!configuration && (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n\0]/u.test(apiKey))) throw new Error("Speech API credential required");
    if (typeof model !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/u.test(model)) throw new Error("Invalid speech model");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Invalid speech deadline");
    this.#configuration = configuration;
    this.#config = { apiKey, model, binding: randomBytes(32).toString("hex"), fetcher, timeoutMs, now };
  }
  capabilities() { return { available: !this.#closed, binding: this.#config.binding, provider: "hunyuan", maxDurationMs: MAX_DURATION_MS, maxAudioBytes: MAX_AUDIO_BYTES }; }
  async describe() {
    if (!this.#configuration) return this.capabilities();
    const { revision, selection, models, binding, config } = await this.#configuration.read();
    return { ...this.capabilities(), available: !this.#closed && config !== null, revision, selection, models, binding };
  }
  async handle(request, response, authorize) {
    const url = new URL(request.url ?? "/", "http://speech.invalid");
    if (!url.pathname.startsWith("/__opencraft_speech/")) return false;
    if (!authorize(request, request.method === "POST")) { json(response, 403, { error: { code: "not-allowed", retryable: false } }); return true; }
    if (url.pathname === "/__opencraft_speech/capabilities" && request.method === "GET") {
      try { json(response, 200, await this.describe()); }
      catch { json(response, 503, { error: { code: "unavailable", retryable: false } }); }
      return true;
    }
    if (url.pathname === "/__opencraft_speech/model" && request.method === "POST") {
      try {
        if (this.#closed || !this.#configuration) throw failure("unavailable", 503);
        if (request.headers["content-type"] !== "application/json") throw failure("invalid-request", 400);
        const data = JSON.parse((await boundedBytes(request, 4096)).toString("utf8"));
        if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(k => k !== "selection" && k !== "expectedRevision")) throw failure("invalid-request", 400);
        await this.#configuration.select(data.expectedRevision, data.selection);
        json(response, 200, await this.describe());
      } catch (error) { json(response, error?.code === "settings-conflict" ? 409 : error instanceof SpeechFailure ? error.status : 400,
        { error: { code: error?.code === "settings-conflict" ? "configuration-changed" : error instanceof SpeechFailure ? error.code : "invalid-request", retryable: false } }); }
      return true;
    }
    if (url.pathname !== "/__opencraft_speech/transcribe" || request.method !== "POST") { json(response, 404, { error: { code: "missing", retryable: false } }); return true; }
    const sessionId = request.headers["x-opencraft-speech-session"], attemptId = request.headers["x-opencraft-speech-attempt"];
    const language = request.headers["x-opencraft-speech-language"];
    const binding = request.headers["x-opencraft-speech-binding"];
    let record, controller;
    const disconnected = () => { if (!response.writableFinished) controller?.abort(); };
    try {
      if (!ID.test(sessionId ?? "") || !ID.test(attemptId ?? "")
        || typeof sessionId !== "string" || typeof attemptId !== "string"
        || request.headers["content-type"] !== "audio/wav"
        || (this.#configuration && (typeof binding !== "string" || !/^[a-f0-9]{64}$/u.test(binding)))
        || (language !== undefined && language !== "zh" && language !== "en")) throw failure("invalid-request", 400);
      if (this.#closed) throw failure("unavailable", 503);
      // Bound admitted upload bodies too, not only calls to the paid upstream.
      if (this.#active.size >= 2) throw failure("busy", 429, true);
      controller = new AbortController(); this.#active.add(controller);
      response.once("close", disconnected); request.once("aborted", disconnected);
      const abortUpload = () => request.destroy();
      controller.signal.addEventListener("abort", abortUpload, { once: true });
      const uploadDeadline = setTimeout(() => controller.abort(), 15_000);
      let audio;
      try { audio = await boundedBytes(request, MAX_AUDIO_BYTES); }
      finally { clearTimeout(uploadDeadline); controller.signal.removeEventListener("abort", abortUpload); }
      validateSpeechWav(audio);
      controller.signal.throwIfAborted();
      // Complete asynchronous resolution before the atomic in-process attempt admission.
      const resolved = this.#configuration ? (await this.#configuration.read()).config : this.#config;
      controller.signal.throwIfAborted();
      const now = this.#config.now();
      for (const [key, item] of this.#records) if (item.expires <= now && item.state !== "running") this.#records.delete(key);
      const key = `${sessionId}:${attemptId}`, digest = createHash("sha256").update(audio).digest("hex");
      const previous = this.#records.get(key);
      if (previous) {
        if (previous.digest !== digest || previous.language !== language || previous.binding !== binding) throw failure("invalid-request", 409);
        if (previous.state === "running") throw failure("busy", 409, true);
        json(response, previous.status, previous.body); return true;
      }
      // Resolve at the last pre-billing boundary. Never substitute a new selection for old audio.
      if (!resolved) throw failure("unavailable", 503);
      if (this.#configuration && resolved.binding !== binding) throw failure("configuration-changed", 409);
      if (this.#records.size >= 64) throw failure("busy", 429, true);
      if (now - this.#window.start >= 60_000) this.#window = { start: now, count: 0 };
      if (this.#window.count >= 10) throw failure("busy", 429, true);
      this.#window.count++;
      record = { digest, language, binding, state: "running", expires: now + TTL };
      this.#records.set(key, record);
      const deadline = setTimeout(() => controller.abort(), this.#config.timeoutMs);
      try {
        const result = await this.#config.fetcher(ENDPOINT, {
          method: "POST", signal: controller.signal, redirect: "error",
          headers: { authorization: `Bearer ${resolved.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: resolved.model, data: audio.toString("base64"), voice_encode_format: "wav", ...(language ? { source: language } : {}) }),
        });
        if (!result.ok) throw failure(result.status === 401 || result.status === 403 ? "unavailable" : "service-error", 502, result.status === 429 || result.status >= 500);
        const data = JSON.parse((await boundedBytes(result.body, 128 * 1024)).toString("utf8"));
        if (data?.status !== "completed" || typeof data?.output?.text !== "string" || data.output.text.length > 32_000) throw failure("service-error", 502);
        const text = data.output.text.trim();
        if (!text) throw failure("no-speech", 422);
        controller.signal.throwIfAborted();
        record.state = "finished"; record.status = 200; record.body = { sessionId, attemptId, text };
        json(response, 200, record.body);
      } finally { clearTimeout(deadline); }
    } catch (error) {
      // Never propagate vendor error bodies, transcript, credential, or raw diagnostics.
      const safe = error instanceof SpeechFailure ? error : failure("service-error", 502, true);
      const body = { error: { code: safe.code, retryable: safe.retryable } };
      if (record) { record.state = "finished"; record.status = safe.status; record.body = body; }
      if (!response.destroyed) json(response, safe.status, body);
    } finally {
      response.off("close", disconnected); request.off("aborted", disconnected);
      if (controller) this.#active.delete(controller);
    }
    return true;
  }
  close() { this.#closed = true; for (const controller of this.#active) controller.abort(); this.#records.clear(); }
}
