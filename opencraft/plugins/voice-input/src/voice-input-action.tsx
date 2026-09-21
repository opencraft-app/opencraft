import { Mic } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ComposerActionHost } from "@opencraft/extension-react";
import type { ComposerTransientTextInput, ComposerAudioLevels } from "@opencraft/composer-core";
import { DictationCompletion } from "./dictation-completion";
import { DictationPressGesture } from "./dictation-press-gesture";

import type {
  SpeechInputError,
  SpeechInputProvider,
  SpeechInputSession,
} from "./speech-input-provider";

type VoiceInputPhase = "idle" | "starting" | "listening" | "transcribing" | "error";

export function createVoiceInputAction(provider: SpeechInputProvider) {
  return function VoiceInputAction({
    mutations,
    disabled,
  }: ComposerActionHost) {
    const sessionRef = useRef<SpeechInputSession | null>(null);
    const textInputRef = useRef<ComposerTransientTextInput | null>(null);
    const finalTextRef = useRef("");
    const generationRef = useRef(0);
    const recognitionEpochRef = useRef(0);
    const activeRef = useRef(false);
    const completionRef = useRef<DictationCompletion | null>(null);
    const startedAtRef = useRef<number | null>(null);
    const holdFinishRef = useRef(false);
    const finishRecognitionRef = useRef<(() => Promise<boolean>) | null>(null);
    const pressGesture = useMemo(() => new DictationPressGesture(), []);
    useEffect(() => {
      // The trigger stays mounted but becomes inert when the voice Footer claims
      // its region. Pointer release belongs to the gesture, not that DOM button.
      const release = (event: PointerEvent) => pressGesture.release(event.pointerId);
      const blur = () => pressGesture.release();
      window.addEventListener("pointerup", release, true);
      window.addEventListener("pointercancel", release, true);
      window.addEventListener("blur", blur);
      return () => {
        pressGesture.reset(); window.removeEventListener("pointerup", release, true);
        window.removeEventListener("pointercancel", release, true); window.removeEventListener("blur", blur);
      };
    }, [pressGesture]);
    const audioLevels = useMemo(() => {
      const listeners = new Set<(level: number) => void>();
      return { subscribe: (listener: (level: number) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        publish: (level: number) => { for (const listener of listeners) listener(level); } } satisfies ComposerAudioLevels & { publish(level: number): void };
    }, []);
    const [phase, setPhase] = useState<VoiceInputPhase>("idle");
    const [error, setError] = useState<SpeechInputError | null>(null);
    const available = useMemo(() => provider.isAvailable(), [provider]);

    const cancel = () => {
      pressGesture.reset(); holdFinishRef.current = false;
      finishRecognitionRef.current = null;
      completionRef.current?.settle(false); completionRef.current = null;
      activeRef.current = false;
      generationRef.current += 1;
      recognitionEpochRef.current += 1;
      sessionRef.current?.cancel();
      sessionRef.current = null;
      textInputRef.current?.cancel();
      textInputRef.current = null;
      finalTextRef.current = "";
      startedAtRef.current = null;
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
      finalTextRef.current = "";
      startedAtRef.current = null;
      const clearSegment = () => {
        finalTextRef.current = "";
      };
      const ownsRecognitionEpoch = (epoch: number) =>
        activeRef.current &&
        generationRef.current === generation &&
        recognitionEpochRef.current === epoch;

      let startRecognitionEpoch: () => boolean;
      const openSegment = (): boolean => {
        const textInput = mutations.beginTransientTextInput({
          finalized() {
            if (generationRef.current !== generation) return;
            pressGesture.reset(); holdFinishRef.current = false; finishRecognitionRef.current = null;
            completionRef.current?.settle(false); completionRef.current = null;
            textInputRef.current = null;
            activeRef.current = false;
            generationRef.current += 1;
            recognitionEpochRef.current += 1;
            sessionRef.current?.cancel();
            sessionRef.current = null;
            clearSegment();
            setPhase("idle");
          },
        });
        if (textInput === null) return false;
        textInputRef.current = textInput;
        return true;
      };

      startRecognitionEpoch = () => {
        const epoch = recognitionEpochRef.current + 1;
        recognitionEpochRef.current = epoch;
        const completion = new DictationCompletion(); completionRef.current = completion;
        const finish = () => ownsRecognitionEpoch(epoch) ? completion.finish(() => { present("transcribing"); sessionRef.current?.stop(); }) : Promise.resolve(false);
        finishRecognitionRef.current = finish;
        const present = (nextPhase: "starting" | "listening" | "transcribing") => {
          if (!ownsRecognitionEpoch(epoch)) return;
          if (nextPhase === "listening" && startedAtRef.current === null) startedAtRef.current = Date.now();
          setPhase(nextPhase);
          textInputRef.current?.setInteraction?.({ kind: "dictation", phase: nextPhase, startedAt: startedAtRef.current, audioLevels,
            cancel: () => { if (ownsRecognitionEpoch(epoch)) cancel(); },
            finish,
          });
          if (nextPhase === "listening" && holdFinishRef.current) {
            queueMicrotask(() => {
              if (!ownsRecognitionEpoch(epoch) || !holdFinishRef.current) return;
              holdFinishRef.current = false;
              void finish();
            });
          }
        };
        try {
          const session = provider.start({
          status: present,
          level(level) { if (ownsRecognitionEpoch(epoch)) audioLevels.publish(level); },
          commit(text) {
            if (!ownsRecognitionEpoch(epoch)) return;
            finalTextRef.current += text;
          },
          end() {
            if (!ownsRecognitionEpoch(epoch)) return;
            const hasRecognizedText = finalTextRef.current.trim().length > 0;
            completionRef.current = null;
            activeRef.current = false;
            sessionRef.current = null;
            const applied = textInputRef.current?.commit(finalTextRef.current) === true;
            textInputRef.current = null;
            clearSegment();
            if (hasRecognizedText && !applied) {
              setError({ code: "unknown", message: "输入目标已变化，听写文字未插入；未发送消息" }); setPhase("error");
            } else setPhase("idle");
            completion.settle(hasRecognizedText && applied);
          },
          error(nextError) {
            if (!ownsRecognitionEpoch(epoch)) return;
            completion.settle(false); completionRef.current = null;
            activeRef.current = false;
            sessionRef.current = null;
            textInputRef.current?.cancel();
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
          present(session.phase ?? "listening");
          return true;
        } catch (cause) {
          completion.settle(false); completionRef.current = null;
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
    const active = listening || phase === "starting" || phase === "transcribing";
    const label = !available
      ? provider.unavailableMessage ?? "Voice input is unavailable in this browser"
      : phase === "starting" ? "正在等待系统语音权限，点击取消"
      : phase === "transcribing" ? "正在完成语音识别，点击取消"
      : listening
        ? "Stop voice input"
        : error?.message ?? "Start voice input";

    return (
      <>
      <button
        className="codex-composer-icon-button opencraft-voice-input-action"
        type="button"
        aria-label={label}
        aria-pressed={active}
        data-voice-input-state={phase}
        disabled={disabled || !available}
        title={label}
        onPointerDown={event => {
          if (event.button !== 0 || activeRef.current) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          pressGesture.press(start, () => {
            holdFinishRef.current = true;
            if (sessionRef.current !== null && completionRef.current !== null) {
              // Native permissions can still be pending. Status will finish that epoch after it starts.
              if (startedAtRef.current !== null) {
                holdFinishRef.current = false;
                void finishRecognitionRef.current?.();
              }
            }
          }, event.pointerId);
        }}
        onPointerUp={event => pressGesture.release(event.pointerId)}
        onPointerCancel={event => pressGesture.release(event.pointerId)}
        onClick={() => {
          if (pressGesture.consumeClick()) return;
          if (phase === "starting" || phase === "transcribing") { cancel(); return; }
          if (listening) {
            if (sessionRef.current === null) cancel();
            else sessionRef.current.stop();
            return;
          }
          start();
        }}
      >
        <Mic size={15} aria-hidden="true" />
      </button>
      {error && phase === "error" ? <span role="alert" title={error.message}>{error.code === "permission-denied" ? "需要系统权限" : error.code === "audio-capture" ? "麦克风不可用" : "语音识别失败"}<span className="sr-only">：{error.message}</span></span> : null}
      </>
    );
  };
}
