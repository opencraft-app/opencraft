import {
  latestBotPresenceFacts,
  type BotParticipantSnapshot,
  type BotPresenceFact,
} from "@opencraft/bot-conversation";
import { useCallback, useEffect, useRef, useState } from "react";

import { BotAvatarMark, useBotAvatarActions } from "./bot-avatar-stage";

const ACTIVITY_MIN_HOLD_MS = 800;
const LABEL_MIN_HOLD_MS = 1_200;
const LABEL_ROLL_MS = 300;
const ACTIVITY_EXIT_MS = 140;
const GROUP_MARK_CYCLE_MS = 2_000;
const ELAPSED_LABEL_THRESHOLD_MS = 60_000;

export interface BotActivityIndicatorEntry {
  readonly fact: BotPresenceFact;
  readonly participant: BotParticipantSnapshot;
  readonly label: string;
}

export interface BotActivityIndicatorModel {
  readonly mode: "typing" | "working";
  readonly semanticKey: string;
  readonly contentKey: string;
  readonly entries: readonly BotActivityIndicatorEntry[];
}

interface VisibleActivitySlot {
  readonly model: BotActivityIndicatorModel;
  readonly state: "visible" | "exiting";
  readonly shownAtMs: number;
}

interface RollingLabelState {
  readonly currentKey: string;
  readonly currentText: string;
  readonly currentSinceMs: number;
  readonly previousKey: string | null;
  readonly previousText: string | null;
  readonly sequence: number;
  readonly status: "idle" | "rolling";
}

function activityLabel(
  fact: BotPresenceFact,
  participant: BotParticipantSnapshot,
): string {
  return (
    fact.activity?.detail ??
    (fact.phase === "typing"
      ? "Typing…"
      : fact.phase === "waiting"
        ? "Waiting for a result"
        : fact.phase === "blocked"
          ? "Needs your attention"
          : `${participant.displayName} is working…`)
  );
}

function indicatorMode(
  facts: readonly BotPresenceFact[],
): BotActivityIndicatorModel["mode"] {
  return facts.every((fact) => fact.phase === "typing")
    ? "typing"
    : "working";
}

/**
 * Projects transport-owned Presence into one transcript-tail surface. This is
 * deliberately pure: the renderer owns animation lifetime, never Presence.
 */
export function projectBotActivityIndicator(
  facts: readonly BotPresenceFact[],
  participants: readonly BotParticipantSnapshot[],
): BotActivityIndicatorModel | null {
  const entries = latestBotPresenceFacts(facts).flatMap((fact) => {
    if (fact.phase === "idle") return [];
    const participant = participants.find(
      (candidate) => candidate.participantId === fact.participantId,
    );
    return participant === undefined
      ? []
      : [{ fact, participant, label: activityLabel(fact, participant) }];
  });
  if (entries.length === 0) return null;

  const mode = indicatorMode(entries.map((entry) => entry.fact));
  const semanticKey = entries
    .map(
      ({ fact }) =>
        `${fact.executionId}:${fact.participantId}:${fact.phase}:${fact.activity?.verb ?? "present"}`,
    )
    .join("|");
  const contentKey = entries
    .map(({ fact, label }) => `${fact.participantId}:${label}`)
    .join("|");
  return Object.freeze({
    mode,
    semanticKey,
    contentKey,
    entries: Object.freeze(entries),
  });
}

