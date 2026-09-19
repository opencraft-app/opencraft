import type {
  BotParticipantSnapshot,
  BotPresenceFact,
  BotPresencePhase,
} from "@opencraft/bot-conversation";
import {
  createContext,
  useCallback,
  useContext,
  type MutableRefObject,
} from "react";

import type { BotAvatarMotionState } from "./bot-avatar-motion";
import type {
  BotAvatarFrameSubscription,
  BotAvatarScheduler,
} from "./bot-avatar-runtime";

export interface BotAvatarStageProjection {
  readonly fact: BotPresenceFact | null;
  readonly phase: BotPresencePhase;
  readonly motionState: BotAvatarMotionState;
}

export const IDLE_PROJECTION: BotAvatarStageProjection = Object.freeze({
  fact: null,
  phase: "idle",
  motionState: "idle",
});

export interface BotAvatarPointerSnapshot {
  x: number;
  y: number;
  active: boolean;
}

export interface BotAvatarBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BotAvatarPointerSource {
  readonly snapshot: MutableRefObject<BotAvatarPointerSnapshot>;
  subscribe(listener: () => void): () => void;
}

export type BotAvatarAction = "spin" | "bounce" | "burst";

export interface BotAvatarMarkClaim {
  readonly claimId: string;
  readonly participant: BotParticipantSnapshot;
  readonly active: boolean;
  readonly followPointer: boolean;
  readonly visible: boolean;
  readonly bounds: MutableRefObject<BotAvatarBounds | null>;
  readonly element: MutableRefObject<HTMLElement | null>;
}

export interface BotAvatarStageValue {
  readonly projections: ReadonlyMap<string, BotAvatarStageProjection>;
  readonly pointer: BotAvatarPointerSource;
  readonly scheduler: Pick<BotAvatarScheduler, "subscribe">;
  registerClaim(claim: BotAvatarMarkClaim): () => void;
  perform(participantId: string, action: BotAvatarAction): void;
}

const INACTIVE_SCHEDULER: Pick<BotAvatarScheduler, "subscribe"> = {
  subscribe(): BotAvatarFrameSubscription {
    return {
      setRateHz: () => undefined,
      wake: () => undefined,
      dispose: () => undefined,
    };
  },
};

export const INACTIVE_POINTER: BotAvatarPointerSource = {
  snapshot: { current: { x: 0, y: 0, active: false } },
  subscribe: () => () => undefined,
};

export const BotAvatarStageContext = createContext<BotAvatarStageValue>({
  projections: new Map(),
  pointer: INACTIVE_POINTER,
  scheduler: INACTIVE_SCHEDULER,
  registerClaim: () => () => undefined,
  perform: () => undefined,
});

export function useBotAvatarProjection(
  participantId: string,
): BotAvatarStageProjection {
  return (
    useContext(BotAvatarStageContext).projections.get(participantId) ??
    IDLE_PROJECTION
  );
}

export function useBotAvatarPointer(): BotAvatarPointerSource {
  return useContext(BotAvatarStageContext).pointer;
}

export function useBotAvatarScheduler(): Pick<BotAvatarScheduler, "subscribe"> {
  return useContext(BotAvatarStageContext).scheduler;
}

export function useBotAvatarActions(participantId: string) {
  const { perform } = useContext(BotAvatarStageContext);
  return useCallback(
    (action: BotAvatarAction) => perform(participantId, action),
    [participantId, perform],
  );
}
