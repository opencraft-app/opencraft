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
  type BotAvatarAction,
  type BotAvatarMarkClaim,
  type BotAvatarPointerSnapshot,
  type BotAvatarPointerSource,
  type BotAvatarStageProjection,
  useBotAvatarProjection as useProjection,
} from "./bot-avatar-stage-context";

interface MarkSource {
  readonly participant: BotAvatarMarkClaim["participant"];
  readonly followPointer: boolean;
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

  useLayoutEffect(
    () =>
      registerClaim({
        claimId: generatedId,
        participant,
        active,
        followPointer,
      }),
    [active, followPointer, generatedId, participant, registerClaim],
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
    >
      {active ? <BotAvatarMirror participant={participant} size={size} /> : null}
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
  const projections = useMemo(() => {
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
  const commitSources = useCallback(() => {
    const next = new Map<string, MarkSource>();
    for (const claim of claimsRef.current.values()) {
      if (!claim.active) continue;
      const participantId = claim.participant.participantId;
      const current = next.get(participantId);
      next.set(participantId, {
        participant: claim.participant,
        followPointer: claim.followPointer || current?.followPointer === true,
      });
    }
    setSources((current) => {
      if (current.size !== next.size) return next;
      for (const [participantId, source] of next) {
        const previous = current.get(participantId);
        if (
          previous === undefined ||
          previous.followPointer !== source.followPointer ||
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
    () => ({ pointer, projections, registerClaim, perform }),
    [perform, pointer, projections, registerClaim],
  );

  useEffect(() => {
    const move = (event: PointerEvent) => {
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

  return (
    <BotAvatarStageContext.Provider value={context}>
      {children}
      <div aria-hidden="true" className="bot-chat-mark-sources">
        {[...sources].map(([participantId, source]) => (
          <span className="bot-chat-mark-source" key={participantId}>
            <BotAvatar
              followPointer={source.followPointer}
              participant={source.participant}
              presentation="live"
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