function useActivitySlot(
  desired: BotActivityIndicatorModel | null,
): VisibleActivitySlot | null {
  const initialNow = Date.now();
  const [slot, setSlot] = useState<VisibleActivitySlot | null>(() =>
    desired === null
      ? null
      : { model: desired, state: "visible", shownAtMs: initialNow },
  );
  const slotRef = useRef(slot);
  const queuedRef = useRef<BotActivityIndicatorModel | null>(null);
  const transitionTimerRef = useRef<number | null>(null);

  useEffect(() => {
    slotRef.current = slot;
  }, [slot]);

  useEffect(() => {
    const clearTransitionTimer = () => {
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
    };
    const commit = (
      model: BotActivityIndicatorModel,
      preserveShownAt: boolean,
    ) => {
      const current = slotRef.current;
      const next: VisibleActivitySlot = {
        model,
        state: "visible",
        shownAtMs:
          preserveShownAt && current !== null
            ? current.shownAtMs
            : Date.now(),
      };
      queuedRef.current = null;
      slotRef.current = next;
      setSlot(next);
    };

    clearTransitionTimer();
    const current = slotRef.current;
    if (desired === null) {
      queuedRef.current = null;
      if (current === null) return clearTransitionTimer;
      const exiting = { ...current, state: "exiting" as const };
      slotRef.current = exiting;
      setSlot(exiting);
      transitionTimerRef.current = window.setTimeout(() => {
        transitionTimerRef.current = null;
        slotRef.current = null;
        setSlot(null);
      }, ACTIVITY_EXIT_MS);
      return clearTransitionTimer;
    }

    if (current === null || current.state === "exiting") {
      commit(desired, false);
      return clearTransitionTimer;
    }
    if (current.model.semanticKey === desired.semanticKey) {
      commit(desired, true);
      return clearTransitionTimer;
    }

    const remaining = Math.max(
      0,
      current.shownAtMs + ACTIVITY_MIN_HOLD_MS - Date.now(),
    );
    if (remaining === 0) {
      commit(desired, false);
      return clearTransitionTimer;
    }
    queuedRef.current = desired;
    transitionTimerRef.current = window.setTimeout(() => {
      transitionTimerRef.current = null;
      const queued = queuedRef.current;
      if (queued !== null) commit(queued, false);
    }, remaining);
    return clearTransitionTimer;
  }, [desired?.contentKey, desired?.semanticKey]);

  useEffect(
    () => () => {
      if (transitionTimerRef.current !== null)
        window.clearTimeout(transitionTimerRef.current);
    },
    [],
  );
  return slot;
}

function useRollingLabel(text: string, textKey: string): RollingLabelState {
  const [state, setState] = useState<RollingLabelState>(() => ({
    currentKey: textKey,
    currentText: text,
    currentSinceMs: Date.now(),
    previousKey: null,
    previousText: null,
    sequence: 0,
    status: "idle",
  }));
  const stateRef = useRef(state);
  const holdTimerRef = useRef<number | null>(null);
  const rollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (
      stateRef.current.currentKey === textKey &&
      stateRef.current.currentText === text
    )
      return;
    if (holdTimerRef.current !== null)
      window.clearTimeout(holdTimerRef.current);
    const remaining = Math.max(
      0,
      stateRef.current.currentSinceMs + LABEL_MIN_HOLD_MS - Date.now(),
    );
    const commit = () => {
      const current = stateRef.current;
      const next: RollingLabelState = {
        currentKey: textKey,
        currentText: text,
        currentSinceMs: Date.now(),
        previousKey: current.currentKey,
        previousText: current.currentText,
        sequence: current.sequence + 1,
        status: "rolling",
      };
      stateRef.current = next;
      setState(next);
      if (rollTimerRef.current !== null)
        window.clearTimeout(rollTimerRef.current);
      rollTimerRef.current = window.setTimeout(() => {
        rollTimerRef.current = null;
        setState((value) => {
          if (value.sequence !== next.sequence) return value;
          const settled = {
            ...value,
            previousKey: null,
            previousText: null,
            status: "idle" as const,
          };
          stateRef.current = settled;
          return settled;
        });
      }, LABEL_ROLL_MS);
    };
    holdTimerRef.current = window.setTimeout(commit, remaining);
    return () => {
      if (holdTimerRef.current !== null) {
        window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    };
  }, [text, textKey]);

  useEffect(
    () => () => {
      if (holdTimerRef.current !== null)
        window.clearTimeout(holdTimerRef.current);
      if (rollTimerRef.current !== null)
        window.clearTimeout(rollTimerRef.current);
    },
    [],
  );
  return state;
}

