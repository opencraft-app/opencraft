import { useEffect, useId, useRef } from "react";
import { FormattedMessage } from "@opencraft/i18n/react";

const VIEW_WIDTH = 400;
const BASE_Y = 4;
const AMPLITUDE = 2.6;
const CYCLES = 3.5;
const SAMPLES = 64;

function buildWavePaths(phase: number): { fill: string; stroke: string } {
  let stroke = `M0 ${BASE_Y.toFixed(2)}`;
  for (let index = 1; index <= SAMPLES; index++) {
    const u = index / SAMPLES;
    const x = u * VIEW_WIDTH;
    const envelope = Math.pow(Math.sin(Math.PI * u), 1.4);
    const wave = 0.5 - 0.5 * Math.cos(Math.PI * 2 * CYCLES * u - phase);
    const y = BASE_Y + AMPLITUDE * envelope * wave;
    stroke += ` L${x.toFixed(1)} ${y.toFixed(2)}`;
  }
  const fill = `${stroke} L${VIEW_WIDTH} 0 L0 0 Z`;
  return { fill, stroke };
}

const STATIC_WAVE = buildWavePaths(0.9);

/** Paint only: the conversation owner decides when recovery is pending. */
export function ComposerRecoveryScan({ active, waiting }: { readonly active: boolean; readonly waiting: boolean }) {
  const gradientId = useId();
  const fillRef = useRef<SVGPathElement>(null);
  const strokeRef = useRef<SVGPathElement>(null);
  const visible = active || waiting;

  useEffect(() => {
    if (!visible) return;
    const fillNode = fillRef.current;
    const strokeNode = strokeRef.current;
    if (!fillNode || !strokeNode) return;

    const media = typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;

    let frame = 0;
    const start = performance.now();

    const applyStatic = () => {
      fillNode.setAttribute("d", STATIC_WAVE.fill);
      strokeNode.setAttribute("d", STATIC_WAVE.stroke);
    };

    const tick = (now: number) => {
      if (!active || media?.matches) {
        applyStatic();
        frame = 0;
        return;
      }
      const phase = ((now - start) / 1000) * 2.8;
      const next = buildWavePaths(phase);
      fillNode.setAttribute("d", next.fill);
      strokeNode.setAttribute("d", next.stroke);
      frame = window.requestAnimationFrame(tick);
    };

    const syncMotion = () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      if (active && !media?.matches) {
        frame = window.requestAnimationFrame(tick);
      } else {
        applyStatic();
      }
    };

    syncMotion();
    media?.addEventListener?.("change", syncMotion);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      media?.removeEventListener?.("change", syncMotion);
    };
  }, [active, visible]);

  return (
    <div className="opencraft-composer-recovery" data-active={active ? "true" : "false"} data-waiting={waiting || undefined}>
      <span className="opencraft-composer-recovery__beam" aria-hidden="true" />
      <svg
        className="opencraft-composer-recovery__wave"
        viewBox={`0 0 ${VIEW_WIDTH} 9`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" style={{ stopColor: "var(--cw0)" }} />
            <stop offset="18%" style={{ stopColor: "var(--cw1)" }} />
            <stop offset="40%" style={{ stopColor: "var(--cw2)" }} />
            <stop offset="64%" style={{ stopColor: "var(--cw3)" }} />
            <stop offset="84%" style={{ stopColor: "var(--cw4)" }} />
            <stop offset="100%" style={{ stopColor: "var(--cw0)" }} />
          </linearGradient>
        </defs>
        <path ref={fillRef} className="opencraft-composer-recovery__fill" d={STATIC_WAVE.fill} />
        <path
          ref={strokeRef}
          className="opencraft-composer-recovery__stroke"
          d={STATIC_WAVE.stroke}
          stroke={`url(#${gradientId})`}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="opencraft-composer-recovery__label" role="status">
        {active ? (
          <FormattedMessage id="chat.composer.reconnecting" defaultMessage="Reconnecting…" />
        ) : waiting ? (
          <FormattedMessage id="chat.waitingForHost" defaultMessage="Waiting for execution host" />
        ) : null}
      </span>
    </div>
  );
}
