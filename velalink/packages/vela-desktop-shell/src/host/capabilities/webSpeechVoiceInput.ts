import type {
  RuntimeHostUnsubscribe,
  VoiceInputError,
  VoiceInputHost,
  VoiceInputOptions,
  VoiceInputPermissionState,
  VoiceInputState,
} from "./voiceInput";

interface BrowserSpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [index: number]: {
        transcript: string;
      };
    };
  };
}

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  start: () => void;
  stop: () => void;
}

interface BrowserSpeechRecognitionConstructor {
  new (): BrowserSpeechRecognition;
}

interface SpeechRecognitionGlobal {
  SpeechRecognition?: BrowserSpeechRecognitionConstructor;
  webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
}

function getSpeechRecognitionConstructor(): BrowserSpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const speechWindow = window as typeof window & SpeechRecognitionGlobal;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return String(error);
}

function getErrorCode(error: unknown, fallback: string) {
  if (typeof error === "object" && error) {
    const code = (error as { code?: unknown; error?: unknown; name?: unknown }).code;
    if (typeof code === "string" && code) return code;
    const eventError = (error as { error?: unknown }).error;
    if (typeof eventError === "string" && eventError) return eventError;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name) return name;
  }
  return fallback;
}

function subscribe<T>(listeners: Set<(value: T) => void>, listener: (value: T) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function stopTracks(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop());
}

export function createWebSpeechVoiceInputHost(): VoiceInputHost {
  let recognition: BrowserSpeechRecognition | null = null;
  let state: VoiceInputState = "idle";
  const partialListeners = new Set<(text: string) => void>();
  const finalListeners = new Set<(text: string) => void>();
  const stateListeners = new Set<(state: VoiceInputState) => void>();
  const errorListeners = new Set<(error: VoiceInputError) => void>();

  const publishState = (nextState: VoiceInputState) => {
    state = nextState;
    stateListeners.forEach((listener) => listener(nextState));
  };

  const publishError = (error: VoiceInputError) => {
    errorListeners.forEach((listener) => listener(error));
  };

  const clearRecognition = () => {
    recognition = null;
    publishState("idle");
  };

  const requestPermission = async (): Promise<VoiceInputPermissionState> => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return "prompt";
    }
    publishState("requesting-permission");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stopTracks(stream);
      return "granted";
    } catch (error) {
      publishState("idle");
      const code = getErrorCode(error, "permission_error");
      if (code === "NotAllowedError" || code === "PermissionDeniedError") {
        return "denied";
      }
      publishError({
        code,
        message: getErrorMessage(error),
      });
      return "prompt";
    }
  };

  return {
    isAvailable() {
      return getSpeechRecognitionConstructor() !== null;
    },
    requestPermission,
    async start(options?: VoiceInputOptions) {
      const SpeechRecognition = getSpeechRecognitionConstructor();
      if (!SpeechRecognition) {
        publishState("error");
        publishError({
          code: "speech_recognition_unavailable",
          message: "Speech recognition is unavailable in this runtime.",
        });
        return;
      }
      if (recognition) return;

      const permission = await requestPermission();
      if (permission === "denied") {
        publishState("error");
        publishError({
          code: "microphone_permission_denied",
          message: "Microphone permission was denied.",
        });
        return;
      }

      const nextRecognition = new SpeechRecognition();
      nextRecognition.continuous = true;
      nextRecognition.interimResults = options?.interimResults ?? true;
      nextRecognition.lang =
        options?.language ??
        (typeof navigator !== "undefined" ? navigator.language : undefined) ??
        "en-US";
      nextRecognition.onresult = (event) => {
        let partialText = "";
        let finalText = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result?.[0]?.transcript ?? "";
          if (!transcript) continue;
          if (result.isFinal) {
            finalText += transcript;
          } else {
            partialText += transcript;
          }
        }
        const trimmedPartial = partialText.trim();
        const trimmedFinal = finalText.trim();
        if (trimmedPartial) {
          partialListeners.forEach((listener) => listener(trimmedPartial));
        }
        if (trimmedFinal) {
          finalListeners.forEach((listener) => listener(trimmedFinal));
        }
      };
      nextRecognition.onerror = (event) => {
        publishState("error");
        publishError({
          code: getErrorCode(event, "speech_recognition_error"),
          message: getErrorMessage(event),
        });
      };
      nextRecognition.onend = () => {
        if (recognition === nextRecognition) clearRecognition();
      };
      recognition = nextRecognition;

      try {
        nextRecognition.start();
        publishState("listening");
      } catch (error) {
        recognition = null;
        publishState("error");
        publishError({
          code: getErrorCode(error, "speech_recognition_start_failed"),
          message: getErrorMessage(error),
        });
      }
    },
    stop() {
      if (!recognition) return;
      publishState("stopping");
      recognition.stop();
    },
    onPartialTranscript(listener: (text: string) => void): RuntimeHostUnsubscribe {
      return subscribe(partialListeners, listener);
    },
    onFinalTranscript(listener: (text: string) => void): RuntimeHostUnsubscribe {
      return subscribe(finalListeners, listener);
    },
    onStateChange(listener: (nextState: VoiceInputState) => void): RuntimeHostUnsubscribe {
      listener(state);
      return subscribe(stateListeners, listener);
    },
    onError(listener: (error: VoiceInputError) => void): RuntimeHostUnsubscribe {
      return subscribe(errorListeners, listener);
    },
  };
}
