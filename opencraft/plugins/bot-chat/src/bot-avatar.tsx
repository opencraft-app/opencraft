import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from "react";

import type { BotParticipantSnapshot } from "@opencraft/bot-conversation";

import {
  BOT_AVATAR_EMPHASIS_STATES,
  BOT_AVATAR_MOTION,
  botAvatarContinuousPose,
  deterministicAvatarUnit,
  type BotAvatarEyeExpression,
  type BotAvatarMotionState,
} from "./bot-avatar-motion";
import {
  BOT_AVATAR_SHAPE_NAMES,
  BOT_AVATAR_SHAPE_PATHS,
  type BotAvatarShapeName,
} from "./bot-avatar-shapes";
import {
  useBotAvatarPointer,
  useBotAvatarProjection,
} from "./bot-avatar-stage-context";

export interface BotAvatarHandle {
  spin(): void;
  bounce(): void;
  burst(): void;
}

interface MotionValue {
  value: number;
  velocity: number;
  target: number;
}

interface MotionModel {
  x: MotionValue;
  y: MotionValue;
  rotation: MotionValue;
  scaleX: MotionValue;
  scaleY: MotionValue;
  eyeX: MotionValue;
  eyeY: MotionValue;
  eyeScale: MotionValue;
  blink: MotionValue;
  eyeGap: MotionValue;
  leftEyeWidth: MotionValue;
  rightEyeWidth: MotionValue;
  leftEyeHeight: MotionValue;
  rightEyeHeight: MotionValue;
  leftEyeY: MotionValue;
  rightEyeY: MotionValue;
  leftEyeRotation: MotionValue;
  rightEyeRotation: MotionValue;
}

interface ActionTimeline {
  spinStartedAt: number;
  bounceStartedAt: number;
  burstStartedAt: number;
}

interface ParkableClock {
  now(rawTime?: number): number;
  park(rawTime?: number): void;
  unpark(rawTime?: number): void;
}

function motionValue(value: number): MotionValue {
  return { value, velocity: 0, target: value };
}

function createMotionModel(): MotionModel {
  return {
    x: motionValue(0),
    y: motionValue(0),
    rotation: motionValue(0),
    scaleX: motionValue(1),
    scaleY: motionValue(1),
    eyeX: motionValue(0),
    eyeY: motionValue(0),
    eyeScale: motionValue(1),
    blink: motionValue(1),
    eyeGap: motionValue(10),
    leftEyeWidth: motionValue(1),
    rightEyeWidth: motionValue(1),
    leftEyeHeight: motionValue(1),
    rightEyeHeight: motionValue(1),
    leftEyeY: motionValue(0),
    rightEyeY: motionValue(0),
    leftEyeRotation: motionValue(0),
    rightEyeRotation: motionValue(0),
  };
}

function integrate(
  value: MotionValue,
  stiffness: number,
  damping: number,
  dt: number,
): number {
  value.velocity +=
    ((value.target - value.value) * stiffness - value.velocity * damping) * dt;
  value.value += value.velocity * dt;
  return Math.abs(value.target - value.value) + Math.abs(value.velocity) * 0.02;
}

