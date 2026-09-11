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
  interim(text: string): void;
  commit(text: string): void;
  end(): void;
  error(error: SpeechInputError): void;
}

export interface SpeechInputSession {
  stop(): void;
  cancel(): void;
}

export interface SpeechInputProvider {
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
    recognition.interimResults = true;
    recognition.lang = options.language ?? globalThis.navigator?.language ?? "en-US";
    let closed = false;
    let cancelled = false;

    recognition.onresult = (event) => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript ?? "";
        if (text.trim().length === 0) continue;
        if (result?.isFinal) observer.commit(text);
        else interim += text;
      }
      observer.interim(interim);
    };
    recognition.onerror = (event) => {
      if (!cancelled) {
        closed = true;
        observer.error(normalizeError(event));
      }
    };
    recognition.onend = () => {
      if (closed) return;
      closed = true;
      observer.end();
    };
    recognition.start();

    const close = (mode: "stop" | "cancel") => {
      if (closed) return;
      if (mode === "cancel") cancelled = true;
      if (mode === "cancel") recognition.abort();
      else recognition.stop();
    };
    return {
      stop: () => close("stop"),
      cancel: () => close("cancel"),
    };
  }
}
