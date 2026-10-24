import type { BotPresenceFact, BotPresencePhase } from "@opencraft/bot-conversation";

/**
 * Presentation vocabulary supported by the current Bot actor.
 *
 * These names deliberately stay outside the AppServer protocol. A transport
 * publishes semantic Presence; the Stage is the single place that translates
 * it into presentation state. Replay may override that translation without
 * teaching the protocol about pixels or animation.
 */
export const BOT_AVATAR_MOTION_STATES = [
  "sleeping",
  "waking",
  "idle",
  "listening",
  "thinking",
  "searching",
  "working",
  "excited",
  "surprised",
  "suspicious",
  "angry",
  "drowsy",
  "happy",
  "curious",
  "confused",
  "bored",
  "proud",
  "shy",
  "sad",
  "laughing",
  "scared",
  "playful",
  "celebrate",
  "orbit",
  "radar",
  "progress",
  "spawning",
  "humming",
  "loading",
  "dictating",
  "sending",
  "receiving",
  "uploading",
  "writing",
  "notifying",
  "alerting",
  "bouncing",
  "dragging",
  "powering-down",
] as const;

export type BotAvatarMotionState = (typeof BOT_AVATAR_MOTION_STATES)[number];

export const BOT_AVATAR_EMPHASIS_STATES: ReadonlySet<BotAvatarMotionState> =
  new Set([
    "waking",
    "excited",
    "surprised",
    "happy",
    "laughing",
    "scared",
    "playful",
    "celebrate",
    "spawning",
    "notifying",
    "alerting",
  ]);

export type BotAvatarEffect =
  | "none"
  | "dots"
  | "orbit"
  | "radar"
  | "progress"
  | "gather"
  | "wave"
  | "send"
  | "receive"
  | "dock"
  | "ball"
  | "whirl"
  | "pencil"
  | "bang"
  | "standby";

export interface BotAvatarEyeExpression {
  readonly gap: number;
  readonly leftWidth: number;
  readonly rightWidth: number;
  readonly leftHeight: number;
  readonly rightHeight: number;
  readonly leftY: number;
  readonly rightY: number;
  readonly leftRotation: number;
  readonly rightRotation: number;
}

export interface BotAvatarMotionPreset {
  readonly poseIntervalMs: readonly [number, number];
  readonly blinkIntervalMs: readonly [number, number] | null;
  readonly amplitude: number;
  readonly tilt: number;
  readonly eyeScale: number;
  readonly stiffness: number;
  readonly damping: number;
  readonly expression: BotAvatarEyeExpression;
  readonly effect: BotAvatarEffect;
}

const NEUTRAL_EYES: BotAvatarEyeExpression = Object.freeze({
  gap: 10,
  leftWidth: 1,
  rightWidth: 1,
  leftHeight: 1,
  rightHeight: 1,
  leftY: 0,
  rightY: 0,
  leftRotation: 0,
  rightRotation: 0,
});

function eyes(
  changes: Partial<BotAvatarEyeExpression>,
): BotAvatarEyeExpression {
  return Object.freeze({ ...NEUTRAL_EYES, ...changes });
}

function preset(
  changes: Partial<BotAvatarMotionPreset>,
): BotAvatarMotionPreset {
  return Object.freeze({
    poseIntervalMs: [2_500, 4_500] as const,
    blinkIntervalMs: [3_000, 7_000] as const,
    amplitude: 1,
    tilt: 0,
    eyeScale: 1,
    stiffness: 168,
    damping: 24,
    expression: NEUTRAL_EYES,
    effect: "none" as const,
    ...changes,
  });
}

/**
 * Typed presets describe avatar timing and geometry.
 */
export const BOT_AVATAR_MOTION: Readonly<
  Record<BotAvatarMotionState, BotAvatarMotionPreset>
