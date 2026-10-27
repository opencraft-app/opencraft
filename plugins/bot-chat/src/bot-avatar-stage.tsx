import { usePresentationActive } from "@opencraft/react-runtime";
import {
  latestBotPresenceFacts,
  type BotPresenceFact,
} from "@opencraft/bot-conversation";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  BOT_AVATAR_EMPHASIS_STATES,
  BOT_AVATAR_MOTION,
  botAvatarMotionState,
  type BotAvatarMotionState,
} from "./bot-avatar-motion";
import { BotAvatar, type BotAvatarHandle } from "./bot-avatar";
import {
  BotAvatarStageContext,
  IDLE_PROJECTION,
  type BotAvatarAction,
  type BotAvatarBounds,
  type BotAvatarMarkClaim,
  type BotAvatarPointerSnapshot,
  type BotAvatarPointerSource,
  type BotAvatarStageProjection,
  useBotAvatarProjection as useProjection,
} from "./bot-avatar-stage-context";
import {
  BotAvatarScheduler,
  botAvatarActivityLevel,
} from "./bot-avatar-runtime";

interface MarkSource {
  readonly participant: BotAvatarMarkClaim["participant"];
  readonly followPointer: boolean;
  readonly pointerVisible: boolean;
  readonly visible: boolean;
  readonly bounds: BotAvatarMarkClaim["bounds"];
  readonly element: BotAvatarMarkClaim["element"];
}

function sourceIdFor(participantId: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < participantId.length; index += 1) {
    hash ^= participantId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `opencraft-bot-avatar-source-${(hash >>> 0).toString(16)}`;
}

function BotAvatarMirror({
  participant,
  size,
}: {
  readonly participant: BotAvatarMarkClaim["participant"];
  readonly size: "compact" | "normal" | "large";
}) {
  if (participant.avatar?.kind === "image-url") {
    return (
      <BotAvatar
        participant={participant}
        presentation="static"
        size={size === "large" ? "large" : "normal"}
      />
    );
  }

  const avatar = participant.avatar;
  const projection = useProjection(participant.participantId);
  const preset = BOT_AVATAR_MOTION[projection.motionState];
  const background = avatar?.background ?? "#17191c";
  return (
    <span
      className="bot-chat-avatar bot-chat-avatar--mirror"
      data-effect={preset.effect}
      data-emphasis={
        BOT_AVATAR_EMPHASIS_STATES.has(projection.motionState) || undefined
      }
      data-motion={projection.motionState}
      data-phase={projection.phase}
      data-presentation="live"
      data-size={size}
      style={
        {
          "--bot-avatar-background": background,
          "--bot-avatar-highlight": `color-mix(in srgb, ${background} 76%, white)`,
          "--bot-avatar-foreground": avatar?.foreground ?? "#ffffff",
          color: background,
        } as CSSProperties
      }
    >
      <svg aria-hidden="true" viewBox="-6 -6 52 52">
        <use
          color={background}
          fill={background}
          href={`#${sourceIdFor(participant.participantId)}`}
        />
      </svg>
    </span>
  );
}

/**
 * A mark owns local geometry only. The animated SVG source lives once in the
 * Stage and every visible mark mirrors it in normal document flow. Resizing a
 * sidebar can therefore reflow a whole message cluster atomically without a
 * second measurement/translation transaction.
 */
