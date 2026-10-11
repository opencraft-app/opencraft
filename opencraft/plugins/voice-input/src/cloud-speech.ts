import { BrowserAudioCapture, type AudioCapturePort, type AudioCaptureSession, type RecordedAudio } from "./audio-capture";
import type { SpeechInputError, SpeechInputObserver, SpeechInputProvider, SpeechInputSession } from "./speech-input-provider";
export { normalizePcmWav } from "./audio-capture";
export type { AudioCapturePort, AudioCaptureSession, RecordedAudio } from "./audio-capture";

export type VoiceProviderChoice = "auto" | "system" | "hunyuan";
export interface VoiceInputPreference { readonly provider: VoiceProviderChoice; setProvider(value: VoiceProviderChoice): Promise<void> }
export interface SpeechModelSelection { readonly providerId: string; readonly modelId: string }
export interface SpeechServiceSnapshot {
  readonly phase: "loading" | "ready" | "unavailable";
  readonly binding: string | null;
  readonly revision: number | null;
  readonly selection: SpeechModelSelection | null;
  readonly models: readonly (SpeechModelSelection & { readonly name: string; readonly enabled: boolean })[];
}
const emptySnapshot: SpeechServiceSnapshot = { phase: "loading", binding: null, revision: null, selection: null, models: [] };
/** Application-owned transcription transport; no capture, Draft or provider credential ownership. */
export interface SpeechServicePort {
  getSnapshot(): SpeechServiceSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  transcribe(audio: RecordedAudio, sessionId: string, attemptId: string, language: string | undefined, signal: AbortSignal, binding?: string): Promise<string>;
  close(): void;
}
function decodeCapabilities(value: unknown): SpeechServiceSnapshot {
  if (!value || typeof value !== "object") throw new Error("语音服务暂不可用");
  const v = value as Record<string, unknown>;
  const selection = v.selection as SpeechModelSelection | null | undefined;
  if (selection && (typeof selection.providerId !== "string" || typeof selection.modelId !== "string")) throw new Error("语音设置无效");
  const models = v.models === undefined ? [] : v.models;
  if (!Array.isArray(models) || models.length > 1000 || models.some(m => !m || typeof m.providerId !== "string" || typeof m.modelId !== "string" || typeof m.name !== "string" || typeof m.enabled !== "boolean")) throw new Error("语音模型列表无效");
  const ready = v.available === true && v.provider === "hunyuan" && v.maxDurationMs === 120_000
    && v.maxAudioBytes === 3_840_044 && typeof v.binding === "string" && /^[a-f0-9]{64}$/u.test(v.binding);
  return { phase: ready ? "ready" : "unavailable", binding: ready ? v.binding as string : null,
    revision: Number.isSafeInteger(v.revision) && Number(v.revision) >= 0 ? v.revision as number : null, selection: selection ?? null,
    models: models.map(m => ({ providerId: m.providerId, modelId: m.modelId, name: m.name, enabled: m.enabled })) };
}
export class SpeechServiceClient {
  private snapshot: SpeechServiceSnapshot = emptySnapshot;
  private listeners = new Set<() => void>();
  private discovery: AbortController | null = null;
  private selectionController: AbortController | null = null;
  private closed = false;
  constructor(private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private retireDiscovery() { this.discovery?.abort(); this.discovery = null; }
  async refresh(): Promise<void> {
    if (this.closed) return;
    this.discovery?.abort(); const controller = new AbortController(); this.discovery = controller;
    const deadline = setTimeout(() => controller.abort(), 5000);
    try {
      const result = await this.fetcher("/__opencraft_speech/capabilities", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      const value: unknown = result.ok ? await result.json() : null;
      if (!this.closed && this.discovery === controller) this.publish(decodeCapabilities(value));
    } catch { if (!this.closed && this.discovery === controller) this.publish({ ...this.snapshot, phase: "unavailable", binding: null }); }
    finally { clearTimeout(deadline); }
  }
  private publish(snapshot: SpeechServiceSnapshot) { this.snapshot = snapshot; for (const listener of this.listeners) listener(); }
  async selectModel(selection: SpeechModelSelection | null): Promise<void> {
    if (this.closed || this.snapshot.revision === null) throw new Error("语音设置暂不可用，请刷新后重试");
    if (this.selectionController) throw new Error("正在保存语音设置");
    this.retireDiscovery();
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 5000);
    this.selectionController = controller;
    try {
      const response = await this.fetcher("/__opencraft_speech/model", { method: "POST", credentials: "same-origin", signal: controller.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ selection, expectedRevision: this.snapshot.revision }) });
      if (!response.ok) throw new Error(response.status === 409 ? "配置已更新，请刷新后重试" : "未能保存语音模型，请刷新后核对");
      const next = decodeCapabilities(await response.json());
      this.retireDiscovery();
      if (!this.closed) this.publish(next);
    } catch (error) { throw error instanceof Error && !controller.signal.aborted ? error : new Error("保存结果尚未确认，请刷新后核对"); }
    finally { clearTimeout(deadline); if (this.selectionController === controller) this.selectionController = null; }
  }
  async transcribe(audio: RecordedAudio, sessionId: string, attemptId: string, language: string | undefined, signal: AbortSignal, binding?: string): Promise<string> {
    signal.throwIfAborted();
    if (this.closed) throw new TranscriptionFailure("语音服务已关闭", false);
    if (audio.blob.type !== "audio/wav" || audio.blob.size > 3_840_044 || audio.durationMs < 250 || audio.durationMs > 120_000) throw new TranscriptionFailure("录音不符合要求，请重新录制", false);
    const source = language?.split(/[-_]/u)[0]?.toLowerCase();
    const response = await this.fetcher("/__opencraft_speech/transcribe", { method: "POST", credentials: "same-origin", signal,
      headers: { "content-type": "audio/wav", "x-opencraft-speech-session": sessionId, "x-opencraft-speech-attempt": attemptId,
        ...(binding ? { "x-opencraft-speech-binding": binding } : {}),
        ...(source === "zh" || source === "en" ? { "x-opencraft-speech-language": source } : {}) }, body: audio.blob });
    const body: unknown = await response.json();
    signal.throwIfAborted();
    if (!response.ok) {
      const error = body && typeof body === "object" && "error" in body ? body.error : null;
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      const retryable = error && typeof error === "object" && "retryable" in error && error.retryable === true;
      const message = code === "configuration-changed" ? "语音设置已改变，请重新录音" : code === "busy" ? "语音服务繁忙，请稍后重试" : code === "no-speech" ? "未听到语音，请重新录制"
        : code === "unavailable" || code === "not-allowed" ? "语音服务暂不可用，请检查设置" : code === "invalid-audio" || code === "too-large" ? "录音不符合要求，请重新录制" : "转写失败，可以重试";
      throw new TranscriptionFailure(message, Boolean(retryable));
    }
    if (!body || typeof body !== "object" || !("sessionId" in body) || body.sessionId !== sessionId
      || !("attemptId" in body) || body.attemptId !== attemptId || !("text" in body) || typeof body.text !== "string"
      || !body.text.trim() || body.text.length > 32_000) throw new TranscriptionFailure("转写结果无效，请重新录制", false);
    return body.text.trim();
  }
  close() { this.closed = true; this.discovery?.abort(); this.selectionController?.abort(); this.listeners.clear(); }
}
export class TranscriptionFailure extends Error { constructor(message: string, readonly retryable: boolean) { super(message); } }

