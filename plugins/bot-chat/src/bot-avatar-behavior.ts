import {
  BOT_AVATAR_EMPHASIS_STATES,
  BOT_AVATAR_MOTION,
  botAvatarContinuousPose,
  deterministicAvatarUnit,
  type BotAvatarEyeExpression,
  type BotAvatarMotionPreset,
  type BotAvatarMotionState,
} from "./bot-avatar-motion";
import type { BotAvatarMotionModel } from "./bot-avatar-springs";

export interface BotAvatarStateTransition {
  readonly entered: boolean;
  readonly emphasis: boolean;
}

function seededGenerator(seed: string): () => number {
  let state = Math.max(
    1,
    Math.floor(deterministicAvatarUnit(seed) * 2_147_483_647),
  );
  return () => {
    state = Math.imul(state, 48_271) % 2_147_483_647;
    if (state <= 0) state += 2_147_483_646;
    return state / 2_147_483_647;
  };
}

function applyExpressionTargets(
  model: BotAvatarMotionModel,
  expression: BotAvatarEyeExpression,
): void {
  model.eyeGap.target = expression.gap;
  model.leftEyeWidth.target = expression.leftWidth;
  model.rightEyeWidth.target = expression.rightWidth;
  model.leftEyeHeight.target = expression.leftHeight;
  model.rightEyeHeight.target = expression.rightHeight;
  model.leftEyeY.target = expression.leftY;
  model.rightEyeY.target = expression.rightY;
  model.leftEyeRotation.target = expression.leftRotation;
  model.rightEyeRotation.target = expression.rightRotation;
}

/** Deterministic actor behavior; DOM and protocol state stay outside. */
export class BotAvatarBehaviorController {
  private readonly random: () => number;
  private state: BotAvatarMotionState;
  private requestedState: BotAvatarMotionState;
  private stateStartedAt: number;
  private transientUntil = 0;
  private transientTarget: BotAvatarMotionState;
  private nextPoseAt = 0;
  private nextBlinkAt: number;
  private reopenEyesAt = 0;
  private poseBiasX = 0;
  private poseBiasY = 0;
  private poseBiasRotation = 0;
  private ambientEyeX = 0;
  private ambientEyeY = 0;

  constructor(
    seed: string,
    state: BotAvatarMotionState,
    now: number,
    model: BotAvatarMotionModel,
  ) {
    this.random = seededGenerator(seed);
    this.state = state;
    this.requestedState = state;
    this.transientTarget = state;
    this.stateStartedAt = now;
    this.nextBlinkAt = now;
    this.applyStateTargets(model, BOT_AVATAR_MOTION[state]);
    this.choosePose(now);
    this.scheduleBlink(now, model);
  }

  setState(
    state: BotAvatarMotionState,
    now: number,
    model: BotAvatarMotionModel,
  ): BotAvatarStateTransition {
    if (state === this.requestedState)
      return { entered: false, emphasis: false };
    const visualState =
      this.state === "idle" && state === "listening" ? "waking" : state;
    this.requestedState = state;
    this.state = visualState;
    if (visualState === "waking") {
      this.transientUntil = now + 650;
      this.transientTarget = state;
    } else if (visualState === "notifying") {
      this.transientUntil = now + 700;
      this.transientTarget = "idle";
    } else if (visualState === "celebrate") {
      this.transientUntil = now + 1_200;
      this.transientTarget = "idle";
    } else {
      this.transientUntil = 0;
      this.transientTarget = state;
    }
    this.stateStartedAt = now;
    this.nextPoseAt = 0;
    const preset = BOT_AVATAR_MOTION[visualState];
    this.applyStateTargets(model, preset);
    this.choosePose(now);
    this.scheduleBlink(now, model);
    return {
      entered: true,
      emphasis: BOT_AVATAR_EMPHASIS_STATES.has(visualState),
    };
  }

  update(now: number, model: BotAvatarMotionModel): BotAvatarMotionPreset {
    if (this.transientUntil !== 0 && now >= this.transientUntil) {
      this.state = this.transientTarget;
      this.transientUntil = 0;
      this.stateStartedAt = now;
      this.nextPoseAt = 0;
      const requestedPreset = BOT_AVATAR_MOTION[this.state];
      this.applyStateTargets(model, requestedPreset);
      this.choosePose(now);
      this.scheduleBlink(now, model);
    }
    const preset = BOT_AVATAR_MOTION[this.state];
    if (now >= this.nextPoseAt) this.choosePose(now);
    const pose = botAvatarContinuousPose(this.state, now - this.stateStartedAt);
    model.x.target = pose.x + this.poseBiasX;
    model.y.target = pose.y + this.poseBiasY;
    model.rotation.target = preset.tilt + pose.rotation + this.poseBiasRotation;
    model.scaleX.target = pose.scaleX;
    model.scaleY.target = pose.scaleY;

    if (now >= this.nextBlinkAt) {
      model.blink.target = 0.06;
      this.reopenEyesAt = now + 86;
      this.scheduleBlink(now + 86, model);
    } else if (this.reopenEyesAt !== 0 && now >= this.reopenEyesAt) {
      model.blink.target = 1;
      this.reopenEyesAt = 0;
    }
    model.eyeX.target = this.ambientEyeX;
    model.eyeY.target = this.ambientEyeY;
    return preset;
  }

  snapshotState(): BotAvatarMotionState {
    return this.state;
  }

  private applyStateTargets(
    model: BotAvatarMotionModel,
    preset: BotAvatarMotionPreset,
  ): void {
    applyExpressionTargets(model, preset.expression);
    model.eyeScale.target = preset.eyeScale;
  }

  private choosePose(now: number): void {
    const preset = BOT_AVATAR_MOTION[this.state];
    const direction = this.random() > 0.5 ? 1 : -1;
    const energy = 0.55 + this.random() * 0.45;
    this.poseBiasX = (this.random() - 0.5) * preset.amplitude * 0.35;
    this.poseBiasY = (this.random() - 0.5) * preset.amplitude * 0.28;
    this.poseBiasRotation = direction * preset.amplitude * 0.3 * energy;
    this.ambientEyeX = direction * Math.min(1.55, preset.amplitude * 0.36);
    this.ambientEyeY =
      this.state === "thinking"
        ? -0.8
        : this.state === "searching"
          ? 0.35
          : this.state === "shy" || this.state === "sad"
            ? 0.65
            : 0;
    const [minimum, maximum] = preset.poseIntervalMs;
    this.nextPoseAt = now + minimum + this.random() * (maximum - minimum);
  }

  private scheduleBlink(now: number, model: BotAvatarMotionModel): void {
    const interval = BOT_AVATAR_MOTION[this.state].blinkIntervalMs;
    if (interval === null) {
      this.nextBlinkAt = Number.POSITIVE_INFINITY;
      this.reopenEyesAt = 0;
      model.blink.target = 1;
      return;
    }
    this.nextBlinkAt =
      now + interval[0] + this.random() * (interval[1] - interval[0]);
  }
}
