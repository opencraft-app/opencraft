import type { BotParticipantSnapshot } from "@opencraft/bot-conversation";
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type MutableRefObject,
} from "react";

import { BotAvatarBehaviorController } from "./bot-avatar-behavior";
import { BotAvatarClock } from "./bot-avatar-clock";
import {
  botAvatarRingPath,
  botAvatarShapeRing,
  fitBotAvatarEyeCenter,
  interpolateBotAvatarRings,
  type BotAvatarRing,
} from "./bot-avatar-geometry";
import { createBotAvatarMaterial } from "./bot-avatar-material";
import {
  BOT_AVATAR_EMPHASIS_STATES,
  BOT_AVATAR_MOTION,
  deterministicAvatarUnit,
} from "./bot-avatar-motion";
import {
  BotAvatarEffectController,
  type BotAvatarEffectFrame,
} from "./bot-avatar-morph";
import {
  botAvatarRateHz,
  type BotAvatarActivityLevel,
  type BotAvatarFrameSubscription,
} from "./bot-avatar-runtime";
import {
  BOT_AVATAR_SHAPE_NAMES,
  type BotAvatarShapeName,
} from "./bot-avatar-shapes";
import {
  useBotAvatarPointer,
  useBotAvatarProjection,
  useBotAvatarScheduler,
  type BotAvatarBounds,
} from "./bot-avatar-stage-context";
import {
  createBotAvatarMotionModel,
  snapBotAvatarMotionModel,
  stepBotAvatarSprings,
  type BotAvatarMotionModel,
} from "./bot-avatar-springs";

export interface BotAvatarHandle {
  spin(): void;
  bounce(): void;
  burst(): void;
}

interface ActionTimeline {
  spinStartedAt: number;
  bounceStartedAt: number;
  burstStartedAt: number;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function setEyeGeometry(
  element: SVGRectElement,
  ring: BotAvatarRing,
  desiredCenterX: number,
  centerY: number,
  widthScale: number,
  heightScale: number,
  rotation: number,
): void {
  const width = 4.3 * widthScale;
  const height = 6.9 * heightScale;
  const top = Math.min(...ring.map((point) => point[1]));
  const bottom = Math.max(...ring.map((point) => point[1]));
  const fittedCenterY = Math.min(
    bottom - height / 2 - 1.1,
    Math.max(top + height / 2 + 1.1, centerY),
  );
  const centerX = fitBotAvatarEyeCenter(
    ring,
    desiredCenterX,
    fittedCenterY,
    width,
    1.1,
    height,
  );
  element.setAttribute("x", String(centerX - width / 2));
  element.setAttribute("y", String(fittedCenterY - height / 2));
  element.setAttribute("width", String(width));
  element.setAttribute("height", String(height));
  element.setAttribute("rx", String(Math.min(width / 2, 2.15)));
  element.setAttribute(
    "transform",
    `rotate(${rotation} ${centerX} ${fittedCenterY})`,
  );
}

function renderEffect(root: HTMLElement, frame: BotAvatarEffectFrame): void {
  root.dataset.effect = frame.effect;
  root.dataset.morphPhase = frame.phase;
  const nodes = root.querySelectorAll<SVGGraphicsElement>(
    "[data-avatar-effect]",
  );
  for (const node of nodes) {
    node.style.opacity = "0";
    node.removeAttribute("transform");
  }
  if (frame.effect === "none" || frame.progress <= 0) return;
  const active = root.querySelector<SVGGraphicsElement>(
    `[data-avatar-effect="${frame.effect}"]`,
  );
  if (active === null) return;
  const progress = clampUnit(frame.progress);
  active.style.opacity = String(progress);
  switch (frame.effect) {
    case "dots":
      active.setAttribute("transform", `translate(0 ${(1 - progress) * 3})`);
      break;
    case "orbit":
    case "radar":
    case "whirl":
      active.setAttribute("transform", `rotate(${progress * 180} 20 20)`);
      break;
    case "progress":
      active.style.strokeDashoffset = String((1 - progress) * 34);
      break;
    case "gather":
    case "bang":
    case "standby":
      active.setAttribute(
        "transform",
        `translate(20 20) scale(${0.76 + progress * 0.24}) translate(-20 -20)`,
      );
      break;
    case "send":
      active.setAttribute("transform", `translate(${(1 - progress) * -5} 0)`);
      break;
    case "receive":
    case "dock":
      active.setAttribute("transform", `translate(${(1 - progress) * 5} 0)`);
      break;
    case "wave":
    case "ball":
    case "pencil":
      active.setAttribute("transform", `translate(0 ${(1 - progress) * -3})`);
      break;
  }
}

function renderActor(
  body: SVGGElement,
  eyesGroup: SVGGElement,
  leftEye: SVGRectElement,
  rightEye: SVGRectElement,
  actionParticles: SVGGElement,
  model: BotAvatarMotionModel,
  ring: BotAvatarRing,
  time: number,
  actions: ActionTimeline,
): void {
  const spinProgress = clampUnit((time - actions.spinStartedAt) / 760);
  const spin = spinProgress < 1 ? (1 - (1 - spinProgress) ** 3) * 360 : 0;
  const bounceProgress = clampUnit((time - actions.bounceStartedAt) / 620);
  const bounce =
    bounceProgress < 1
      ? Math.sin(bounceProgress * Math.PI) * 5.5 * (1 - bounceProgress * 0.28)
      : 0;
  const burstProgress = clampUnit((time - actions.burstStartedAt) / 620);
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
    ring,
    leftCenterX,
    19 + model.leftEyeY.value,
    model.leftEyeWidth.value,
    model.leftEyeHeight.value,
    model.leftEyeRotation.value,
  );
  setEyeGeometry(
    rightEye,
    ring,
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
    actionParticles.style.opacity = "0";
    actionParticles.removeAttribute("transform");
  }
}

