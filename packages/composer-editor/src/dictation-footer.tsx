import { useIntl } from "@opencraft/i18n/react";
import { CloseIcon as X } from "@opencraft/design-system-web/action-icons";
import { LoadingRingIcon, ResetIcon } from "@opencraft/design-system-web/action-icons";
import { ArrowUpIcon as ArrowUp, SquareIcon as Square } from "@opencraft/design-system-web/action-icons";
import { useEffect, useRef, useState } from "react";
import { ProgressIndicator } from "@opencraft/design-system-web/progress";
import { IconButton } from "@opencraft/design-system-web/button";
import type { ComposerAudioLevels, ComposerDictationInteraction } from "@opencraft/composer-core";

const sampleCapacity = 512;

/** A bounded presentation buffer. Capture and recognition belong to the provider. */
function AudioSignal({ levels }: { levels: ComposerAudioLevels }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext("2d");
    if (context === null) return;

    const samples: number[] = new Array(sampleCapacity).fill(0);
    let cursor = 0;
    let frame: number | null = null;
    let disposed = false;
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");

    const paint = () => {
      frame = null;
      if (disposed) return;
      const bounds = canvas.getBoundingClientRect();
      const pixelRatio = window.devicePixelRatio || 1;
      // Setting the bitmap dimensions also clears the preceding sample drawing.
      canvas.width = Math.max(1, Math.round(bounds.width * pixelRatio));
      canvas.height = Math.max(1, Math.round(bounds.height * pixelRatio));
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.strokeStyle = getComputedStyle(canvas).color;
      context.lineWidth = 2;
      context.lineCap = "round";
      const count = Math.floor(bounds.width / 5);
      for (let age = 0; age < count; age += 1) {
        const x = bounds.width - 2 - age * 5;
        const sample = !motionPreference.matches && age < sampleCapacity
          ? samples[(cursor - age - 1 + sampleCapacity) % sampleCapacity]!
          : 0;
        const barHeight = Math.max(2, sample * (bounds.height - 4));
        context.globalAlpha = Math.max(0.18, Math.min(1, x / (bounds.width * 0.15)));
        context.beginPath();
        context.moveTo(x, (bounds.height - barHeight) / 2);
        context.lineTo(x, (bounds.height + barHeight) / 2);
        context.stroke();
      }
      context.globalAlpha = 1;
    };
    const schedule = () => {
      if (!disposed && frame === null) frame = requestAnimationFrame(paint);
    };
    const releaseSamples = levels.subscribe((sample) => {
      if (disposed || !Number.isFinite(sample) || sample < 0 || sample > 1) return;
      samples[cursor] = sample;
      cursor = (cursor + 1) % sampleCapacity;
      if (!motionPreference.matches) schedule();
    });
    motionPreference.addEventListener("change", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    schedule();
    return () => {
      disposed = true;
      releaseSamples();
      motionPreference.removeEventListener("change", schedule);
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [levels]);

  return <canvas ref={canvasRef} className="opencraft-composer-voice-waveform" aria-hidden="true" />;
}

function elapsedSeconds(startedAt: number | null): number {
  return startedAt === null ? 0 : Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

function useRecordingDuration(interaction: ComposerDictationInteraction) {
  const { phase, startedAt } = interaction;
  const [seconds, setSeconds] = useState(() => elapsedSeconds(startedAt));
  useEffect(() => {
    if (phase !== "listening") return;
    const update = () => setSeconds(elapsedSeconds(startedAt));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [phase, startedAt]);
  return { minutes: Math.floor(seconds / 60), seconds: String(seconds % 60).padStart(2, "0") };
}

export function DictationFooter({ interaction, canSend, onSend, onCancel }: {
  interaction: ComposerDictationInteraction;
  canSend: boolean;
  onSend(): void;
  onCancel(): void;
}) {
  const intl = useIntl();
  const duration = useRecordingDuration(interaction);
  const phase = interaction.phase;
  const status = {
    starting: intl.formatMessage({ id: "chat.dictation.starting", defaultMessage: "Preparing to record" }),
    listening: intl.formatMessage({ id: "chat.dictation.listening", defaultMessage: "Listening" }),
    transcribing: intl.formatMessage({ id: "chat.dictation.transcribing", defaultMessage: "Transcribing audio" }),
    failed: intl.formatMessage({ id: "chat.dictation.failed", defaultMessage: "Transcription failed" }),
  }[phase];

  const finishControl = phase === "failed"
    ? <IconButton size="accessory" className="opencraft-composer-icon-button" aria-label={intl.formatMessage({ id: "chat.dictation.retry", defaultMessage: "Retry transcription" })}
        title={interaction.message} onClick={() => interaction.retry()}>
        <ResetIcon size={14} aria-hidden="true" />
      </IconButton>
    : <IconButton size="accessory" className="opencraft-composer-icon-button" aria-label={intl.formatMessage({ id: "chat.dictation.finish", defaultMessage: "Stop and insert text" })}
        title={intl.formatMessage({ id: "chat.dictation.finish", defaultMessage: "Stop and insert text" })} disabled={phase !== "listening"} onClick={() => { void interaction.finish(); }}>
        <Square size={14} fill="currentColor" aria-hidden="true" />
      </IconButton>;

  return <div className="opencraft-composer-voice-footer" data-voice-phase={phase} aria-label={intl.formatMessage({ id: "chat.dictation.controls", defaultMessage: "Voice input controls" })}>
    <IconButton size="accessory" className="opencraft-composer-icon-button" aria-label={intl.formatMessage({ id: "chat.dictation.cancel", defaultMessage: "Cancel voice input" })}
      title={intl.formatMessage({ id: "chat.dictation.cancelShortcut", defaultMessage: "Cancel voice input · Esc" })} onClick={onCancel}><X size={16} aria-hidden="true" /></IconButton>
    <div className="opencraft-composer-voice-footer__signal">
      {phase === "listening" ? <AudioSignal levels={interaction.audioLevels} />
        : <span className="opencraft-composer-voice-footer__status" title={phase === "failed" ? interaction.message : undefined}>
          {phase === "starting" ? <ProgressIndicator /> : phase === "transcribing" ? <LoadingRingIcon size={14} aria-hidden="true" /> : null}
          {phase !== "starting" && <span className="opencraft-composer-voice-footer__status-label" aria-hidden="true">{status}</span>}
        </span>}
      <span className="sr-only" role="status">{status}</span>
    </div>
    <span className="opencraft-composer-voice-footer__duration" aria-label={intl.formatMessage({ id: "chat.dictation.duration", defaultMessage: "Recording duration" })}>{duration.minutes}:{duration.seconds}</span>
    {finishControl}
    <button type="button" className="opencraft-composer-submit" aria-label={intl.formatMessage({ id: "chat.dictation.send", defaultMessage: "Send after transcription" })}
      title={intl.formatMessage({ id: "chat.dictation.send", defaultMessage: "Send after transcription" })} disabled={!canSend || phase !== "listening"} onClick={onSend}>
      <ArrowUp size={17} aria-hidden="true" />
    </button>
  </div>;
}
