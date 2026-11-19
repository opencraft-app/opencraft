import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { NativeSpeechEvent, NativeSpeechOptions } from "@opencraft/app-host-protocol";

interface Capture {
  owner: number; id: string; child: ChildProcessWithoutNullStreams; notify(event: NativeSpeechEvent): void;
  canceled: boolean; ended: boolean; stopping: boolean; buffer: string; closed: Promise<void>; finish(): void;
  timer?: ReturnType<typeof setTimeout>;
}

/** One physical microphone owner, including the permission and draining phases. */
export class NativeSpeechManager {
  private active: Capture | null = null;
  private closing = false;
  constructor(private readonly ports: { spawn(): ChildProcessWithoutNullStreams; cancelGraceMs?: number; stopTimeoutMs?: number }) {}
  async start(owner: number, id: string, options: NativeSpeechOptions, notify: Capture["notify"]): Promise<void> {
    if (this.closing) throw new Error("Native speech is closing");
    if (this.active) throw new Error("Microphone is busy in another input session");
    if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new Error("Invalid speech session");
    if (options.language !== undefined && (typeof options.language !== "string" || options.language.length > 128)) throw new Error("Invalid speech language");
    if (options.deviceId != null && (typeof options.deviceId !== "string" || options.deviceId.length > 1024)) throw new Error("Invalid microphone");
    const child = this.ports.spawn(); let resolveClosed!: () => void;
    const capture: Capture = { owner, id, child, notify, canceled: false, ended: false, stopping: false, buffer: "",
      closed: new Promise(resolve => { resolveClosed = resolve; }), finish: () => {
        clearTimeout(capture.timer); if (this.active === capture) this.active = null; resolveClosed();
      } };
    this.active = capture;
    const error = () => {
      if (!capture.canceled && !capture.ended) {
        capture.ended = true;
        notify({ sessionId: id, type: "error", code: "unknown", message: "原生语音组件意外退出，请重试" });
      }
    };
    child.once("error", () => { error(); capture.finish(); });
    child.once("close", () => { error(); capture.finish(); });
    child.stdin.on?.("error", () => { error(); child.kill(); });
    child.stderr.on("data", () => {}); // Never log transcripts or native diagnostic payloads.
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", chunk => {
      if (capture.canceled || capture.ended || this.active !== capture) return;
      capture.buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (capture.buffer.length > 1024 * 1024) { error(); child.kill(); return; }
      let end: number;
      while ((end = capture.buffer.indexOf("\n")) >= 0) {
        const line = capture.buffer.slice(0, end); capture.buffer = capture.buffer.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          let event: NativeSpeechEvent;
          if (frame.type === "level" && typeof frame.level === "number" && Number.isFinite(frame.level) && frame.level >= 0 && frame.level <= 1)
            event = { sessionId: id, type: "level", level: frame.level };
          else if (frame.type === "utterance" && typeof frame.utteranceId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(frame.utteranceId)
            && Number.isSafeInteger(frame.sequence) && frame.sequence > 0 && ["partial", "final"].includes(frame.phase)
            && typeof frame.text === "string" && frame.text.length <= 100000)
            event = { sessionId: id, type: "utterance", utteranceId: frame.utteranceId, sequence: frame.sequence, phase: frame.phase, text: frame.text };
          else if (frame.type === "status" && ["starting", "listening", "transcribing"].includes(frame.phase))
            event = { sessionId: id, type: "status", phase: frame.phase, ...(typeof frame.onDevice === "boolean" ? { onDevice: frame.onDevice } : {}) };
          else if (frame.type === "end") event = { sessionId: id, type: "end" };
          else if (frame.type === "error" && typeof frame.code === "string" && typeof frame.message === "string")
            event = { sessionId: id, type: "error", code: frame.code.slice(0, 80), message: frame.message.slice(0, 500) };
          else throw new Error("Invalid native speech event");
          if (capture.canceled || this.active !== capture) return;
          if (event.type === "end" || event.type === "error") { capture.ended = true; clearTimeout(capture.timer); }
          notify(event);
        } catch { error(); child.kill(); return; }
      }
    });
    child.stdin.write(JSON.stringify({ type: "start", language: options.language, deviceId: options.deviceId }) + "\n");
  }
  async stop(owner: number, id: string): Promise<boolean> {
    const capture = this.active;
    if (!capture || capture.owner !== owner || capture.id !== id || capture.canceled || capture.ended || capture.stopping) return false;
    capture.stopping = true;
    capture.child.stdin.write('{"type":"stop"}\n');
    clearTimeout(capture.timer);
    capture.timer = setTimeout(() => {
      if (capture.canceled || capture.ended) return;
      capture.ended = true;
      capture.notify({ sessionId: id, type: "error", code: "network", message: "系统语音识别未能及时完成，请重试" });
      void this.cancel(owner, id);
    }, this.ports.stopTimeoutMs ?? 12000);
    capture.timer.unref(); return true;
  }
  async cancel(owner: number, id: string): Promise<boolean> {
    const capture = this.active;
    if (!capture || capture.owner !== owner || capture.id !== id) return false;
    capture.canceled = true; clearTimeout(capture.timer);
    try { capture.child.stdin.write('{"type":"cancel"}\n'); } catch { capture.child.kill("SIGTERM"); }
    const timer = setTimeout(() => capture.child.kill("SIGKILL"), this.ports.cancelGraceMs ?? 1500); timer.unref();
    await capture.closed; clearTimeout(timer); return true;
  }
  async releaseOwner(owner: number): Promise<void> { if (this.active?.owner === owner) await this.cancel(owner, this.active.id); }
  async close(): Promise<void> { this.closing = true; if (this.active) await this.cancel(this.active.owner, this.active.id); }
}
