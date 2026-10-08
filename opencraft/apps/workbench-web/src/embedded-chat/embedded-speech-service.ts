import { TranscriptionFailure, type RecordedAudio, type SpeechServicePort, type SpeechServiceSnapshot } from "@opencraft/plugin-voice-input/cloud-speech";

/** One embedded account/region incarnation, never a reusable global login or Key store. */
export class EmbeddedSpeechService implements SpeechServicePort {
  private readonly token: string | null;
  private readonly binding = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, "0")).join("");
  private snapshot: SpeechServiceSnapshot = { phase: "loading", binding: null, revision: null, selection: null, models: [] };
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Set<AbortController>();
  private closed = false;
  constructor(private readonly apiBase: string, private readonly getToken: () => string | null,
    private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {
    this.token = getToken();
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private assertScope() {
    let current: string | null = null;
    try { current = this.getToken(); } catch { /* The containing frontend may revoke its accessor. */ }
    if (this.closed || !this.token || current !== this.token) throw new TranscriptionFailure("登录状态已改变，请重新录音", false);
  }
  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<{ ok: boolean; status: number; value: unknown }> {
    this.assertScope();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    this.pending.add(controller);
    try {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${this.token}`);
      const response = await this.fetcher(`${this.apiBase.replace(/\/$/u, "")}/api/speech/${path}`, {
        ...init, headers, credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal,
      });
      const value: unknown = response.ok ? await response.json() : null;
      this.assertScope();
      controller.signal.throwIfAborted();
      return { ok: response.ok, status: response.status, value };
    } finally { this.pending.delete(controller); signal?.removeEventListener("abort", cancel); }
  }
  async refresh(): Promise<void> {
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.request("capabilities", {}, controller.signal);
      const value = response.value;
      this.assertScope();
      if (!value || typeof value !== "object" || !("available" in value) || value.available !== true
        || !("model" in value) || value.model !== "ep-hyasr3"
        || !("max_duration_ms" in value) || value.max_duration_ms !== 120000
        || !("max_audio_bytes" in value) || value.max_audio_bytes !== 3840044) throw new Error("Unavailable");
      this.snapshot = { ...this.snapshot, phase: "ready", binding: this.binding };
    } catch { this.snapshot = { ...this.snapshot, phase: "unavailable", binding: null }; }
    finally { clearTimeout(deadline); if (!this.closed) for (const listener of this.listeners) listener(); }
  }
  async transcribe(audio: RecordedAudio, _session: string, _attempt: string, language: string | undefined, signal: AbortSignal, binding?: string): Promise<string> {
    this.assertScope();
    if (binding !== this.binding || audio.blob.type !== "audio/wav" || audio.blob.size > 3840044 || audio.durationMs < 250 || audio.durationMs > 120000) {
      throw new TranscriptionFailure("录音不符合要求，请重新录制", false);
    }
    const body = new FormData();
    body.append("model", "ep-hyasr3");
    body.append("file", audio.blob, "speech.wav");
    const source = language?.split(/[-_]/u)[0]?.toLowerCase();
    if (source === "zh" || source === "en") body.append("language", source);
    const response = await this.request("transcriptions", { method: "POST", body }, signal);
    if (!response.ok) {
      throw new TranscriptionFailure(response.status === 401 ? "请重新登录后录音" : response.status === 429 ? "语音服务繁忙，请稍后重试" : "语音识别失败，请重试", response.status === 429 || response.status >= 500);
    }
    const value = response.value;
    this.assertScope(); signal.throwIfAborted();
    if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string" || value.text.length > 32000) throw new TranscriptionFailure("识别结果无效，请重新录音", false);
    if (!value.text.trim()) throw new TranscriptionFailure("未听到语音，请重新录制", false);
    return value.text.trim();
  }
  close() { this.closed = true; for (const controller of this.pending) controller.abort(); this.pending.clear(); this.listeners.clear(); }
}
