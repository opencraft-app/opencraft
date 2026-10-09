export interface RecordedAudio { readonly blob: Blob; readonly durationMs: number }
export interface AudioCaptureSession { stop(): Promise<RecordedAudio>; cancel(): void }
export interface AudioCapturePort {
  isAvailable(): boolean;
  start(level: (value: number) => void, signal: AbortSignal, onError?: () => void): Promise<AudioCaptureSession>;
}

/** A canonical container lets the backend validate actual duration, not client metadata. */
export function encodeSpeechWav(channels: readonly Float32Array[], sampleRate: number): RecordedAudio {
  const frames = channels[0]?.length ?? 0, durationMs = frames / sampleRate * 1000;
  if (!channels.length || channels.length > 2 || !frames || channels.some(channel => channel.length !== frames)
    || !Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000
    || durationMs < 250 || durationMs > 120_000) throw new Error("录音过短或过长，请重新录制");
  const count = Math.floor(frames * 16_000 / sampleRate), bytes = new ArrayBuffer(44 + count * 2);
  const view = new DataView(bytes);
  const word = (offset: number, text: string) => { for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index)); };
  word(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); word(8, "WAVE"); word(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  word(36, "data"); view.setUint32(40, count * 2, true);
  // Average each source interval: bounded downsampling and channel mixing, not a renamed compressed file.
  for (let index = 0; index < count; index++) {
    const from = Math.floor(index * sampleRate / 16_000), to = Math.max(from + 1, Math.floor((index + 1) * sampleRate / 16_000));
    let sum = 0;
    for (const channel of channels) for (let frame = from; frame < Math.min(to, frames); frame++) sum += channel[frame]!;
    const sample = Math.max(-1, Math.min(1, sum / (channels.length * Math.min(to - from, frames - from))));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return { blob: new Blob([bytes], { type: "audio/wav" }), durationMs: count / 16 };
}

/** One physical capture per application voice extension; no recording on probe. */
export class BrowserAudioCapture implements AudioCapturePort {
  private owner: AbortController | null = null;
  isAvailable(): boolean {
    return globalThis.isSecureContext === true && typeof navigator.mediaDevices?.getUserMedia === "function"
      && typeof MediaRecorder !== "undefined" && typeof AudioContext !== "undefined";
  }
  async start(level: (value: number) => void, signal: AbortSignal, onError?: () => void): Promise<AudioCaptureSession> {
    if (!this.isAvailable()) throw new Error("此页面暂不支持录音，请使用安全连接打开");
    if (this.owner) throw new Error("另一个输入框正在录音");
    signal.throwIfAborted();
    const owner = new AbortController();
    const context = new AudioContext(); this.owner = owner;
    // Resume within the initiating input gesture, before awaiting permissions.
    const resumed = context.resume(); void resumed.catch(() => undefined);
    let stream: MediaStream | null = null, recorder: MediaRecorder | null = null;
    let meter: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    let stopPromise: Promise<RecordedAudio> | null = null, ending = false, disposed = false;
    let resolveStopped!: () => void, rejectStopped!: (error: Error) => void;
    const stopped = new Promise<void>((resolve, reject) => { resolveStopped = resolve; rejectStopped = reject; });
    void stopped.catch(() => undefined);
    const chunks: Blob[] = []; let byteCount = 0;
    const releaseDevices = () => { clearInterval(meter); stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); };
    const dispose = () => {
      if (disposed) return; disposed = true; clearTimeout(deadline); releaseDevices();
      signal.removeEventListener("abort", cancel); document.removeEventListener("visibilitychange", visibility);
      context.onstatechange = null;
      if (recorder) { recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null; if (recorder.state !== "inactive") recorder.stop(); }
      chunks.length = 0; void context.close().catch(() => undefined);
      if (this.owner === owner) this.owner = null;
    };
    const cancel = () => { owner.abort(); rejectStopped(new Error("录音已取消")); dispose(); stopPromise = null; };
    const lost = () => { if (disposed) return; owner.abort(); rejectStopped(new Error("录音中断，请重新录制")); dispose(); onError?.(); };
    const visibility = () => { if (document.visibilityState === "hidden" && !ending) lost(); };
    signal.addEventListener("abort", cancel, { once: true });
    document.addEventListener("visibilitychange", visibility);
    deadline = setTimeout(lost, 15_000);
    try {
      const permission = navigator.mediaDevices.getUserMedia({ audio: true });
      void permission.then(value => { if (owner.signal.aborted) value.getTracks().forEach(track => track.stop()); }, () => undefined);
      stream = await Promise.race([permission, new Promise<never>((_, reject) => owner.signal.addEventListener("abort", () => reject(new Error("录音中断，请重试")), { once: true }))]);
      owner.signal.throwIfAborted(); await resumed; owner.signal.throwIfAborted();
      const source = context.createMediaStreamSource(stream), analyser = context.createAnalyser();
      analyser.fftSize = 256; source.connect(analyser); const samples = new Float32Array(analyser.fftSize);
      meter = setInterval(() => { if (ending || owner.signal.aborted) return; analyser.getFloatTimeDomainData(samples); let sum = 0; for (const sample of samples) sum += sample * sample; level(Math.min(1, Math.sqrt(sum / samples.length) * 4)); }, 50);
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(value => MediaRecorder.isTypeSupported(value));
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = event => { if (owner.signal.aborted || event.data.size === 0) return; byteCount += event.data.size; if (byteCount > 8 * 1024 * 1024) { lost(); return; } chunks.push(event.data); };
      recorder.onerror = lost;
      recorder.onstop = () => { releaseDevices(); ending ? resolveStopped() : lost(); };
      for (const track of stream.getAudioTracks()) track.onended = lost;
      context.onstatechange = () => { if (!ending && context.state === "suspended") lost(); };
      clearTimeout(deadline); deadline = setTimeout(lost, 120_000);
      recorder.start(250);
      return {
        cancel,
        stop: () => {
          if (stopPromise) return stopPromise;
          stopPromise = (async () => {
            owner.signal.throwIfAborted(); ending = true; clearTimeout(deadline);
            // Keep the final dataavailable frame; do not release recorder handlers before onstop.
            deadline = setTimeout(lost, 8_000); recorder!.stop(); await stopped;
            owner.signal.throwIfAborted(); clearTimeout(deadline);
            const audio = await context.decodeAudioData(await new Blob(chunks, { type: recorder!.mimeType }).arrayBuffer());
            owner.signal.throwIfAborted();
            if (audio.numberOfChannels > 2 || audio.duration > 120) throw new Error("录音过长，请重新录制");
            return encodeSpeechWav(Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index)), audio.sampleRate);
          })().finally(dispose);
          return stopPromise;
        },
      };
    } catch (error) { dispose(); throw error; }
  }
}