export function BotAvatarMark({
  active = true,
  className,
  followPointer = false,
  participant,
  size = "normal",
}: {
  readonly active?: boolean;
  readonly className?: string;
  readonly followPointer?: boolean;
  readonly participant: BotAvatarMarkClaim["participant"];
  readonly size?: "compact" | "normal" | "large";
}) {
  const generatedId = useId();
  const { registerClaim } = useContext(BotAvatarStageContext);
  const element = useRef<HTMLSpanElement>(null);
  const bounds = useRef<BotAvatarBounds | null>(null);
  const [visible, setVisible] = useState(true);

  useLayoutEffect(() => {
    const node = element.current;
    if (node === null) return;
    const updatePosition = (width: number, height: number) => {
      const rect = node.getBoundingClientRect();
      bounds.current = { left: rect.left, top: rect.top, width, height };
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(([entry]) => {
            if (entry === undefined) return;
            updatePosition(entry.contentRect.width, entry.contentRect.height);
          });
    if (resizeObserver === null) {
      const initial = node.getBoundingClientRect();
      bounds.current = {
        left: initial.left,
        top: initial.top,
        width: initial.width,
        height: initial.height,
      };
    }
    resizeObserver?.observe(node);
    const intersectionObserver =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            if (entry === undefined) return;
            setVisible(entry.isIntersecting);
            bounds.current = {
              left: entry.boundingClientRect.left,
              top: entry.boundingClientRect.top,
              width: entry.boundingClientRect.width,
              height: entry.boundingClientRect.height,
            };
          });
    intersectionObserver?.observe(node);
    return () => {
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
    };
  }, []);

  useLayoutEffect(
    () =>
      registerClaim({
        claimId: generatedId,
        participant,
        active,
        followPointer,
        visible,
        bounds,
        element,
      }),
    [active, followPointer, generatedId, participant, registerClaim, visible],
  );

  return (
    <span
      aria-hidden="true"
      className={
        className === undefined
          ? "bot-chat-mark-anchor"
          : `bot-chat-mark-anchor ${className}`
      }
      data-active={active || undefined}
      data-size={size}
      ref={element}
    >
      {active ? (
        <BotAvatarMirror participant={participant} size={size} />
      ) : null}
    </span>
  );
}

/**
 * The conversation surface is the sole owner of live avatar projection.
 * Individual avatar leaves only render that projection; they never inspect the
 * Presence array or choose a competing current fact.
 */