export interface BotAvatarProps {
  readonly participant: BotParticipantSnapshot;
  readonly activityLevel?: BotAvatarActivityLevel;
  readonly followPointer?: boolean;
  readonly pointerBounds?: MutableRefObject<BotAvatarBounds | null>;
  readonly presentation?: "live" | "static";
  readonly reducedMotion?: boolean;
  readonly shape?: BotAvatarShapeName;
  readonly size?: "normal" | "large";
  readonly sourceId?: string;
}

export const BotAvatar = forwardRef<BotAvatarHandle, BotAvatarProps>(
  function BotAvatar(
    {
      activityLevel = "active",
      participant,
      followPointer = false,
      pointerBounds,
      presentation = "static",
      reducedMotion = false,
      shape: shapeOverride,
      size = "normal",
      sourceId,
    },
    forwardedRef,
  ) {
    const projection = useBotAvatarProjection(participant.participantId);
    const pointer = useBotAvatarPointer();
    const scheduler = useBotAvatarScheduler();
    const motionState =
      presentation === "live" ? projection.motionState : "idle";
    const phase = presentation === "live" ? projection.phase : "idle";
    const preset = BOT_AVATAR_MOTION[motionState];
    const shapeIndex = Math.floor(
      deterministicAvatarUnit(participant.participantId) *
        BOT_AVATAR_SHAPE_NAMES.length,
    );
    const shape = shapeOverride ?? BOT_AVATAR_SHAPE_NAMES[shapeIndex] ?? "blob";
    const generatedMaterialId = useId().replaceAll(":", "");
    const materialId = `bot-avatar-material-${generatedMaterialId}`;
    const shineId = `${materialId}-shine`;
    const stateRef = useRef(motionState);
    const shapeRef = useRef(shape);
    const activityLevelRef = useRef(activityLevel);
    const reducedMotionRef = useRef(reducedMotion);
    const runtimeConfigRef = useRef<
      ((level: BotAvatarActivityLevel, reduced: boolean) => void) | null
    >(null);
    const rootRef = useRef<HTMLSpanElement>(null);
    const bodyRef = useRef<SVGGElement>(null);
    const bodyPathRef = useRef<SVGPathElement>(null);
    const sheenPathRef = useRef<SVGPathElement>(null);
    const rimPathRef = useRef<SVGPathElement>(null);
    const eyesRef = useRef<SVGGElement>(null);
    const leftEyeRef = useRef<SVGRectElement>(null);
    const rightEyeRef = useRef<SVGRectElement>(null);
    const actionParticlesRef = useRef<SVGGElement>(null);
    const wakeRef = useRef<() => void>(() => undefined);
    const subscriptionRef = useRef<BotAvatarFrameSubscription | null>(null);
    const clockNowRef = useRef<() => number>(() => performance.now());
    const actionRef = useRef<ActionTimeline>({
      spinStartedAt: Number.NEGATIVE_INFINITY,
      bounceStartedAt: Number.NEGATIVE_INFINITY,
      burstStartedAt: Number.NEGATIVE_INFINITY,
    });

    stateRef.current = motionState;
    shapeRef.current = shape;
    activityLevelRef.current = activityLevel;
    reducedMotionRef.current = reducedMotion;

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
      const root = rootRef.current;
      const body = bodyRef.current;
      const bodyPath = bodyPathRef.current;
      const sheenPath = sheenPathRef.current;
      const rimPath = rimPathRef.current;
      const eyesGroup = eyesRef.current;
      const leftEye = leftEyeRef.current;
      const rightEye = rightEyeRef.current;
      const actionParticles = actionParticlesRef.current;
      if (
        presentation === "static" ||
        root === null ||
        body === null ||
        bodyPath === null ||
        sheenPath === null ||
        rimPath === null ||
        eyesGroup === null ||
        leftEye === null ||
        rightEye === null ||
        actionParticles === null
      )
        return;

      const rawStart = performance.now();
      const clock = new BotAvatarClock(rawStart);
      const model = createBotAvatarMotionModel();
      const behavior = new BotAvatarBehaviorController(
        participant.participantId,
        stateRef.current,
        0,
        model,
      );
      const effects = new BotAvatarEffectController();
      let previousState = stateRef.current;
      let currentShape = shapeRef.current;
      let shapeFrom = botAvatarShapeRing(currentShape);
      let shapeTo = shapeFrom;
      let renderedRing = shapeFrom;
      let renderedPath = "";
      let effectSignature = "";
      let currentRate = botAvatarRateHz(
        activityLevelRef.current,
        reducedMotionRef.current,
      );
      if (currentRate === 0) clock.park(rawStart);

      effects.transitionTo(BOT_AVATAR_MOTION[previousState].effect, 0);
      clockNowRef.current = () => clock.snapshot();

      const configure = (level: BotAvatarActivityLevel, reduced: boolean) => {
        const nextRate = botAvatarRateHz(level, reduced);
        if (nextRate === 0) clock.park();
        else clock.unpark();
        currentRate = nextRate;
        subscriptionRef.current?.setRateHz(nextRate);
        if (reduced || nextRate > 0) subscriptionRef.current?.wake();
      };
      runtimeConfigRef.current = configure;

      const tick = (rawTime: number) => {
        const frame = clock.advance(rawTime);
        const state = stateRef.current;
        if (state !== previousState) {
          const transition = behavior.setState(state, frame.now, model);
          previousState = state;
          effects.transitionTo(BOT_AVATAR_MOTION[state].effect, frame.now);
          if (transition.emphasis && !reducedMotionRef.current)
            actionRef.current.burstStartedAt = frame.now;
        }
        const currentPreset = behavior.update(frame.now, model);
        const visualState = behavior.snapshotState();
        root.dataset.visualMotion = visualState;
        if (BOT_AVATAR_EMPHASIS_STATES.has(visualState))
          root.dataset.emphasis = "true";
        else delete root.dataset.emphasis;

        if (shapeRef.current !== currentShape) {
          shapeFrom = renderedRing;
          currentShape = shapeRef.current;
          shapeTo = botAvatarShapeRing(currentShape);
          model.shapeBlend.value = 0;
          model.shapeBlend.velocity = 0;
          model.shapeBlend.target = 1;
        }

        if (followPointer && pointer.snapshot.current.active) {
          const bounds = pointerBounds?.current;
          if (bounds !== null && bounds !== undefined && bounds.width > 0) {
            const dx =
              pointer.snapshot.current.x - (bounds.left + bounds.width / 2);
            const dy =
              pointer.snapshot.current.y - (bounds.top + bounds.height / 2);
            const distance = Math.hypot(dx, dy);
            const nearness = Math.max(0, Math.min(1, (440 - distance) / 340));
            const engagement = Math.min(1, distance / 34) * nearness;
            if (engagement > 0) {
              model.eyeX.target =
                (dx / Math.max(1, distance)) * 3.15 * engagement;
              model.eyeY.target =
                (dy / Math.max(1, distance)) * 2.35 * engagement;
              model.rotation.target +=
                (dx / Math.max(1, distance)) * 1.65 * engagement;
            }
          }
        }

        if (reducedMotionRef.current) snapBotAvatarMotionModel(model);
        else
          stepBotAvatarSprings(
            model,
            {
              stiffness: currentPreset.stiffness,
              damping: currentPreset.damping,
            },
            frame.delta,
          );

        renderedRing = interpolateBotAvatarRings(
          shapeFrom,
          shapeTo,
          model.shapeBlend.value,
        );
        const path = botAvatarRingPath(renderedRing);
        if (path !== renderedPath) {
          renderedPath = path;
          bodyPath.setAttribute("d", path);
          sheenPath.setAttribute("d", path);
          rimPath.setAttribute("d", path);
        }
        renderActor(
          body,
          eyesGroup,
          leftEye,
          rightEye,
          actionParticles,
          model,
          renderedRing,
          frame.now,
          actionRef.current,
        );
        const effectFrame = reducedMotionRef.current
          ? ({ effect: "none", phase: "done", progress: 0 } as const)
          : effects.sample(frame.now);
        const nextEffectSignature = `${effectFrame.effect}:${effectFrame.phase}:${effectFrame.progress.toFixed(4)}`;
        if (effectSignature !== nextEffectSignature) {
          effectSignature = nextEffectSignature;
          renderEffect(root, effectFrame);
        }

        const actionActive =
          frame.now - actionRef.current.spinStartedAt < 760 ||
          frame.now - actionRef.current.bounceStartedAt < 620 ||
          frame.now - actionRef.current.burstStartedAt < 620;
        const transitionActive =
          effectFrame.phase === "reset" ||
          effectFrame.phase === "enter" ||
          effectFrame.phase === "exit" ||
          model.shapeBlend.value < 0.995;
        const requestedRate =
          activityLevelRef.current !== "hidden" &&
          !reducedMotionRef.current &&
          (actionActive || transitionActive)
            ? 60
            : currentRate;
        subscriptionRef.current?.setRateHz(requestedRate);
      };

      const subscription = scheduler.subscribe(tick, currentRate);
      subscriptionRef.current = subscription;
      wakeRef.current = subscription.wake;
      const unsubscribePointer = followPointer
        ? pointer.subscribe(subscription.wake)
        : () => undefined;
      subscription.wake();

      return () => {
        runtimeConfigRef.current = null;
        wakeRef.current = () => undefined;
        clockNowRef.current = () => performance.now();
        subscriptionRef.current = null;
        unsubscribePointer();
        subscription.dispose();
      };
    }, [
      followPointer,
      participant.participantId,
      pointer,
      pointerBounds,
      presentation,
      scheduler,
    ]);

    useEffect(() => {
      runtimeConfigRef.current?.(activityLevel, reducedMotion);
    }, [activityLevel, reducedMotion]);

    useEffect(() => {
      wakeRef.current();
    }, [motionState, shape]);

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
    const material = createBotAvatarMaterial(background);
    const staticPath = botAvatarRingPath(botAvatarShapeRing(shape));
    return (
      <span
        aria-label={participant.displayName}
        className="bot-chat-avatar bot-chat-avatar--persona"
        data-activity-level={activityLevel}
        data-effect={preset.effect}
        data-emphasis={BOT_AVATAR_EMPHASIS_STATES.has(motionState) || undefined}
        data-motion={motionState}
        data-morph-phase="reset"
        data-phase={phase}
        data-presentation={presentation}
        data-participant-id={participant.participantId}
        data-reduced-motion={reducedMotion || undefined}
        data-size={size}
        ref={rootRef}
        role="img"
        style={
          {
            "--bot-avatar-background": background,
            "--bot-avatar-highlight": material.highlight,
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
          <defs>
            <linearGradient id={materialId} x1="0" x2="1" y1="0" y2="1">
              <stop offset="0" stopColor={material.highlight} />
              <stop offset="0.46" stopColor={material.base} />
              <stop offset="1" stopColor={material.shadow} />
            </linearGradient>
            <linearGradient id={shineId} x1="0" x2="0.85" y1="0" y2="1">
              <stop offset="0" stopColor="white" stopOpacity="0.18" />
              <stop offset="0.42" stopColor="white" stopOpacity="0.04" />
              <stop offset="1" stopColor="white" stopOpacity="0" />
            </linearGradient>
          </defs>
          <g id={sourceId} ref={bodyRef}>
            <g className="bot-chat-avatar__effect" data-layer="back">
              <circle
                className="bot-chat-avatar__effect-ring"
                cx="20"
                cy="20"
                data-avatar-effect="gather"
                fill="none"
                r="21"
                stroke={background}
              />
              <ellipse
                className="bot-chat-avatar__effect-belt"
                cx="20"
                cy="20"
                data-avatar-effect="orbit"
                fill="none"
                rx="24"
                ry="9"
                stroke={background}
              />
              <path
                className="bot-chat-avatar__effect-radar"
                d="M20 20 38 10A21 21 0 0 1 40 30Z"
                data-avatar-effect="radar"
                fill="none"
                stroke={background}
              />
              <g
                className="bot-chat-avatar__effect-dots"
                data-avatar-effect="dots"
                fill={background}
                stroke="none"
              >
                <circle cx="7" cy="5" r="1.7" />
                <circle cx="1.5" cy="13" r="1.2" />
                <circle cx="-1" cy="22" r="0.8" />
              </g>
              <path
                className="bot-chat-avatar__effect-wave"
                d="M-1 16c4-5 7 5 11 0s7 5 11 0 7 5 11 0 7 5 11 0"
                data-avatar-effect="wave"
                fill="none"
                stroke={background}
              />
            </g>
            <g>
              <path
                className="bot-chat-avatar__body"
                d={staticPath}
                fill={`url(#${materialId})`}
                ref={bodyPathRef}
              />
              <path
                className="bot-chat-avatar__sheen"
                d={staticPath}
                fill={`url(#${shineId})`}
                ref={sheenPathRef}
              />
              <path
                className="bot-chat-avatar__rim"
                d={staticPath}
                fill="none"
                ref={rimPathRef}
                stroke={material.highlight}
                strokeOpacity="0.42"
                strokeWidth="0.7"
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
                data-avatar-effect="progress"
                fill="none"
                r="22"
                stroke={background}
                strokeDasharray="34 105"
              />
              <path
                className="bot-chat-avatar__effect-arrow is-out"
                d="m31 5 6 4.5-6 4.5M27 9.5h10"
                data-avatar-effect="send"
                fill="none"
                stroke={background}
              />
              <path
                className="bot-chat-avatar__effect-arrow is-in"
                d="m9 5-6 4.5L9 14M3 9.5h10"
                data-avatar-effect="receive"
                fill="none"
                stroke={background}
              />
              <path
                className="bot-chat-avatar__effect-arrow is-in"
                d="m9 5-6 4.5L9 14M3 9.5h10"
                data-avatar-effect="dock"
                fill="none"
                stroke={background}
              />
              <circle
                className="bot-chat-avatar__effect-ring"
                cx="20"
                cy="20"
                data-avatar-effect="whirl"
                fill="none"
                r="21"
                stroke={background}
                strokeDasharray="7 8"
              />
              <path
                className="bot-chat-avatar__effect-pencil"
                d="m30 13 6.5-6.5 2 2-6.5 6.5-3 .9Z"
                data-avatar-effect="pencil"
                fill="none"
                stroke={background}
              />
              <path
                className="bot-chat-avatar__effect-bang"
                d="M35 2v5m0 3v.4"
                data-avatar-effect="bang"
                fill="none"
                stroke={background}
              />
              <path
                className="bot-chat-avatar__effect-standby"
                d="M20-1v7m-7.5-4A20 20 0 1 0 27.5 2"
                data-avatar-effect="standby"
                fill="none"
                stroke={background}
              />
              <circle
                className="bot-chat-avatar__effect-ball"
                cx="38"
                cy="5"
                data-avatar-effect="ball"
                fill={background}
                r="3"
                stroke="none"
              />
            </g>
            <g
              className="bot-chat-avatar__action-particles"
              fill={background}
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
