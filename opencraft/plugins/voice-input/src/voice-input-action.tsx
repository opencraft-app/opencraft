import { AudioLines, Mic } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ComposerActionHost } from "@opencraft/extension-react";
import type { ComposerTransientTextInput } from "@opencraft/composer-core";

import type {
  SpeechInputError,
  SpeechInputProvider,
  SpeechInputSession,
} from "./speech-input-provider";

type VoiceInputPhase = "idle" | "listening" | "error";

export function createVoiceInputAction(provider: SpeechInputProvider) {
  return function VoiceInputAction({
    mutations,
    disabled,
  }: ComposerActionHost) {
    const sessionRef = useRef<SpeechInputSession | null>(null);
    const textInputRef = useRef<ComposerTransientTextInput | null>(null);
    const committedTextRef = useRef("");
    const visibleTextRef = useRef("");
    const generationRef = useRef(0);
    const recognitionEpochRef = useRef(0);
    const activeRef = useRef(false);
    const [phase, setPhase] = useState<VoiceInputPhase>("idle");
    const [interim, setInterim] = useState("");
    const [error, setError] = useState<SpeechInputError | null>(null);
    const available = useMemo(() => provider.isAvailable(), [provider]);

    const cancel = () => {
      activeRef.current = false;
      generationRef.current += 1;
      recognitionEpochRef.current += 1;
      sessionRef.current?.cancel();
      sessionRef.current = null;
      textInputRef.current?.cancel();
      textInputRef.current = null;
      committedTextRef.current = "";
      visibleTextRef.current = "";
      setInterim("");
      setPhase("idle");
    };

    useEffect(() => cancel, [mutations]);
    useEffect(() => {
      if (disabled) cancel();
    }, [disabled]);

    const start = () => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      activeRef.current = true;
      setError(null);
      setInterim("");
      committedTextRef.current = "";
      visibleTextRef.current = "";
      const paint = (nextInterim: string) => {
        const text = `${committedTextRef.current}${nextInterim}`;
        visibleTextRef.current = text;
        textInputRef.current?.update(text);
      };
      const clearSegment = () => {
        committedTextRef.current = "";
        visibleTextRef.current = "";
        setInterim("");
      };
      const ownsRecognitionEpoch = (epoch: number) =>
        activeRef.current &&
        generationRef.current === generation &&
        recognitionEpochRef.current === epoch;

      let startRecognitionEpoch: () => boolean;
      const openSegment = (): boolean => {
        const textInput = mutations.beginTransientTextInput({
          finalized(result) {
            if (generationRef.current !== generation) return;
            textInputRef.current = null;
            if (result.cause === "submission") {
              // Web Speech results are cumulative within one native session.
              // Rotate that physical epoch at the message boundary so its last
              // interim hypothesis can never leak into the next Composer draft.
              recognitionEpochRef.current += 1;
              sessionRef.current?.cancel();
              sessionRef.current = null;
              clearSegment();
              return;
            }
            activeRef.current = false;
            generationRef.current += 1;
            recognitionEpochRef.current += 1;
            sessionRef.current?.cancel();
            sessionRef.current = null;
            clearSegment();
            setPhase("idle");
          },
          readyForNextInput() {
            if (
              !activeRef.current ||
              generationRef.current !== generation ||
              sessionRef.current !== null
            ) {
              return;
            }
            if (openSegment()) startRecognitionEpoch();
          },
        });
        if (textInput === null) return false;
        textInputRef.current = textInput;
        if (visibleTextRef.current.length > 0) {
          textInput.update(visibleTextRef.current);
        }
        return true;
      };

      startRecognitionEpoch = () => {
        const epoch = recognitionEpochRef.current + 1;
        recognitionEpochRef.current = epoch;
        try {
          const session = provider.start({
          interim(text) {
            if (!ownsRecognitionEpoch(epoch)) return;
            setInterim(text);
            paint(text);
          },
          commit(text) {
            if (!ownsRecognitionEpoch(epoch)) return;
            committedTextRef.current += text;
            paint("");
          },
          end() {
            if (!ownsRecognitionEpoch(epoch)) return;
            activeRef.current = false;
            sessionRef.current = null;
            textInputRef.current?.commit(visibleTextRef.current);
            textInputRef.current = null;
            clearSegment();
            setPhase("idle");
          },
          error(nextError) {
            if (!ownsRecognitionEpoch(epoch)) return;
            activeRef.current = false;
            sessionRef.current = null;
            if (visibleTextRef.current.length > 0) {
              textInputRef.current?.commit(visibleTextRef.current);
            } else {
              textInputRef.current?.cancel();
            }
            textInputRef.current = null;
            clearSegment();
            setError(nextError);
            setPhase("error");
          },
          });
          if (!ownsRecognitionEpoch(epoch)) {
            session.cancel();
            return false;
          }
          sessionRef.current = session;
          setPhase("listening");
          return true;
        } catch (cause) {
          activeRef.current = false;
          textInputRef.current?.cancel();
          textInputRef.current = null;
          setError({
            code: "not-supported",
            message: cause instanceof Error ? cause.message : String(cause),
          });
          setPhase("error");
          return false;
        }
      };

      if (!openSegment()) {
        activeRef.current = false;
        return;
      }
      startRecognitionEpoch();
    };

    const listening = phase === "listening";
    const label = !available
      ? "Voice input is unavailable in this browser"
      : listening
        ? interim.length > 0
          ? `Listening: ${interim}`
          : "Stop voice input"
        : error?.message ?? "Start voice input";

    return (
      <button
        className="codex-composer-icon-button opencraft-voice-input-action"
        type="button"
        aria-label={label}
        aria-pressed={listening}
        data-voice-input-state={phase}
        disabled={disabled || !available}
        title={label}
        onClick={() => {
          if (listening) {
            if (sessionRef.current === null) cancel();
            else sessionRef.current.stop();
            return;
          }
          start();
        }}
      >
        {listening ? <AudioLines size={16} /> : <Mic size={15} />}
      </button>
    );
  };
}
