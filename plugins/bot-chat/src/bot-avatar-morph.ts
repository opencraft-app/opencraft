import type { BotAvatarEffect } from "./bot-avatar-motion";

export type BotAvatarEffectPhase = "reset" | "enter" | "hold" | "exit" | "done";

export interface BotAvatarEffectFrame {
  readonly effect: BotAvatarEffect;
  readonly phase: BotAvatarEffectPhase;
  readonly progress: number;
}

export interface BotAvatarEffectTiming {
  readonly enterDurationMs: number;
  readonly holdDurationMs?: number;
  readonly exitDurationMs: number;
}

interface ResolvedBotAvatarEffectTiming {
  readonly enterDurationMs: number;
  readonly holdDurationMs: number;
  readonly exitDurationMs: number;
}

const DEFAULT_TIMING: ResolvedBotAvatarEffectTiming = Object.freeze({
  enterDurationMs: 180,
  holdDurationMs: 900,
  exitDurationMs: 140,
});

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function easeOut(value: number): number {
  return 1 - (1 - clampUnit(value)) ** 3;
}

/** Actor-owned one-shot effect state. It never changes semantic Presence. */
export class BotAvatarEffectController {
  private current: BotAvatarEffect = "none";
  private pending: BotAvatarEffect = "none";
  private phase: BotAvatarEffectPhase = "done";
  private phaseStartedAt = 0;
  private readonly timing: ResolvedBotAvatarEffectTiming;

  constructor(timing: BotAvatarEffectTiming = DEFAULT_TIMING) {
    this.timing = {
      enterDurationMs: timing.enterDurationMs,
      holdDurationMs: timing.holdDurationMs ?? DEFAULT_TIMING.holdDurationMs,
      exitDurationMs: timing.exitDurationMs,
    };
  }

  transitionTo(effect: BotAvatarEffect, now: number): void {
    if (effect === this.current && this.phase !== "exit") return;
    if (effect === this.pending && this.phase === "exit") return;
    if (this.current === "none" || this.phase === "done") {
      if (effect === "none") return;
      this.current = effect;
      this.pending = "none";
      this.phase = "reset";
      this.phaseStartedAt = now;
      return;
    }
    this.pending = effect;
    this.phase = "exit";
    this.phaseStartedAt = now;
  }

  sample(now: number): BotAvatarEffectFrame {
    if (this.phase === "reset" && now > this.phaseStartedAt) {
      this.phase = "enter";
    }
    if (this.phase === "enter") {
      const progress =
        (now - this.phaseStartedAt) / this.timing.enterDurationMs;
      if (progress >= 1) {
        this.phase = "hold";
        this.phaseStartedAt = now;
        return { effect: this.current, phase: "hold", progress: 1 };
      }
      return {
        effect: this.current,
        phase: "enter",
        progress: easeOut(progress),
      };
    }
    if (
      this.phase === "hold" &&
      now - this.phaseStartedAt >= this.timing.holdDurationMs
    ) {
      this.pending = "none";
      this.phase = "exit";
      this.phaseStartedAt = now;
      return { effect: this.current, phase: "exit", progress: 1 };
    }
    if (this.phase === "exit") {
      const progress = (now - this.phaseStartedAt) / this.timing.exitDurationMs;
      if (progress >= 1) {
        const next = this.pending;
        this.current = next;
        this.pending = "none";
        this.phaseStartedAt = now;
        this.phase = next === "none" ? "done" : "reset";
        return {
          effect: this.current,
          phase: this.phase,
          progress: 0,
        };
      }
      return {
        effect: this.current,
        phase: "exit",
        progress: 1 - easeOut(progress),
      };
    }
    return {
      effect: this.current,
      phase: this.phase,
      progress: this.phase === "hold" ? 1 : 0,
    };
  }
}