function RollingActivityLabel({
  label,
  labelKey,
}: {
  readonly label: string;
  readonly labelKey: string;
}) {
  const state = useRollingLabel(label, labelKey);
  return (
    <span
      className="bot-chat-activity-label"
      data-status={state.status}
    >
      <span aria-hidden="true" className="bot-chat-activity-label__clip">
        {state.previousText === null ? null : (
          <span
            className="bot-chat-activity-label__item"
            data-slot="previous"
            key={`previous:${state.sequence}:${state.previousKey}`}
          >
            <span className="bot-chat-activity-label__shimmer">
              {state.previousText}
            </span>
          </span>
        )}
        <span
          className="bot-chat-activity-label__item"
          data-slot="current"
          key={`current:${state.sequence}:${state.currentKey}`}
        >
          <span className="bot-chat-activity-label__shimmer">
            {state.currentText}
          </span>
        </span>
      </span>
      <span className="bot-chat-activity-label__sr">{state.currentText}</span>
    </span>
  );
}

function useGroupCycle(count: number): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
    if (count < 2) return;
    const timer = window.setInterval(
      () => setIndex((value) => (value + 1) % count),
      GROUP_MARK_CYCLE_MS,
    );
    return () => window.clearInterval(timer);
  }, [count]);
  return count === 0 ? 0 : index % count;
}

function useElapsedLabel(shownAtMs: number | null): string | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (shownAtMs === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [shownAtMs]);
  if (shownAtMs === null) return null;
  const elapsed = now - shownAtMs;
  if (elapsed < ELAPSED_LABEL_THRESHOLD_MS) return null;
  return `${Math.max(1, Math.floor(elapsed / 60_000))}m`;
}

export function BotActivityIndicator({
  model,
}: {
  readonly model: BotActivityIndicatorModel | null;
}) {
  const slot = useActivitySlot(model);
  const entries = slot?.model.entries ?? [];
  const cycleIndex = useGroupCycle(entries.length);
  const active = entries[cycleIndex] ?? entries[0];
  const elapsedLabel = useElapsedLabel(slot?.shownAtMs ?? null);
  const pokeIndexRef = useRef(0);
  const perform = useBotAvatarActions(active?.participant.participantId ?? "");
  const poke = useCallback(() => {
    const actions = ["bounce", "spin", "burst"] as const;
    perform(actions[pokeIndexRef.current % actions.length]!);
    pokeIndexRef.current += 1;
  }, [perform]);

  if (slot === null || active === undefined) return null;

  const group = entries.length > 1;
  const label = group
    ? `${active.participant.displayName} · ${active.label}`
    : active.label;
  const labelKey = group
    ? `${active.participant.participantId}:${slot.model.contentKey}`
    : slot.model.contentKey;

  return (
    <div
      className="bot-chat-activity-slot"
      data-mode={slot.model.mode}
      data-state={slot.state}
      role="status"
    >
      <div
        className="bot-chat-activity"
        data-group={group || undefined}
        data-state={slot.state}
      >
        <span className="bot-chat-activity__marks">
          {entries.slice(0, 3).map((entry) => (
            <button
              aria-label={`Interact with ${entry.participant.displayName}`}
              className="bot-chat-activity__mark-button"
              data-active={
                entry.participant.participantId ===
                  active.participant.participantId || undefined
              }
              key={entry.participant.participantId}
              onClick={
                entry.participant.participantId ===
                active.participant.participantId
                  ? poke
                  : undefined
              }
              type="button"
            >
              <BotAvatarMark
                followPointer
                participant={entry.participant}
                size={group ? "compact" : "normal"}
              />
            </button>
          ))}
        </span>
        <span className="bot-chat-activity__copy">
          <RollingActivityLabel label={label} labelKey={labelKey} />
          {elapsedLabel === null ? null : (
            <span className="bot-chat-activity__elapsed">
              {elapsedLabel}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

export const BOT_ACTIVITY_TIMING = Object.freeze({
  activityMinHoldMs: ACTIVITY_MIN_HOLD_MS,
  labelMinHoldMs: LABEL_MIN_HOLD_MS,
  labelRollMs: LABEL_ROLL_MS,
  exitMs: ACTIVITY_EXIT_MS,
  groupCycleMs: GROUP_MARK_CYCLE_MS,
  elapsedThresholdMs: ELAPSED_LABEL_THRESHOLD_MS,
});
