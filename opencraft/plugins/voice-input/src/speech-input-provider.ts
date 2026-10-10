import { DictationTranscriptLedger } from "./dictation-transcript-ledger";

export type SpeechInputErrorCode =
  | "not-supported"
  | "permission-denied"
  | "no-speech"
  | "audio-capture"
  | "network"
  | "unknown";

export interface SpeechInputError {
  readonly code: SpeechInputErrorCode;
  readonly message: string;
}

export interface SpeechInputObserver {
  level?(level: number): void;
  status?(phase: "starting" | "listening" | "transcribing"): void;
  /** One completed session transcript, never a recognition hypothesis. */
  commit(text: string): void;
  end(): void;
  error(error: SpeechInputError): void;
  /** Retains this input transaction for explicit same-audio retry; never authorizes a send. */
  recover?(error: SpeechInputError, retry: () => void): void;
}

export interface SpeechInputSession {
  readonly phase?: "starting" | "listening";
  stop(): void;
  cancel(): void;
}

export interface SpeechInputProvider {
  /** Optional capability updates for asynchronously discovered transports. */
  subscribe?(listener: () => void): () => void;
  readonly unavailableMessage?: string;
  readonly id: string;
  isAvailable(): boolean;
  start(
    observer: SpeechInputObserver,
    options?: { readonly language?: string },
  ): SpeechInputSession;
}

interface BrowserSpeechRecognitionAlternative {
  readonly transcript: string;
}

interface BrowserSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: BrowserSpeechRecognitionAlternative;
}

interface BrowserSpeechRecognitionResultList {
  readonly length: number;
  readonly [index: number]: BrowserSpeechRecognitionResult;
}

interface BrowserSpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: BrowserSpeechRecognitionResultList;
}

interface BrowserSpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message?: string;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

function recognitionConstructor(): BrowserSpeechRecognitionConstructor | null {
  const scope = globalThis as typeof globalThis & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

function normalizeError(event: BrowserSpeechRecognitionErrorEvent): SpeechInputError {
  switch (event.error) {
    case "not-allowed":
    case "service-not-allowed":
      return {
        code: "permission-denied",
        message: "Microphone permission was denied",
      };
    case "no-speech":
      return { code: "no-speech", message: "No speech was detected" };
    case "audio-capture":
      return { code: "audio-capture", message: "No microphone is available" };
    case "network":
      return { code: "network", message: "Speech recognition is offline" };
    default:
      return {
        code: "unknown",
        message: event.message?.trim() || "Voice input failed",
      };
  }
}

/** Chromium/WebKit provider. Permission and audio-device ownership stay in the platform. */
export class BrowserSpeechInputProvider implements SpeechInputProvider {
  readonly id = "vela.browser-speech-recognition";

  isAvailable(): boolean {
    return recognitionConstructor() !== null;
  }

  start(
    observer: SpeechInputObserver,
    options: { readonly language?: string } = {},
  ): SpeechInputSession {
    const Constructor = recognitionConstructor();
    if (Constructor === null) {
      throw new Error("Voice input is not supported by this browser");
    }
    const recognition = new Constructor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = options.language ?? globalThis.navigator?.language ?? "en-US";
    let closed = false;
    let cancelled = false;
    let listening = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let stopping = false, sequence = 0;
    const ledger = new DictationTranscriptLedger();
    const clearDeadline = () => { clearTimeout(deadline); deadline = undefined; };
    const abort = () => { try { recognition.abort(); } catch { /* Release the UI even if the browser session has failed. */ } };
    const fail = (error: SpeechInputError) => {
      if (closed) return;
      closed = true;
      clearDeadline();
      abort();
      observer.error(error);
    };
    const armDeadline = (milliseconds: number, message: string) => {
      clearDeadline();
      deadline = setTimeout(() => fail({ code: "unknown", message }), milliseconds);
    };
    recognition.onstart = () => {
      if (closed || stopping) return;
      listening = true;
      clearDeadline();
      observer.status?.("listening");
    };

    recognition.onresult = (event) => {
      if (closed || cancelled) return;
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript ?? "";
        if (result === undefined) continue;
        try { ledger.accept({ utteranceId: `browser-result-${index}`, sequence: ++sequence,
          phase: result.isFinal ? "final" : "partial", text }); }
        catch (error) {
          fail({ code: "unknown", message: error instanceof Error ? error.message : "听写结果无效" }); return;
        }
      }
    };
    recognition.onerror = (event) => {
      if (!cancelled) fail(normalizeError(event));
    };
    recognition.onend = () => {
      if (closed) return;
      closed = true;
      clearDeadline();
      try {
        if (!stopping) throw new Error("语音服务在用户停止前结束，请重新开始听写");
        const text = ledger.finish(); if (text.length > 0) observer.commit(text);
        observer.end();
      } catch (error) { observer.error({ code: "unknown", message: error instanceof Error ? error.message : "听写未能收尾" }); }
    };
    armDeadline(15_000, "语音识别启动超时，请检查麦克风权限或稍后重试");
    try { recognition.start(); }
    catch (error) { closed = true; clearDeadline(); abort(); throw error; }

    const close = (mode: "stop" | "cancel") => {
      if (closed) return;
      if (mode === "cancel") {
        cancelled = true; closed = true; clearDeadline(); abort();
      } else {
        if (stopping) return;
        stopping = true;
        armDeadline(8_000, "语音识别完成超时，已退出听写，请重试");
        try { recognition.stop(); }
        catch { fail({ code: "unknown", message: "无法结束语音识别，已退出听写，请重试" }); }
      }
    };
    return {
      get phase() { return listening ? "listening" as const : "starting" as const; },
      stop: () => close("stop"),
      cancel: () => close("cancel"),
    };
  }
}