/** Owns an ephemeral audio session, never a Draft, View or selected execution Server. */
export class CloudSpeechInputProvider implements SpeechInputProvider {
  readonly id = "opencraft.hunyuan-speech";
  readonly unavailableMessage: string;
  private active: SpeechInputSession | null = null;
  private closed = false;
  constructor(readonly service: SpeechServicePort, private readonly capture: AudioCapturePort = new BrowserAudioCapture(),
    options: { readonly unavailableMessage?: string } = {}) {
    this.unavailableMessage = options.unavailableMessage ?? "混元语音服务尚未就绪，请检查语音设置";
  }
  subscribe = (listener: () => void) => this.service.subscribe(listener);
  isAvailable() { return !this.closed && this.service.getSnapshot().phase === "ready" && this.capture.isAvailable(); }
  start(observer: SpeechInputObserver, options: { readonly language?: string } = {}): SpeechInputSession {
    if (!this.isAvailable()) throw new Error(this.unavailableMessage);
    if (this.active) throw new Error("另一个输入框正在听写");
    const binding = this.service.getSnapshot().binding!;
    const sessionId = crypto.randomUUID(), lifetime = new AbortController();
    let physical: AudioCaptureSession | null = null, audio: RecordedAudio | null = null, attempt: AbortController | null = null;
    let done = false, stopping = false, running = false, attempts = 0;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    const release = () => { clearTimeout(recoveryTimer); physical?.cancel(); physical = null; audio = null; lifetime.abort(); attempt?.abort(); if (this.active === session) this.active = null; };
    const fail = (error: SpeechInputError) => { if (done) return; done = true; release(); observer.error(error); };
    const transcribe = async () => {
      if (done || running || !audio) return;
      clearTimeout(recoveryTimer); running = true; attempts++;
      const current = new AbortController(); attempt = current; const attemptId = crypto.randomUUID();
      const deadline = setTimeout(() => current.abort(), 100_000);
      observer.status?.("transcribing");
      try {
        const text = await this.service.transcribe(audio, sessionId, attemptId, options.language, current.signal, binding);
        if (done || current !== attempt || current.signal.aborted) return;
        done = true; release(); observer.commit(text); observer.end();
      } catch (error) {
        if (done || current !== attempt) return;
        const retryable = !(error instanceof TranscriptionFailure) || error.retryable;
        const safe = { code: "network" as const, message: error instanceof TranscriptionFailure ? error.message : "转写失败，可以重试" };
        running = false;
        if (retryable && observer.recover && attempts < 3) {
          recoveryTimer = setTimeout(() => fail({ code: "network", message: "录音已过期，请重新录制" }), 120_000);
          observer.recover(safe, () => { if (!done) void transcribe(); });
        } else fail(safe);
      } finally { clearTimeout(deadline); if (attempt === current) running = false; }
    };
    let ready: Promise<AudioCaptureSession>;
    const session: SpeechInputSession = {
      phase: "starting",
      stop: () => {
        if (done || stopping) return; stopping = true;
        observer.status?.("transcribing");
        void ready.then(async value => {
          if (done) { value.cancel(); return; }
          physical = value; audio = await value.stop();
          if (!done) await transcribe();
        }).catch(() => fail({ code: "audio-capture", message: "无法完成录音，请重新录制" }));
      },
      cancel: () => { if (done) return; done = true; release(); },
    };
    this.active = session;
    try {
      ready = this.capture.start(value => { if (!done && !stopping) observer.level?.(value); }, lifetime.signal,
        () => fail({ code: "audio-capture", message: "录音中断，请重新录制" }));
    } catch { fail({ code: "audio-capture", message: "无法开始录音，请检查麦克风" }); return session; }
    void ready.then(value => { if (done) value.cancel(); else { physical = value; if (!stopping) observer.status?.("listening"); } },
      error => fail({ code: "audio-capture", message: error instanceof DOMException && error.name === "NotAllowedError" ? "请允许使用麦克风" : "无法开始录音，请检查麦克风" }));
    return session;
  }
  close() { this.closed = true; this.active?.cancel(); }
}