> = Object.freeze({
  sleeping: preset({
    poseIntervalMs: [6_000, 10_000],
    blinkIntervalMs: null,
    amplitude: 0.3,
    tilt: 7,
    eyeScale: 0.08,
    stiffness: 90,
    damping: 25,
    expression: eyes({
      leftHeight: 0.1,
      rightHeight: 0.1,
      leftY: 2.4,
      rightY: 2.4,
    }),
  }),
  waking: preset({
    poseIntervalMs: [800, 800],
    blinkIntervalMs: null,
    amplitude: 4.8,
    tilt: -4,
    eyeScale: 1.12,
    stiffness: 210,
    damping: 19,
    expression: eyes({
      leftWidth: 1.12,
      rightWidth: 1.12,
      leftHeight: 1.18,
      rightHeight: 1.18,
    }),
  }),
  idle: preset({
    poseIntervalMs: [9_000, 16_000],
    blinkIntervalMs: [6_000, 14_000],
    amplitude: 0.7,
    stiffness: 150,
    damping: 25,
  }),
  listening: preset({
    poseIntervalMs: [2_800, 5_000],
    blinkIntervalMs: [3_000, 7_000],
    amplitude: 1.5,
    tilt: -2,
    eyeScale: 1.04,
    expression: eyes({ gap: 10.6, leftHeight: 1.08, rightHeight: 1.08 }),
  }),
  thinking: preset({
    poseIntervalMs: [2_000, 3_600],
    blinkIntervalMs: [3_500, 7_000],
    amplitude: 2.2,
    tilt: 3.2,
    eyeScale: 0.82,
    stiffness: 145,
    damping: 22,
    expression: eyes({
      gap: 10.4,
      leftHeight: 0.76,
      rightHeight: 0.96,
      leftY: -0.3,
      rightY: 0.35,
      leftRotation: -7,
      rightRotation: 5,
    }),
    effect: "dots",
  }),
  searching: preset({
    poseIntervalMs: [1_000, 1_800],
    blinkIntervalMs: [1_600, 4_000],
    amplitude: 4.4,
    tilt: -4.4,
    eyeScale: 0.96,
    stiffness: 205,
    damping: 24,
    expression: eyes({
      gap: 11.2,
      leftWidth: 0.9,
      rightWidth: 0.9,
      leftHeight: 1.08,
      rightHeight: 1.08,
    }),
  }),
  working: preset({
    poseIntervalMs: [1_800, 3_200],
    blinkIntervalMs: [2_800, 5_500],
    amplitude: 2.2,
    tilt: -2.8,
    eyeScale: 1.05,
    stiffness: 175,
    damping: 23,
    expression: eyes({
      gap: 10.4,
      leftWidth: 1.12,
      rightWidth: 1.12,
      leftHeight: 1.02,
      rightHeight: 1.02,
    }),
  }),
  excited: preset({
    poseIntervalMs: [1_100, 2_000],
    blinkIntervalMs: [2_000, 4_000],
    amplitude: 5.6,
    tilt: -2,
    eyeScale: 1.08,
    stiffness: 215,
    damping: 19,
    expression: eyes({
      gap: 10.8,
      leftWidth: 0.88,
      rightWidth: 0.88,
      leftHeight: 0.72,
      rightHeight: 0.72,
      leftY: -0.7,
      rightY: -0.7,
      leftRotation: -5,
      rightRotation: 5,
    }),
  }),
  surprised: preset({
    poseIntervalMs: [2_500, 4_000],
    blinkIntervalMs: [1_800, 3_500],
    amplitude: 1.5,
    tilt: -7,
    eyeScale: 1.17,
    stiffness: 220,
    damping: 20,
    expression: eyes({
      gap: 11.4,
      leftWidth: 1.12,
      rightWidth: 1.12,
      leftHeight: 1.26,
      rightHeight: 1.26,
      leftY: -0.8,
      rightY: -0.8,
    }),
  }),
  suspicious: preset({
    poseIntervalMs: [2_600, 4_500],
    blinkIntervalMs: [4_500, 8_000],
    amplitude: 1.4,
    tilt: 1,
    eyeScale: 0.86,
    stiffness: 150,
    damping: 25,
    expression: eyes({
      gap: 12.2,
      leftHeight: 0.52,
      rightHeight: 0.76,
      leftY: 0.5,
      rightY: 0.1,
      leftRotation: 8,
      rightRotation: -4,
    }),
  }),
  angry: preset({
    poseIntervalMs: [2_200, 3_800],
    blinkIntervalMs: [3_500, 7_000],
    amplitude: 1.6,
    tilt: 3.5,
    eyeScale: 0.8,
    stiffness: 210,
    damping: 24,
    expression: eyes({
      gap: 12.6,
      leftWidth: 0.88,
      rightWidth: 0.88,
      leftHeight: 0.7,
      rightHeight: 0.7,
      leftRotation: 13,
      rightRotation: -13,
    }),
  }),
  drowsy: preset({
    poseIntervalMs: [4_000, 8_000],
    blinkIntervalMs: null,
    amplitude: 0.7,
    tilt: 6,
    eyeScale: 0.4,
    stiffness: 105,
    damping: 26,
    expression: eyes({
      leftHeight: 0.38,
      rightHeight: 0.38,
      leftY: 1.7,
      rightY: 1.7,
    }),
  }),
  happy: preset({
    poseIntervalMs: [2_500, 4_500],
    blinkIntervalMs: [2_500, 5_000],
    amplitude: 2.8,
    tilt: -2,
    eyeScale: 0.9,
    stiffness: 185,
    damping: 22,
    expression: eyes({
      leftHeight: 0.58,
      rightHeight: 0.58,
      leftY: -0.2,
      rightY: -0.2,
      leftRotation: -8,
      rightRotation: 8,
    }),
  }),
  curious: preset({
    poseIntervalMs: [1_800, 3_200],
    blinkIntervalMs: [2_500, 5_500],
    amplitude: 3.2,
    tilt: -2,
    eyeScale: 1.02,
    stiffness: 170,
    damping: 22,
    expression: eyes({
      gap: 10.8,
      leftWidth: 1.12,
      leftHeight: 1.18,
      rightWidth: 0.88,
      rightHeight: 0.9,
      leftY: -0.4,
      rightY: 0.3,
    }),
  }),
  confused: preset({
    poseIntervalMs: [2_200, 3_800],
    blinkIntervalMs: [2_800, 5_500],
    amplitude: 3.6,
    eyeScale: 0.88,
    stiffness: 165,
    damping: 23,
    expression: eyes({
      gap: 11.8,
      leftHeight: 0.72,
      rightHeight: 0.92,
      leftY: 0.4,
      rightY: -0.2,
      leftRotation: -12,
      rightRotation: -5,
    }),
  }),
  bored: preset({
    poseIntervalMs: [3_500, 6_000],
    blinkIntervalMs: [4_000, 8_000],
    amplitude: 0.8,
    tilt: 5,
    eyeScale: 0.62,
    stiffness: 110,
    damping: 26,
    expression: eyes({
      leftHeight: 0.45,
      rightHeight: 0.45,
      leftY: 1.4,
      rightY: 1.4,
    }),
  }),
  proud: preset({
    poseIntervalMs: [3_500, 6_000],
    blinkIntervalMs: [3_500, 7_000],
    amplitude: 1.1,
    tilt: -4,
    eyeScale: 0.92,
    expression: eyes({
      gap: 10.8,
      leftHeight: 0.65,
      rightHeight: 0.65,
      leftY: -0.8,
      rightY: -0.8,
      leftRotation: -5,
      rightRotation: 5,
    }),
  }),
  shy: preset({
    poseIntervalMs: [3_000, 5_500],
    blinkIntervalMs: [3_000, 6_000],
    amplitude: 1.2,
    tilt: 3,
    eyeScale: 0.82,
    expression: eyes({
      gap: 8.8,
      leftHeight: 0.68,
      rightHeight: 0.68,
      leftY: 0.7,
      rightY: 0.7,
    }),
  }),
  sad: preset({
    poseIntervalMs: [4_000, 7_000],
    blinkIntervalMs: [4_000, 8_000],
    amplitude: 0.7,
    tilt: 7,
    eyeScale: 0.72,
    stiffness: 105,
    damping: 26,
    expression: eyes({
      leftHeight: 0.6,
      rightHeight: 0.6,
      leftY: 1.3,
      rightY: 1.3,
      leftRotation: -11,
      rightRotation: 11,
    }),
  }),
  laughing: preset({
    poseIntervalMs: [1_200, 2_400],
    blinkIntervalMs: [2_500, 5_000],
    amplitude: 4.2,
    tilt: -4,
    eyeScale: 0.58,
    stiffness: 215,
    damping: 20,
    expression: eyes({
      leftHeight: 0.34,
      rightHeight: 0.34,
      leftY: -0.4,
      rightY: -0.4,
      leftRotation: -10,
      rightRotation: 10,
    }),
  }),
  scared: preset({
    poseIntervalMs: [900, 1_800],
    blinkIntervalMs: [1_200, 3_000],
    amplitude: 1.4,
    tilt: 2,
    eyeScale: 1.16,
    stiffness: 245,
    damping: 21,
    expression: eyes({
      gap: 11.5,
      leftWidth: 1.1,
      rightWidth: 1.1,
      leftHeight: 1.3,
      rightHeight: 1.3,
    }),
  }),
  playful: preset({
    poseIntervalMs: [1_500, 3_000],
    blinkIntervalMs: [2_000, 4_500],
    amplitude: 4.6,
    tilt: -3,
    eyeScale: 0.96,
    stiffness: 195,
    damping: 20,
    expression: eyes({
      gap: 11.8,
      leftHeight: 0.45,
      rightHeight: 1.05,
      leftY: -0.3,
      rightY: 0,
      leftRotation: -10,
    }),
  }),
  celebrate: preset({
    poseIntervalMs: [1_400, 2_600],
    blinkIntervalMs: [2_200, 4_500],
    amplitude: 5.2,
    tilt: -2,
    eyeScale: 1.05,
    stiffness: 220,
    damping: 18,
    expression: eyes({
      leftHeight: 0.56,
      rightHeight: 0.56,
      leftY: -0.6,
      rightY: -0.6,
      leftRotation: -10,
      rightRotation: 10,
    }),
  }),
  orbit: preset({
    poseIntervalMs: [4_000, 8_000],
    blinkIntervalMs: null,
    amplitude: 1.1,
    stiffness: 140,
    damping: 23,
    effect: "orbit",
  }),
  radar: preset({
    poseIntervalMs: [4_000, 8_000],
    blinkIntervalMs: null,
    amplitude: 0.7,
    stiffness: 160,
    damping: 24,
    effect: "radar",
  }),
  progress: preset({
    poseIntervalMs: [4_000, 8_000],
    blinkIntervalMs: null,
    amplitude: 0.6,
    stiffness: 160,
    damping: 24,
    effect: "progress",
  }),
  spawning: preset({
    poseIntervalMs: [1_200, 1_200],
    blinkIntervalMs: null,
    amplitude: 5,
    eyeScale: 1.12,
    stiffness: 230,
    damping: 17,
    expression: eyes({ leftHeight: 1.2, rightHeight: 1.2 }),
    effect: "gather",
  }),
  humming: preset({
    poseIntervalMs: [5_000, 9_000],
    blinkIntervalMs: [4_000, 8_000],
    amplitude: 1.5,
    tilt: -1,
    eyeScale: 0.82,
    expression: eyes({ leftHeight: 0.62, rightHeight: 0.62 }),
  }),
  loading: preset({
    poseIntervalMs: [6_000, 10_000],
    blinkIntervalMs: null,
    amplitude: 0.6,
    effect: "whirl",
  }),
  dictating: preset({
    poseIntervalMs: [4_000, 8_000],
    blinkIntervalMs: null,
    amplitude: 1.1,
    eyeScale: 1.04,
    expression: eyes({ gap: 10.6, leftHeight: 1.08, rightHeight: 1.08 }),
    effect: "wave",
  }),
  sending: preset({
    poseIntervalMs: [4_000, 8_000],
    blinkIntervalMs: null,
    amplitude: 1.2,
    stiffness: 190,
    damping: 22,
    effect: "send",
  }),
  receiving: preset({
    poseIntervalMs: [4_000, 8_000],
    blinkIntervalMs: null,
    amplitude: 1.2,
    eyeScale: 1.06,
    effect: "receive",
  }),
  uploading: preset({
    poseIntervalMs: [4_000, 8_000],
    blinkIntervalMs: null,
    amplitude: 1,
    eyeScale: 0.94,
    effect: "dock",
  }),
  writing: preset({
    poseIntervalMs: [4_000, 8_000],
    blinkIntervalMs: null,
    amplitude: 1.3,
    tilt: -4,
    eyeScale: 0.94,
    stiffness: 185,
    damping: 24,
    expression: eyes({
      gap: 10.8,
      leftWidth: 0.92,
      rightWidth: 0.92,
      leftHeight: 0.9,
      rightHeight: 0.9,
    }),
    effect: "pencil",
  }),
  notifying: preset({
    poseIntervalMs: [1_500, 2_600],
    blinkIntervalMs: [2_000, 4_000],
    amplitude: 2.7,
    tilt: -3,
    eyeScale: 1.1,
    stiffness: 210,
    damping: 20,
    expression: eyes({ leftHeight: 1.18, rightHeight: 1.18 }),
  }),
  alerting: preset({
    poseIntervalMs: [2_000, 3_600],
    blinkIntervalMs: null,
    amplitude: 1.1,
    tilt: -4,
    eyeScale: 1.12,
    stiffness: 220,
    damping: 22,
    expression: eyes({ gap: 11.2, leftHeight: 1.2, rightHeight: 1.2 }),
    effect: "bang",
  }),
  bouncing: preset({
    poseIntervalMs: [3_000, 6_000],
    blinkIntervalMs: null,
    amplitude: 4.5,
    stiffness: 225,
    damping: 17,
    expression: eyes({ leftHeight: 0.72, rightHeight: 0.72 }),
    effect: "ball",
  }),
  dragging: preset({
    poseIntervalMs: [1_600, 3_000],
    blinkIntervalMs: [2_200, 4_500],
    amplitude: 4.2,
    tilt: -8,
    eyeScale: 1.05,
    stiffness: 205,
    damping: 20,
    expression: eyes({ gap: 11.5, leftHeight: 1.12, rightHeight: 1.12 }),
  }),
  "powering-down": preset({
    poseIntervalMs: [6_000, 9_000],
    blinkIntervalMs: null,
    amplitude: 0.5,
    tilt: 8,
    eyeScale: 0.16,
    stiffness: 90,
    damping: 27,
    expression: eyes({
      leftHeight: 0.18,
      rightHeight: 0.18,
      leftY: 2.2,
      rightY: 2.2,
    }),
    effect: "standby",
  }),
});