function snapModel(model: MotionModel): void {
  for (const value of Object.values(model)) {
    value.value = value.target;
    value.velocity = 0;
  }
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

function createParkableClock(initiallyParked: boolean): ParkableClock {
  let parkedAt = initiallyParked ? performance.now() : null;
  let parkedDuration = 0;
  return {
    now(rawTime = performance.now()) {
      return (parkedAt ?? rawTime) - parkedDuration;
    },
    park(rawTime = performance.now()) {
      if (parkedAt === null) parkedAt = rawTime;
    },
    unpark(rawTime = performance.now()) {
      if (parkedAt === null) return;
      parkedDuration += rawTime - parkedAt;
      parkedAt = null;
    },
  };
}

function applyExpressionTargets(
  model: MotionModel,
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

function setEyeGeometry(
  element: SVGRectElement,
  centerX: number,
  centerY: number,
  widthScale: number,
  heightScale: number,
  rotation: number,
): void {
  const width = 4.3 * widthScale;
  const height = 6.9 * heightScale;
  element.setAttribute("x", String(centerX - width / 2));
  element.setAttribute("y", String(centerY - height / 2));
  element.setAttribute("width", String(width));
  element.setAttribute("height", String(height));
  element.setAttribute("rx", String(Math.min(width / 2, 2.15)));
  element.setAttribute(
    "transform",
    `rotate(${rotation} ${centerX} ${centerY})`,
  );
}

export interface BotAvatarProps {
  readonly participant: BotParticipantSnapshot;
  readonly followPointer?: boolean;
  readonly presentation?: "live" | "static";
  readonly shape?: BotAvatarShapeName;
  readonly size?: "normal" | "large";
  readonly sourceId?: string;
}

export const BotAvatar = forwardRef<BotAvatarHandle, BotAvatarProps>(
  function BotAvatar(
    {
      participant,
      followPointer = false,
      presentation = "static",
      shape: shapeOverride,
      size = "normal",
      sourceId,
    },
    forwardedRef,
  ) {
    const projection = useBotAvatarProjection(participant.participantId);
    const pointer = useBotAvatarPointer();
    const motionState =
      presentation === "live" ? projection.motionState : "idle";
    const phase = presentation === "live" ? projection.phase : "idle";
    const preset = BOT_AVATAR_MOTION[motionState];
    const stateRef = useRef(motionState);
    const bodyRef = useRef<SVGGElement>(null);
    const eyesRef = useRef<SVGGElement>(null);
    const leftEyeRef = useRef<SVGRectElement>(null);
    const rightEyeRef = useRef<SVGRectElement>(null);
    const actionParticlesRef = useRef<SVGGElement>(null);
    const wakeRef = useRef<() => void>(() => undefined);
    const clockNowRef = useRef<() => number>(() => performance.now());
    const actionRef = useRef<ActionTimeline>({
      spinStartedAt: Number.NEGATIVE_INFINITY,
      bounceStartedAt: Number.NEGATIVE_INFINITY,
      burstStartedAt: Number.NEGATIVE_INFINITY,
    });

    stateRef.current = motionState;

    useImperativeHandle(
      forwardedRef,
      () => ({
        spin() {
          actionRef.current.spinStartedAt = clockNowRef.current();
          wakeRef.current();
        },
        bounce() {
          actionRef.current.bounceStartedAt = clockNowRef.current();
          wakeRef.current();
        },
        burst() {
          actionRef.current.burstStartedAt = clockNowRef.current();
          wakeRef.current();
        },
      }),
      [],
    );

    useEffect(() => {
      const body = bodyRef.current;
      const eyesGroup = eyesRef.current;
      const leftEye = leftEyeRef.current;
      const rightEye = rightEyeRef.current;
      const actionParticles = actionParticlesRef.current;
      if (
        body === null ||
        eyesGroup === null ||
        leftEye === null ||
        rightEye === null ||
        actionParticles === null
      )
        return;
      if (presentation === "static") {
        body.removeAttribute("transform");
        eyesGroup.removeAttribute("transform");
        actionParticles.style.opacity = "0";
        return;
      }

      const model = createMotionModel();
      const random = seededGenerator(participant.participantId);
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      );
      const clock = createParkableClock(
        document.hidden || !document.hasFocus(),
      );
      let frame = 0;
      let lastTime = clock.now();
      let stateStartedAt = lastTime;
      let nextPoseAt = 0;
      let nextBlinkAt = lastTime + 1_800 + random() * 2_800;
      let reopenEyesAt = 0;
      let paused = document.hidden || !document.hasFocus();
      let previousState = stateRef.current;
      let poseBiasX = 0;
      let poseBiasY = 0;
      let poseBiasRotation = 0;
      let ambientEyeX = 0;
      let ambientEyeY = 0;

      clockNowRef.current = () => clock.now();

      const choosePose = (time: number) => {
        const currentPreset = BOT_AVATAR_MOTION[stateRef.current];
        const direction = random() > 0.5 ? 1 : -1;
        const energy = 0.55 + random() * 0.45;
        poseBiasX = (random() - 0.5) * currentPreset.amplitude * 0.35;
        poseBiasY = (random() - 0.5) * currentPreset.amplitude * 0.28;
        poseBiasRotation = direction * currentPreset.amplitude * 0.3 * energy;
        ambientEyeX =
          direction * Math.min(1.55, currentPreset.amplitude * 0.36);
        ambientEyeY =
          stateRef.current === "thinking"
            ? -0.8
            : stateRef.current === "searching"
              ? 0.35
              : stateRef.current === "shy" || stateRef.current === "sad"
                ? 0.65
                : 0;
        const [minimum, maximum] = currentPreset.poseIntervalMs;
        nextPoseAt = time + minimum + random() * (maximum - minimum);
      };

      const scheduleBlink = (time: number) => {
        const interval = BOT_AVATAR_MOTION[stateRef.current].blinkIntervalMs;
        if (interval === null) {
          nextBlinkAt = Number.POSITIVE_INFINITY;
          reopenEyesAt = 0;
          model.blink.target = 1;
          return;
        }
        nextBlinkAt =
          time + interval[0] + random() * (interval[1] - interval[0]);
      };

      const render = (time: number) => {
        const spinProgress = Math.min(
          1,
          Math.max(0, (time - actionRef.current.spinStartedAt) / 760),
        );
        const spin = spinProgress < 1 ? (1 - (1 - spinProgress) ** 3) * 360 : 0;
        const bounceProgress = Math.min(
          1,
          Math.max(0, (time - actionRef.current.bounceStartedAt) / 620),
        );
        const bounce =
          bounceProgress < 1
            ? Math.sin(bounceProgress * Math.PI) *
              5.5 *
              (1 - bounceProgress * 0.28)
            : 0;
        const burstProgress = Math.min(
          1,
          Math.max(0, (time - actionRef.current.burstStartedAt) / 620),
        );
        const burst =
          burstProgress < 1 ? Math.sin(burstProgress * Math.PI) * 0.16 : 0;
        body.setAttribute(
          "transform",
          `translate(${20 + model.x.value} ${20 + model.y.value - bounce}) rotate(${model.rotation.value + spin}) scale(${model.scaleX.value + burst} ${model.scaleY.value + burst}) translate(-20 -20)`,
        );
        eyesGroup.setAttribute(
          "transform",
          `translate(${model.eyeX.value} ${model.eyeY.value}) scale(${model.eyeScale.value} ${model.eyeScale.value * model.blink.value})`,
        );
        const leftCenterX = 20 - model.eyeGap.value / 2;
        const rightCenterX = 20 + model.eyeGap.value / 2;
        setEyeGeometry(
          leftEye,
          leftCenterX,
          19 + model.leftEyeY.value,
          model.leftEyeWidth.value,
          model.leftEyeHeight.value,
          model.leftEyeRotation.value,
        );
        setEyeGeometry(
          rightEye,
          rightCenterX,
          19 + model.rightEyeY.value,
          model.rightEyeWidth.value,
          model.rightEyeHeight.value,
          model.rightEyeRotation.value,
        );
        if (burstProgress < 1) {
          actionParticles.style.opacity = String(
            Math.sin(burstProgress * Math.PI) * 0.92,
          );
          actionParticles.setAttribute(
            "transform",
            `rotate(${burstProgress * 38 - 19} 20 20) scale(${0.72 + burstProgress * 0.62})`,
          );
        } else {
          // The state-driven particle vocabulary is CSS-owned. Inline styles
          // exist only for an imperative one-shot burst and must yield again
          // when that action finishes.
          actionParticles.style.removeProperty("opacity");
        }
      };

      const tick = (rawTime: number) => {
        frame = 0;
        if (paused) return;
        const time = clock.now(rawTime);
        const state = stateRef.current;
        const currentPreset = BOT_AVATAR_MOTION[state];
        if (state !== previousState) {
          previousState = state;
          stateStartedAt = time;
          nextPoseAt = 0;
          applyExpressionTargets(model, currentPreset.expression);
          model.eyeScale.target = currentPreset.eyeScale;
          scheduleBlink(time);
          if (BOT_AVATAR_EMPHASIS_STATES.has(state)) {
            actionRef.current.burstStartedAt = time;
          }
        }
        if (nextPoseAt === 0 || time >= nextPoseAt) choosePose(time);

        const pose = botAvatarContinuousPose(state, time - stateStartedAt);
        model.x.target = pose.x + poseBiasX;
        model.y.target = pose.y + poseBiasY;
        model.rotation.target =
          currentPreset.tilt + pose.rotation + poseBiasRotation;
        model.scaleX.target = pose.scaleX;
        model.scaleY.target = pose.scaleY;

        if (time >= nextBlinkAt) {
          model.blink.target = 0.06;
          reopenEyesAt = time + 86;
          scheduleBlink(time + 86);
        } else if (reopenEyesAt !== 0 && time >= reopenEyesAt) {
          model.blink.target = 1;
          reopenEyesAt = 0;
        }

        let pointerEngagement = 0;
        if (followPointer && pointer.snapshot.current.active) {
          const bounds = body.ownerSVGElement?.getBoundingClientRect();
          if (bounds !== undefined && bounds.width > 0 && bounds.height > 0) {
            const dx =
              pointer.snapshot.current.x - (bounds.left + bounds.width / 2);
            const dy =
              pointer.snapshot.current.y - (bounds.top + bounds.height / 2);
            const distance = Math.hypot(dx, dy);
            const nearness = Math.max(0, Math.min(1, (440 - distance) / 340));
            pointerEngagement = Math.min(1, distance / 34) * nearness;
            if (pointerEngagement > 0) {
              model.eyeX.target =
                (dx / Math.max(1, distance)) * 3.15 * pointerEngagement;
              model.eyeY.target =
                (dy / Math.max(1, distance)) * 2.35 * pointerEngagement;
              model.rotation.target +=
                (dx / Math.max(1, distance)) * 1.65 * pointerEngagement;
            }
          }
        }
        if (pointerEngagement === 0) {
          model.eyeX.target = ambientEyeX;
          model.eyeY.target = ambientEyeY;
        }

        const elapsed = Math.min(0.05, Math.max(0, (time - lastTime) / 1_000));
        lastTime = time;
        let remaining = elapsed;
        while (remaining > 0) {
          const step = Math.min(remaining, 1 / 120);
          for (const [name, value] of Object.entries(model)) {
            const isBlink = name === "blink";
            const isEyeTopology =
              name.startsWith("eye") ||
              name.startsWith("leftEye") ||
              name.startsWith("rightEye");
            integrate(
              value,
              isBlink ? 720 : isEyeTopology ? 250 : currentPreset.stiffness,
              isBlink ? 34 : isEyeTopology ? 28 : currentPreset.damping,
              step,
            );
          }
          remaining -= step;
        }
        render(time);
        frame = requestAnimationFrame(tick);
      };

      const wake = () => {
        if (paused || frame !== 0) return;
        const time = clock.now();
        if (reducedMotion.matches) {
          const currentPreset = BOT_AVATAR_MOTION[stateRef.current];
          applyExpressionTargets(model, currentPreset.expression);
          model.eyeScale.target = currentPreset.eyeScale;
          const pose = botAvatarContinuousPose(stateRef.current, 0);
          model.x.target = pose.x;
          model.y.target = pose.y;
          model.rotation.target = pose.rotation;
          model.scaleX.target = pose.scaleX;
          model.scaleY.target = pose.scaleY;
          snapModel(model);
          render(time);
          return;
        }
        lastTime = time;
        frame = requestAnimationFrame(tick);
      };

      wakeRef.current = wake;
      const setPaused = (next: boolean) => {
        if (paused === next) return;
        paused = next;
        if (paused) {
          clock.park();
          cancelAnimationFrame(frame);
          frame = 0;
        } else {
          clock.unpark();
          lastTime = clock.now();
          wake();
        }
      };
      const onVisibility = () =>
        setPaused(document.hidden || !document.hasFocus());
      const onBlur = () => setPaused(true);
      const onFocus = () => setPaused(document.hidden);
      const onReducedMotion = () => {
        cancelAnimationFrame(frame);
        frame = 0;
        wake();
      };

      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("blur", onBlur);
      window.addEventListener("focus", onFocus);
      reducedMotion.addEventListener("change", onReducedMotion);
      const unsubscribePointer = followPointer
        ? pointer.subscribe(wake)
        : () => undefined;
      applyExpressionTargets(
        model,
        BOT_AVATAR_MOTION[previousState].expression,
      );
      model.eyeScale.target = BOT_AVATAR_MOTION[previousState].eyeScale;
      choosePose(lastTime);
      scheduleBlink(lastTime);
      if (!paused) wake();

      return () => {
        wakeRef.current = () => undefined;
        clockNowRef.current = () => performance.now();
        cancelAnimationFrame(frame);
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("focus", onFocus);
        reducedMotion.removeEventListener("change", onReducedMotion);
        unsubscribePointer();
      };
    }, [followPointer, participant.participantId, pointer, presentation]);

    useEffect(() => {
      wakeRef.current();
    }, [motionState]);

    const avatar = participant.avatar;
    if (avatar?.kind === "image-url") {
      return (
        <span
          className="bot-chat-avatar bot-chat-avatar--image"
          data-phase={phase}
          data-presentation={presentation}
          data-size={size}
        >
          <img alt={avatar.alt} draggable={false} src={avatar.url} />
        </span>
      );
    }

    const background = avatar?.background ?? "#17191c";
    const foreground = avatar?.foreground ?? "#ffffff";

    const shapeIndex = Math.floor(
      deterministicAvatarUnit(participant.participantId) *
        BOT_AVATAR_SHAPE_NAMES.length,
    );
    const shape = shapeOverride ?? BOT_AVATAR_SHAPE_NAMES[shapeIndex] ?? "blob";
    return (
      <span
        aria-label={participant.displayName}
        className="bot-chat-avatar bot-chat-avatar--persona"
        data-effect={preset.effect}
        data-emphasis={
          BOT_AVATAR_EMPHASIS_STATES.has(motionState) || undefined
        }
        data-motion={motionState}
        data-phase={phase}
        data-presentation={presentation}
        data-size={size}
        role="img"
        style={
          {
            "--bot-avatar-background": background,
            "--bot-avatar-highlight": `color-mix(in srgb, ${background} 76%, white)`,
            "--bot-avatar-foreground": foreground,
            color: background,
          } as CSSProperties
        }
      >
        <svg
          aria-hidden="true"
          className="bot-chat-avatar__persona"
          data-shape={shape}
          viewBox="-6 -6 52 52"
        >
          <g id={sourceId} ref={bodyRef}>
            <g className="bot-chat-avatar__effect" data-layer="back">
              <circle
                className="bot-chat-avatar__effect-ring"
                cx="20"
                cy="20"
                fill="none"
                opacity={
                  preset.effect === "gather" || preset.effect === "whirl"
                    ? 1
                    : 0
                }
                r="21"
                stroke={background}
              />
              <ellipse
                className="bot-chat-avatar__effect-belt"
                cx="20"
                cy="20"
                fill="none"
                opacity={preset.effect === "orbit" ? 1 : 0}
                rx="24"
                ry="9"
                stroke={background}
              />
              <path
                className="bot-chat-avatar__effect-radar"
                d="M20 20 38 10A21 21 0 0 1 40 30Z"
                fill="none"
                opacity={preset.effect === "radar" ? 1 : 0}
                stroke={background}
              />
              <g
                className="bot-chat-avatar__effect-dots"
                fill={background}
                opacity={preset.effect === "dots" ? 1 : 0}
                stroke="none"
              >
                <circle cx="7" cy="5" r="1.7" />
                <circle cx="1.5" cy="13" r="1.2" />
                <circle cx="-1" cy="22" r="0.8" />
              </g>
              <path
                className="bot-chat-avatar__effect-wave"
                d="M-1 16c4-5 7 5 11 0s7 5 11 0 7 5 11 0 7 5 11 0"
                fill="none"
                opacity={preset.effect === "wave" ? 1 : 0}
                stroke={background}
              />
            </g>
            <g>
              <path
                className="bot-chat-avatar__body"
                d={BOT_AVATAR_SHAPE_PATHS[shape]}
                fill={background}
              />
              <path
                className="bot-chat-avatar__sheen"
                d="M8.5 12.5c4.8-7.1 15.9-8.5 23.1-2.4"
                fill="none"
                opacity="0.16"
                stroke="white"
                strokeLinecap="round"
                strokeWidth="1.5"
              />
              <g
                className="bot-chat-avatar__eyes"
                fill={foreground}
                ref={eyesRef}
              >
                <rect fill={foreground} ref={leftEyeRef} />
                <rect fill={foreground} ref={rightEyeRef} />
              </g>
            </g>
            <g className="bot-chat-avatar__effect" data-layer="front">
              <circle
                className="bot-chat-avatar__effect-progress"
                cx="20"
                cy="20"
                fill="none"
                opacity={preset.effect === "progress" ? 1 : 0}
                r="22"
                stroke={background}
              />
              <path
                className="bot-chat-avatar__effect-arrow is-out"
                d="m31 5 6 4.5-6 4.5M27 9.5h10"
                fill="none"
                opacity={preset.effect === "send" ? 1 : 0}
                stroke={background}
              />
              <path
                className="bot-chat-avatar__effect-arrow is-in"
                d="m9 5-6 4.5L9 14M3 9.5h10"
                fill="none"
                opacity={
                  preset.effect === "receive" || preset.effect === "dock"
                    ? 1
                    : 0
                }
                stroke={background}
              />
              <path
                className="bot-chat-avatar__effect-pencil"
                d="m30 13 6.5-6.5 2 2-6.5 6.5-3 .9Z"
                fill="none"
                opacity={preset.effect === "pencil" ? 1 : 0}
                stroke={background}
              />
              <path
                className="bot-chat-avatar__effect-bang"
                d="M35 2v5m0 3v.4"
                fill="none"
                opacity={preset.effect === "bang" ? 1 : 0}
                stroke={background}
              />
              <path
                className="bot-chat-avatar__effect-standby"
                d="M20-1v7m-7.5-4A20 20 0 1 0 27.5 2"
                fill="none"
                opacity={preset.effect === "standby" ? 1 : 0}
                stroke={background}
              />
              <circle
                className="bot-chat-avatar__effect-ball"
                cx="38"
                cy="5"
                fill={background}
                opacity={preset.effect === "ball" ? 1 : 0}
                r="3"
                stroke="none"
              />
            </g>
            <g
              className="bot-chat-avatar__action-particles"
              fill={background}
              opacity={
                BOT_AVATAR_EMPHASIS_STATES.has(motionState) ? 1 : 0
              }
              ref={actionParticlesRef}
              stroke="none"
            >
              <circle cx="2" cy="7" r="1.3" />
              <circle cx="38" cy="3" r="1" />
              <circle cx="43" cy="25" r="1.45" />
              <circle cx="1" cy="36" r="0.9" />
              <path d="m39 34 1.2 2.8 2.8 1.2-2.8 1.2L39 42l-1.2-2.8L35 38l2.8-1.2Z" />
            </g>
          </g>
        </svg>
      </span>
    );
  },
);