/** Native WAV may contain extra RIFF chunks. Validate actual PCM and canonicalize before ASR. */
export function normalizePcmWav(bytes: Uint8Array): RecordedAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length < 44 || bytes.length > 8 * 1024 * 1024 || word(0, 4) !== "RIFF" || word(8, 4) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.length) throw new Error("Invalid WAV");
  let rate = 0, channels = 0, data: Uint8Array | null = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + size > bytes.length) throw new Error("Truncated WAV");
    if (word(offset, 4) === "fmt ") {
      if (size < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 14, true) !== 16) throw new Error("Invalid PCM");
      channels = view.getUint16(start + 2, true); rate = view.getUint32(start + 4, true);
      if (channels < 1 || channels > 2 || view.getUint16(start + 12, true) !== channels * 2 || view.getUint32(start + 8, true) !== rate * channels * 2) throw new Error("Invalid PCM geometry");
    }
    if (word(offset, 4) === "data") { if (data) throw new Error("Multiple audio chunks"); data = bytes.subarray(start, start + size); }
    offset = start + size + (size % 2);
  }
  if (!data || !rate || !channels || data.length % (channels * 2) || data.length / (rate * channels * 2) > 120) throw new Error("Invalid audio duration");
  const pcm = new DataView(data.buffer, data.byteOffset, data.byteLength), frames = data.length / (channels * 2);
  return encodeSpeechWav(Array.from({ length: channels }, (_, channel) => Float32Array.from({ length: frames }, (_, frame) => pcm.getInt16((frame * channels + channel) * 2, true) / 32768)), rate);
}
