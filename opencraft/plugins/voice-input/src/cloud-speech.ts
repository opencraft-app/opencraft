import { BrowserAudioCapture, type AudioCapturePort, type AudioCaptureSession, type RecordedAudio } from "./audio-capture";
import type { SpeechInputError, SpeechInputObserver, SpeechInputProvider, SpeechInputSession } from "./speech-input-provider";

export type VoiceProviderChoice = "auto" | "system" | "hunyuan";
export interface VoiceInputPreference { readonly provider: VoiceProviderChoice; setProvider(value: VoiceProviderChoice): Promise<void> }
export interface SpeechServiceSnapshot { readonly phase: "loading" | "ready" | "unavailable" }
export class SpeechServiceClient {
  private snapshot: SpeechServiceSnapshot = { phase: "loading" };
  private listeners = new Set<() => void>();
  private discovery: AbortController | null = null;
  private closed = false;
  constructor(private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  async refresh(): Promise<void> {
    if (this.closed) return;
    this.discovery?.abort(); const controller = new AbortController(); this.discovery = controller;
    const deadline = setTimeout(() => controller.abort(), 5000);
    try {
      const result = await this.fetcher("/__opencraft_speech/capabilities", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      const value: unknown = result.ok ? await result.json() : null;
      if (!this.closed && this.discovery === controller) this.publish(value !== null && typeof value === "object"
        && "available" in value && value.available === true && "provider" in value && value.provider === "hunyuan"
        && "maxDurationMs" in value && value.maxDurationMs === 120_000
        && "maxAudioBytes" in value && value.maxAudioBytes === 3_840_044 ? "ready" : "unavailable");
    } catch { if (!this.closed && this.discovery === controller) this.publish("unavailable"); }
    finally { clearTimeout(deadline); }
  }
  private publish(phase: SpeechServiceSnapshot["phase"]) { this.snapshot = { phase }; for (const listener of this.listeners) listener(); }
  async transcribe(audio: RecordedAudio, sessionId: string, attemptId: string, language: string | undefined, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.closed) throw new TranscriptionFailure("语音服务已关闭", false);
    if (audio.blob.type !== "audio/wav" || audio.blob.size > 3_840_044 || audio.durationMs < 250 || audio.durationMs > 120_000) throw new TranscriptionFailure("录音不符合要求，请重新录制", false);
    const source = language?.split(/[-_]/u)[0]?.toLowerCase();
    const response = await this.fetcher("/__opencraft_speech/transcribe", { method: "POST", credentials: "same-origin", signal,
      headers: { "content-type": "audio/wav", "x-opencraft-speech-session": sessionId, "x-opencraft-speech-attempt": attemptId,
        ...(source === "zh" || source === "en" ? { "x-opencraft-speech-language": source } : {}) }, body: audio.blob });
    const body: unknown = await response.json();
    signal.throwIfAborted();
    if (!response.ok) {
      const error = body && typeof body === "object" && "error" in body ? body.error : null;
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      const retryable = error && typeof error === "object" && "retryable" in error && error.retryable === true;
      const message = code === "busy" ? "语音服务繁忙，请稍后重试" : code === "no-speech" ? "未听到语音，请重新录制"
        : code === "unavailable" || code === "not-allowed" ? "语音服务暂不可用，请检查设置" : code === "invalid-audio" || code === "too-large" ? "录音不符合要求，请重新录制" : "转写失败，可以重试";
      throw new TranscriptionFailure(message, Boolean(retryable));
    }
    if (!body || typeof body !== "object" || !("sessionId" in body) || body.sessionId !== sessionId
      || !("attemptId" in body) || body.attemptId !== attemptId || !("text" in body) || typeof body.text !== "string"
      || !body.text.trim() || body.text.length > 32_000) throw new TranscriptionFailure("转写结果无效，请重新录制", false);
    return body.text.trim();
  }
  close() { this.closed = true; this.discovery?.abort(); this.listeners.clear(); }
}
class TranscriptionFailure extends Error { constructor(message: string, readonly retryable: boolean) { super(message); } }

/** Owns an ephemeral audio session, never a Draft, View or selected execution Server. */
export class CloudSpeechInputProvider implements SpeechInputProvider {
  readonly id = "opencraft.hunyuan-speech";
  readonly unavailableMessage = "混元语音服务尚未就绪，请检查语音设置";
  private active: SpeechInputSession | null = null;
  private closed = false;
  constructor(readonly service: SpeechServiceClient, private readonly capture: AudioCapturePort = new BrowserAudioCapture()) {}
  isAvailable() { return !this.closed && this.service.getSnapshot().phase === "ready" && this.capture.isAvailable(); }
  start(observer: SpeechInputObserver, options: { readonly language?: string } = {}): SpeechInputSession {
    if (!this.isAvailable()) throw new Error(this.unavailableMessage);
    if (this.active) throw new Error("另一个输入框正在听写");
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
        const text = await this.service.transcribe(audio, sessionId, attemptId, options.language, current.signal);
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