export interface BotAvatarContinuousPose {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

/** State-specific continuous gesture; React never receives per-frame updates. */
export function botAvatarContinuousPose(
  state: BotAvatarMotionState,
  elapsedMs: number,
): BotAvatarContinuousPose {
  const t = elapsedMs / 1_000;
  const neutral = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
  switch (state) {
    case "sleeping":
      return {
        x: Math.sin(t * 0.25) * 0.35,
        y: 1.3 + Math.sin(t * 0.55) * 0.45,
        rotation: -2,
        scaleX: 1.008,
        scaleY: 0.992,
      };
    case "waking":
      return {
        x: 0,
        y: -Math.sin(Math.min(1, t / 0.8) * Math.PI) * 3.2,
        rotation: Math.sin(t * 9) * 4 * Math.max(0, 1 - t / 1.5),
        scaleX: 1.04,
        scaleY: 0.96,
      };
    case "idle":
      return {
        x: Math.sin(t * 0.17) * 0.3,
        y: Math.sin(t * 0.85) * 0.28,
        rotation: Math.sin(t * 0.27) * 0.7,
        scaleX: 1.004,
        scaleY: 0.996,
      };
    case "listening":
      return {
        x: 1.4 + Math.sin(t * 0.5) * 0.45,
        y: -0.25 + Math.sin(t * 0.8) * 0.25,
        rotation: -2 + Math.sin(t * 0.55) * 1.2,
        scaleX: 1.012,
        scaleY: 0.988,
      };
    case "thinking":
      return {
        x: -1.9 + Math.sin(t * 0.35) * 1.1,
        y: Math.sin(t * 0.6) * 0.45,
        rotation: Math.sin(t * 0.3) * 3.8,
        scaleX: 1,
        scaleY: 1,
      };
    case "searching":
      return {
        x: Math.sin(t * 1.3) * 3.2,
        y: Math.sin(t * 1.7) * 0.45,
        rotation: Math.sin(t * 1.3) * 5.5,
        scaleX: 1.012,
        scaleY: 0.988,
      };
    case "working":
      return {
        x: 0.7 + Math.sin(t * 2.1) * 0.55,
        y: Math.max(0, Math.sin(t * 2.1)) * -0.75,
        rotation: 1.5,
        scaleX: 1.025,
        scaleY: 0.975,
      };
    case "excited":
      return {
        x: Math.sin(t * Math.PI * 2.2) * 1.7,
        y: -Math.abs(Math.sin(t * Math.PI * 2.2)) * 2.7,
        rotation: Math.sin(t * 1.1) * 4,
        scaleX: 1.07,
        scaleY: 0.93,
      };
    case "surprised":
      return {
        ...neutral,
        y: -1.4 * Math.max(0, 1 - t / 0.7),
        scaleX: 1.08,
        scaleY: 1.08,
      };
    case "suspicious":
      return {
        x: -1.3 + Math.sin(t * 0.3) * 0.6,
        y: 0.2,
        rotation: Math.sin(t * 0.25) * -3.2,
        scaleX: 0.98,
        scaleY: 1.01,
      };
    case "angry":
      return {
        x: Math.sin(t * 32) * 0.65,
        y: 0.35,
        rotation: 0,
        scaleX: 1.03,
        scaleY: 0.97,
      };
    case "drowsy":
      return {
        x: Math.sin(t * 0.32) * 0.55,
        y: 1.4 + Math.sin(t * 0.36) * 0.5,
        rotation: Math.sin(t * 0.2) * 1.2,
        scaleX: 1.01,
        scaleY: 0.99,
      };
    case "happy":
      return {
        x: Math.sin(t * 1.2) * 0.7,
        y: -Math.abs(Math.sin(t * 1.2)) * 0.7,
        rotation: Math.sin(t * 1.1) * 2,
        scaleX: 1.035,
        scaleY: 0.965,
      };
    case "curious":
      return {
        x: 2 + Math.sin(t * 0.7) * 1.2,
        y: -0.4,
        rotation: Math.sin(t * 0.6) * 4,
        scaleX: 1.035,
        scaleY: 0.965,
      };
    case "confused":
      return {
        x: Math.sin(t * 0.7) * 2.4,
        y: 0.2,
        rotation: Math.sin(t * 0.7) * 2.5,
        scaleX: 0.99,
        scaleY: 1.01,
      };
    case "bored":
      return {
        x: -0.6 + Math.sin(t * 0.25) * 0.7,
        y: 1.1 + Math.sin(t * 0.35) * 0.3,
        rotation: Math.sin(t * 0.2) * 3,
        scaleX: 0.99,
        scaleY: 1.01,
      };
    case "proud":
      return {
        x: Math.sin(t * 0.4) * 0.45,
        y: -0.8,
        rotation: Math.sin(t * 0.35) * 1.6,
        scaleX: 1.025,
        scaleY: 0.975,
      };
    case "shy":
      return {
        x: -1.5 + Math.sin(t * 0.5) * 0.55,
        y: 0.7,
        rotation: -3 + Math.sin(t * 0.4) * 1.5,
        scaleX: 0.96,
        scaleY: 1.01,
      };
    case "sad":
      return {
        x: 0.5 + Math.sin(t * 0.3) * 0.35,
        y: 1.3 + Math.sin(t * 0.4) * 0.25,
        rotation: Math.sin(t * 0.25),
        scaleX: 0.97,
        scaleY: 1.02,
      };
    case "laughing":
      return {
        x: Math.sin(t * 2.2) * 0.7,
        y: -Math.abs(Math.sin(t * 2.2)) * 1.5,
        rotation: Math.sin(t * 2) * 1.8,
        scaleX: 1.035,
        scaleY: 0.965,
      };
    case "scared":
      return {
        x: Math.sin(t * 40) * 0.5,
        y: 0.2,
        rotation: Math.sin(t * 50) * 1.2,
        scaleX: 0.95,
        scaleY: 1.06,
      };
    case "playful":
      return {
        x: Math.sin(t * 1.4) * 2,
        y: -Math.abs(Math.sin(t * 2.2)) * 0.9,
        rotation: Math.sin(t * 1.1) * 3.2,
        scaleX: 1.04,
        scaleY: 0.96,
      };
    case "celebrate":
      return {
        x: 0,
        y: -Math.abs(Math.sin(t * 1.6)) * 1.3,
        rotation: Math.sin(t * 2.4) * 2.5,
        scaleX: 1.07,
        scaleY: 0.93,
      };
    case "humming":
      return {
        x: Math.sin(t * 0.9) * 0.55,
        y: Math.sin(t * 1.8) * 0.3,
        rotation: Math.sin(t * 0.9) * 1.4,
        scaleX: 1.01,
        scaleY: 0.99,
      };
    case "bouncing":
      return {
        x: 0,
        y: -Math.abs(Math.sin(t * 2.6)) * 3.6,
        rotation: Math.sin(t * 1.3) * 2,
        scaleX: 1.04,
        scaleY: 0.96,
      };
    case "dragging":
      return {
        x: Math.sin(t * 2.6) * 1.4,
        y: -1,
        rotation: -8 + Math.sin(t * 1.4) * 2,
        scaleX: 1.05,
        scaleY: 0.95,
      };
    case "powering-down":
      return { x: 0, y: 1.5, rotation: 0, scaleX: 0.98, scaleY: 0.94 };
    default:
      return neutral;
  }
}

export function botAvatarMotionState(
  phase: BotPresencePhase,
  fact: BotPresenceFact | null,
): BotAvatarMotionState {
  if (phase === "idle") return "idle";
  if (phase === "blocked") return "alerting";
  if (phase === "waiting") return "orbit";
  if (phase === "typing") return "writing";
  const verb = fact?.activity?.verb;
  if (verb === "searching" || verb === "reading") return "searching";
  if (verb === "writing" || verb === "coding") return "writing";
  if (verb === "messaging") return "sending";
  if (verb === "waiting") return "orbit";
  if (verb === "spawning") return "spawning";
  if (verb === "running") return "working";
  return phase === "thinking" ? "thinking" : "working";
}

export function deterministicAvatarUnit(seed: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16_777_619);
  }
  return (hash >>> 0) / 4_294_967_296;
}
