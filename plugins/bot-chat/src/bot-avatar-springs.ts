export interface BotAvatarSpringValue {
  value: number;
  velocity: number;
  target: number;
}

export interface BotAvatarMotionModel {
  readonly x: BotAvatarSpringValue;
  readonly y: BotAvatarSpringValue;
  readonly rotation: BotAvatarSpringValue;
  readonly scaleX: BotAvatarSpringValue;
  readonly scaleY: BotAvatarSpringValue;
  readonly eyeX: BotAvatarSpringValue;
  readonly eyeY: BotAvatarSpringValue;
  readonly eyeScale: BotAvatarSpringValue;
  readonly blink: BotAvatarSpringValue;
  readonly eyeGap: BotAvatarSpringValue;
  readonly leftEyeWidth: BotAvatarSpringValue;
  readonly rightEyeWidth: BotAvatarSpringValue;
  readonly leftEyeHeight: BotAvatarSpringValue;
  readonly rightEyeHeight: BotAvatarSpringValue;
  readonly leftEyeY: BotAvatarSpringValue;
  readonly rightEyeY: BotAvatarSpringValue;
  readonly leftEyeRotation: BotAvatarSpringValue;
  readonly rightEyeRotation: BotAvatarSpringValue;
  readonly shapeBlend: BotAvatarSpringValue;
}

export interface BotAvatarSpringTuning {
  readonly stiffness: number;
  readonly damping: number;
}

function spring(value: number): BotAvatarSpringValue {
  return { value, velocity: 0, target: value };
}

export function createBotAvatarMotionModel(): BotAvatarMotionModel {
  return {
    x: spring(0),
    y: spring(0),
    rotation: spring(0),
    scaleX: spring(1),
    scaleY: spring(1),
    eyeX: spring(0),
    eyeY: spring(0),
    eyeScale: spring(1),
    blink: spring(1),
    eyeGap: spring(10),
    leftEyeWidth: spring(1),
    rightEyeWidth: spring(1),
    leftEyeHeight: spring(1),
    rightEyeHeight: spring(1),
    leftEyeY: spring(0),
    rightEyeY: spring(0),
    leftEyeRotation: spring(0),
    rightEyeRotation: spring(0),
    shapeBlend: spring(1),
  };
}

function stepSpring(
  springValue: BotAvatarSpringValue,
  stiffness: number,
  damping: number,
  delta: number,
): number {
  springValue.velocity +=
    ((springValue.target - springValue.value) * stiffness -
      springValue.velocity * damping) *
    delta;
  springValue.value += springValue.velocity * delta;
  return (
    Math.abs(springValue.target - springValue.value) +
    Math.abs(springValue.velocity) * 0.02
  );
}

export function stepBotAvatarSprings(
  model: BotAvatarMotionModel,
  tuning: BotAvatarSpringTuning,
  delta: number,
): number {
  let residual = 0;
  let remaining = Math.min(0.05, Math.max(0, delta));
  while (remaining > 0) {
    const step = Math.min(remaining, 1 / 120);
    for (const [name, springValue] of Object.entries(model)) {
      const blink = name === "blink";
      const shape = name === "shapeBlend";
      const eye =
        name.startsWith("eye") ||
        name.startsWith("leftEye") ||
        name.startsWith("rightEye");
      residual += stepSpring(
        springValue,
        blink ? 720 : shape ? 190 : eye ? 250 : tuning.stiffness,
        blink ? 34 : shape ? 28 : eye ? 28 : tuning.damping,
        step,
      );
    }
    remaining -= step;
  }
  return residual;
}

export function snapBotAvatarMotionModel(model: BotAvatarMotionModel): void {
  for (const springValue of Object.values(model)) {
    springValue.value = springValue.target;
    springValue.velocity = 0;
  }
}
