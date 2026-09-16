import type { NativeSpeechPort, NativeSpeechEvent } from "@opencraft/app-host-protocol";
import type { SpeechInputObserver, SpeechInputProvider, SpeechInputSession, SpeechInputErrorCode } from "./speech-input-provider";
import { DictationTranscriptLedger } from "./dictation-transcript-ledger";

export class NativeSpeechInputProvider implements SpeechInputProvider {
  readonly id = "vela.macos-speech";
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly port: NativeSpeechPort, private readonly options: { createId?(): string } = {}) {}
  isAvailable(): boolean { return true; }
  private enqueue(work: () => Promise<unknown>) {
    const task = this.tail.catch(() => {}).then(work); this.tail = task.then(() => {}, () => {}); return task;
  }
  settled(): Promise<void> { return this.tail; }
  start(observer: SpeechInputObserver, options: { language?: string } = {}): SpeechInputSession {
    const id = this.options.createId?.() ?? crypto.randomUUID(); let closed = false, stopping = false;
    const ledger = new DictationTranscriptLedger();
    const unsubscribe = this.port.onEvent((event: NativeSpeechEvent) => {
      if (closed || event.sessionId !== id) return;
      if (event.type === "utterance") {
        try { ledger.accept(event); }
        catch (error) { close(); observer.error({ code: "unknown", message: error instanceof Error ? error.message : "听写片段错误" }); }
      }
      else if (event.type === "level") observer.level?.(event.level);
      else if (event.type === "status") observer.status?.(event.phase);
      else {
        if (event.type === "end") {
          try {
            if (!stopping) throw new Error("听写会话在用户停止前意外结束");
            const text = ledger.finish(); close();
            if (text.length > 0) observer.commit(text);
            observer.end();
          } catch (error) { close(); observer.error({ code: "unknown", message: error instanceof Error ? error.message : "听写未能完整收尾" }); }
        }
        else { close(); observer.error({ code: event.code as SpeechInputErrorCode, message: event.message }); }
      }
    });
    const close = () => {
      if (closed) return; closed = true; unsubscribe();
      void this.enqueue(() => this.port.cancel(id)).catch(() => {});
    };
    const language = options.language ?? (typeof navigator === "undefined" ? undefined : navigator.language);
    void this.enqueue(() => closed ? Promise.resolve() : this.port.start(id, { language })).catch(() => {
      if (closed) return; close(); observer.error({ code: "unknown", message: "无法启动系统语音输入，请重试" });
    });
    return { phase: "starting", stop: () => { if (closed || stopping) return; stopping = true; observer.status?.("transcribing");
      void this.enqueue(() => this.port.stop(id)).catch(() => {
      if (!closed) { close(); observer.error({ code: "unknown", message: "无法完成系统语音输入" }); }
    }); }, cancel: close };
  }
}
