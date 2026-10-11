import { MOBILE_BOT_EVENT, parseBotCommand, type NativeAudioRequest } from "@opencraft/mobile-bot-bridge";
import { normalizePcmWav, type AudioCapturePort, type AudioCaptureSession, type RecordedAudio } from "@opencraft/plugin-voice-input/cloud-speech";

type NativeAudioWindow = Window & { __OPENCRAFT_NATIVE_AUDIO__?: boolean; __LIGHTVELA_BOT_RUNTIME_ID__?: string; __LIGHTVELA_BOT_POST__?: (message: NativeAudioRequest) => void };
/** Only the native bootstrap advertises this port. It never falls back to Web microphone capture. */
export function embeddedNativeAudioAvailable() { return (window as NativeAudioWindow).__OPENCRAFT_NATIVE_AUDIO__ === true; }
export class EmbeddedNativeAudioCapture implements AudioCapturePort {
  private busy = false;
  isAvailable() { const scope = window as NativeAudioWindow; return embeddedNativeAudioAvailable() && typeof scope.__LIGHTVELA_BOT_POST__ === "function"; }
  async start(level: (value: number) => void, signal: AbortSignal, onError?: () => void): Promise<AudioCaptureSession> {
    if (!this.isAvailable() || this.busy) throw new Error("无法开始录音");
    signal.throwIfAborted(); this.busy = true;
    const scope = window as NativeAudioWindow, runtime = scope.__LIGHTVELA_BOT_RUNTIME_ID__ ?? "", id = crypto.randomUUID();
    const post = (action: NativeAudioRequest["action"]) => scope.__LIGHTVELA_BOT_POST__?.({ type: "native-audio-request", id, action });
    let done = false, stopping = false, listening = false, bytes = 0;
    const chunks: Uint8Array[] = [];
    let resolveReady!: () => void, rejectReady!: (reason: Error) => void;
    let resolveAudio!: (audio: RecordedAudio) => void, rejectAudio!: (reason: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const audio = new Promise<RecordedAudio>((resolve, reject) => { resolveAudio = resolve; rejectAudio = reject; });
    void audio.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout>;
    const dispose = () => { done = true; clearTimeout(timer); window.removeEventListener(MOBILE_BOT_EVENT, receive); signal.removeEventListener("abort", cancel); chunks.length = 0; this.busy = false; };
    const fail = (reason: Error, notify = false) => { if (done) return; post("cancel"); rejectReady(reason); rejectAudio(reason); dispose(); if (notify) onError?.(); };
    const cancel = () => fail(new Error("录音已取消"));
    const receive = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "string" || done) return;
      const value = parseBotCommand(event.detail, runtime);
      if (value?.type !== "native-audio-event" || value.id !== id) return;
      if (value.event === "error") { fail(value.reason === "permission" ? new DOMException("请允许使用麦克风", "NotAllowedError") : new Error("录音中断"), listening); return; }
      if (value.event === "ready") { listening = true; clearTimeout(timer); timer = setTimeout(() => fail(new Error("录音过长"), true), 120000); resolveReady(); }
      if (value.event === "level" && !stopping) level(value.level);
      if (value.event === "chunk") {
        if (!stopping || value.index !== chunks.length) { fail(new Error("录音无效"), true); return; }
        const decoded = Uint8Array.from(atob(value.base64), character => character.charCodeAt(0)); bytes += decoded.length;
        if (bytes > 8 * 1024 * 1024) { fail(new Error("录音过长"), true); return; }
        chunks.push(decoded);
      }
      if (value.event === "complete") {
        try {
          if (!stopping || value.chunks !== chunks.length) throw new Error("录音不完整");
          const data = new Uint8Array(bytes); let offset = 0;
          for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
          const normalized = normalizePcmWav(data);
          dispose(); resolveAudio(normalized);
        } catch { fail(new Error("录音无效"), true); }
      }
    };
    window.addEventListener(MOBILE_BOT_EVENT, receive); signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => fail(new Error("无法开始录音"), listening), 45000);
    post("start");
    await ready;
    return { cancel, stop: () => { if (!stopping && !done) { stopping = true; clearTimeout(timer); timer = setTimeout(() => fail(new Error("无法完成录音"), true), 15000); post("stop"); } return audio; } };
  }
}
