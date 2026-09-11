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
}

export interface BotAvatarStageValue {
  readonly projections: ReadonlyMap<string, BotAvatarStageProjection>;
  readonly pointer: BotAvatarPointerSource;
  registerClaim(claim: BotAvatarMarkClaim): () => void;
  perform(participantId: string, action: BotAvatarAction): void;
}

export const INACTIVE_POINTER: BotAvatarPointerSource = {
  snapshot: { current: { x: 0, y: 0, active: false } },
  subscribe: () => () => undefined,
};

export const BotAvatarStageContext = createContext<BotAvatarStageValue>({
  projections: new Map(),
  pointer: INACTIVE_POINTER,
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

export function useBotAvatarActions(participantId: string) {
  const { perform } = useContext(BotAvatarStageContext);
  return useCallback(
    (action: BotAvatarAction) => perform(participantId, action),
    [participantId, perform],
  );
}
