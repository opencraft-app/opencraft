// Semantically adopted from Codex RecordingWaveformControls / BB VoiceRecordingBar.
import { ArrowUp, LoaderCircle, RotateCcw, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ProgressIndicator } from "@opencraft/design-system-web/progress";
import type { ComposerAudioLevels, ComposerDictationInteraction } from "@opencraft/composer-core";

function DictationWaveform({ levels, active }: { levels: ComposerAudioLevels; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current, context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const samples: number[] = [];
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, visible = true;
    const draw = () => {
      frame = 0;
      const { width, height } = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(width * dpr)); canvas.height = Math.max(1, Math.round(height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.strokeStyle = getComputedStyle(canvas).color; context.lineWidth = 2; context.lineCap = "round";
      const count = Math.floor(width / 5);
      // No fabricated waveform while waiting, silent, or using a provider without meters.
      for (let index = 0; index < count; index++) {
        const x = width - index * 5 - 2, sample = reducedMotion.matches ? 0 : samples[samples.length - 1 - index] ?? 0;
        const half = Math.max(1, sample * (height / 2 - 2));
        context.globalAlpha = Math.min(1, Math.max(0.18, x / Math.max(1, width * 0.15)));
        context.beginPath(); context.moveTo(x, height / 2 - half); context.lineTo(x, height / 2 + half); context.stroke();
      }
      context.globalAlpha = 1;
    };
    const schedule = () => {
      if (frame || !visible || document.visibilityState === "hidden") return;
      frame = requestAnimationFrame(draw);
    };
    const resize = new ResizeObserver(schedule); resize.observe(canvas);
    const intersection = new IntersectionObserver(entries => {
      visible = entries[0]?.isIntersecting ?? true;
      if (!visible && frame) { cancelAnimationFrame(frame); frame = 0; }
      if (visible) schedule();
    }); intersection.observe(canvas);
    const unsubscribe = active ? levels.subscribe(level => {
      if (!Number.isFinite(level) || level < 0 || level > 1) return;
      samples.push(level); if (samples.length > 512) samples.shift();
      if (!reducedMotion.matches) schedule();
    }) : () => {};
    document.addEventListener("visibilitychange", schedule);
    reducedMotion.addEventListener("change", schedule); schedule();
    return () => {
      unsubscribe(); resize.disconnect(); intersection.disconnect(); if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", schedule); reducedMotion.removeEventListener("change", schedule);
    };
  }, [levels, active]);
  return <canvas ref={canvasRef} className="codex-composer-voice-waveform" aria-hidden="true" />;
}

export function DictationFooter({ interaction, canSend, onSend, onCancel }: {
  interaction: ComposerDictationInteraction; canSend: boolean; onSend(): void; onCancel(): void;
}) {
  const [now, setNow] = useState(Date.now);
  const listening = interaction.phase === "listening";
  useEffect(() => {
    if (!listening) return;
    setNow(Date.now()); const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [listening]);
  const seconds = interaction.startedAt === null ? 0 : Math.max(0, Math.floor((now - interaction.startedAt) / 1000));
  const failed = interaction.phase === "failed";
  const starting = interaction.phase === "starting";
  // Startup includes device acquisition and provider readiness, not necessarily
  // a permission prompt. Keep the announcement accessible and the slot quiet.
  const status = listening ? "正在听写" : failed ? "转写失败" : starting ? "正在准备录音" : "正在完成语音识别";
  return <div className="codex-composer-voice-footer" data-voice-phase={interaction.phase} aria-label="语音输入控制">
    <button type="button" className="codex-composer-icon-button" aria-label="取消语音输入" title="取消语音输入 · Esc" onClick={onCancel}><X size={16} aria-hidden="true" /></button>
    <div className="codex-composer-voice-footer__signal">
      {listening ? <DictationWaveform levels={interaction.audioLevels} active /> : <span className="codex-composer-voice-footer__status" title={failed ? interaction.message : undefined}>
        {starting ? <ProgressIndicator /> : !failed && <LoaderCircle size={14} aria-hidden="true" />}
        {!starting && <span className="codex-composer-voice-footer__status-label" aria-hidden="true">{status}</span>}
      </span>}
      <span className="sr-only" role="status">{status}</span>
    </div>
    <span className="codex-composer-voice-footer__duration" aria-label="录音时长">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>
    {failed ? <button type="button" className="codex-composer-icon-button" aria-label="重试语音识别" title={interaction.message} onClick={() => interaction.retry()}><RotateCcw size={14} aria-hidden="true" /></button>
      : <button type="button" className="codex-composer-icon-button" aria-label="停止并写入文字" title="停止并写入文字" disabled={!listening} onClick={() => { void interaction.finish(); }}><Square size={14} fill="currentColor" aria-hidden="true" /></button>}
    <button type="button" className="codex-composer-submit" aria-label="识别完成后发送" title="识别完成后发送" disabled={!listening || !canSend} onClick={onSend}><ArrowUp size={17} aria-hidden="true" /></button>
  </div>;
}