export function BotAvatarStage({
  children,
  motionOverrides,
  presence,
}: {
  readonly children: ReactNode;
  readonly motionOverrides?: ReadonlyMap<string, BotAvatarMotionState>;
  readonly presence: readonly BotPresenceFact[];
}) {
  const presentationActive = usePresentationActive();
  const claimsRef = useRef(new Map<string, BotAvatarMarkClaim>());
  const actionHandlesRef = useRef(new Map<string, BotAvatarHandle>());
  const [sources, setSources] = useState<ReadonlyMap<string, MarkSource>>(
    new Map(),
  );
  const pointerSnapshot = useRef<BotAvatarPointerSnapshot>({
    x: 0,
    y: 0,
    active: false,
  });
  const pointerListeners = useRef(new Set<() => void>());
  const scheduler = useMemo(() => new BotAvatarScheduler(), []);
  const sourcesRef = useRef(sources);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const pointer = useMemo<BotAvatarPointerSource>(
    () => ({
      snapshot: pointerSnapshot,
      subscribe(listener) {
        pointerListeners.current.add(listener);
        return () => pointerListeners.current.delete(listener);
      },
    }),
    [],
  );
  const targetedParticipants = useMemo(() => {
    const next = new Set<string>();
    for (const fact of latestBotPresenceFacts(presence)) {
      const targetParticipantId = fact.activity?.targetParticipantId;
      if (targetParticipantId) next.add(targetParticipantId);
    }
    return next;
  }, [presence]);
  const baseProjections = useMemo(() => {
    const next = new Map<string, BotAvatarStageProjection>();
    for (const fact of latestBotPresenceFacts(presence)) {
      next.set(
        fact.participantId,
        Object.freeze({
          fact,
          phase: fact.phase,
          motionState:
            motionOverrides?.get(fact.participantId) ??
            botAvatarMotionState(fact.phase, fact),
        }),
      );
    }
    for (const [participantId, motionState] of motionOverrides ?? []) {
      if (next.has(participantId)) continue;
      next.set(
        participantId,
        Object.freeze({ fact: null, phase: "idle", motionState }),
      );
    }
    return next;
  }, [motionOverrides, presence]);
  const projections = useMemo(() => {
    const next = new Map(baseProjections);
    for (const participantId of sources.keys()) {
      if (!targetedParticipants.has(participantId)) continue;
      const current = next.get(participantId) ?? IDLE_PROJECTION;
      if (current.phase !== "idle" || motionOverrides?.has(participantId))
        continue;
      next.set(
        participantId,
        Object.freeze({ ...current, motionState: "listening" }),
      );
    }
    return next;
  }, [baseProjections, motionOverrides, sources, targetedParticipants]);
  const commitSources = useCallback(() => {
    const next = new Map<string, MarkSource>();
    for (const claim of claimsRef.current.values()) {
      if (!claim.active) continue;
      const participantId = claim.participant.participantId;
      const current = next.get(participantId);
      const currentPointerUsable =
        current?.followPointer === true && current.pointerVisible;
      const useClaimPointer =
        claim.followPointer && claim.visible && !currentPointerUsable;
      next.set(participantId, {
        participant: claim.participant,
        followPointer: claim.followPointer || current?.followPointer === true,
        pointerVisible:
          (claim.followPointer && claim.visible) ||
          current?.pointerVisible === true,
        visible: claim.visible || current?.visible === true,
        bounds: useClaimPointer
          ? claim.bounds
          : (current?.bounds ?? claim.bounds),
        element: useClaimPointer
          ? claim.element
          : (current?.element ?? claim.element),
      });
    }
    setSources((current) => {
      if (current.size !== next.size) return next;
      for (const [participantId, source] of next) {
        const previous = current.get(participantId);
        if (
          previous === undefined ||
          previous.followPointer !== source.followPointer ||
          previous.pointerVisible !== source.pointerVisible ||
          previous.visible !== source.visible ||
          previous.bounds !== source.bounds ||
          previous.element !== source.element ||
          previous.participant !== source.participant
        )
          return next;
      }
      return current;
    });
  }, []);
  const registerClaim = useCallback(
    (claim: BotAvatarMarkClaim) => {
      claimsRef.current.set(claim.claimId, claim);
      commitSources();
      return () => {
        if (claimsRef.current.get(claim.claimId) === claim) {
          claimsRef.current.delete(claim.claimId);
          commitSources();
        }
      };
    },
    [commitSources],
  );
  const perform = useCallback(
    (participantId: string, action: BotAvatarAction) => {
      actionHandlesRef.current.get(participantId)?.[action]();
    },
    [],
  );
  const context = useMemo(
    () => ({ pointer, projections, registerClaim, perform, scheduler }),
    [perform, pointer, projections, registerClaim, scheduler],
  );

  sourcesRef.current = sources;

  useEffect(() => {
    const move = (event: PointerEvent) => {
      for (const source of sourcesRef.current.values()) {
        if (!source.followPointer || !source.visible) continue;
        const element = source.element.current;
        const previous = source.bounds.current;
        if (element === null || previous === null) continue;
        const rect = element.getBoundingClientRect();
        source.bounds.current = {
          left: rect.left,
          top: rect.top,
          width: previous.width,
          height: previous.height,
        };
      }
      pointerSnapshot.current = {
        x: event.clientX,
        y: event.clientY,
        active: true,
      };
      for (const listener of pointerListeners.current) listener();
    };
    const leave = () => {
      pointerSnapshot.current = { ...pointerSnapshot.current, active: false };
      for (const listener of pointerListeners.current) listener();
    };
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
      window.removeEventListener("blur", leave);
    };
  }, []);

  useEffect(() => () => scheduler.dispose(), [scheduler]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateVisibility = () => setPageVisible(!document.hidden);
    const updateMotion = () => setReducedMotion(media.matches);
    document.addEventListener("visibilitychange", updateVisibility);
    media.addEventListener("change", updateMotion);
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      media.removeEventListener("change", updateMotion);
    };
  }, []);

  return (
    <BotAvatarStageContext.Provider value={context}>
      {children}
      <div aria-hidden="true" className="bot-chat-mark-sources">
        {[...sources].map(([participantId, source]) => (
          <span className="bot-chat-mark-source" key={participantId}>
            <BotAvatar
              activityLevel={botAvatarActivityLevel({
                visible: presentationActive && pageVisible && source.visible,
                working:
                  (projections.get(participantId) ?? IDLE_PROJECTION).phase !==
                  "idle",
                targeted: targetedParticipants.has(participantId),
              })}
              followPointer={source.followPointer}
              participant={source.participant}
              pointerBounds={source.bounds}
              presentation="live"
              reducedMotion={reducedMotion}
              ref={(handle) => {
                if (handle === null)
                  actionHandlesRef.current.delete(participantId);
                else actionHandlesRef.current.set(participantId, handle);
              }}
              size="large"
              sourceId={sourceIdFor(participantId)}
            />
          </span>
        ))}
      </div>
    </BotAvatarStageContext.Provider>
  );
}

export {
  useBotAvatarActions,
  useBotAvatarPointer,
  useBotAvatarProjection,
} from "./bot-avatar-stage-context";
