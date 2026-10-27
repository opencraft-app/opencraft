import type {
  BotExecutionTimelineUnit,
  BotTimelineProjection,
  BotTimelineUnit,
} from "@opencraft/bot-conversation";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

interface RetiringExecution {
  readonly expiresAtMs: number;
  readonly unit: BotExecutionTimelineUnit;
}

function executionUnits(
  timeline: BotTimelineProjection,
): ReadonlyMap<string, BotExecutionTimelineUnit> {
  return new Map(
    timeline.units.flatMap((unit) =>
      unit.kind === "execution" ? [[unit.unitKey, unit] as const] : []
    ),
  );
}

function exitUnit(
  unit: BotExecutionTimelineUnit,
  nowMs: number,
): BotExecutionTimelineUnit {
  return Object.freeze({
    ...unit,
    execution: Object.freeze({
      ...unit.execution,
      status: "completed" as const,
      completedAtMs: unit.execution.completedAtMs ?? nowMs,
    }),
    // Presence is transport authority. Once it is gone the retained row only
    // gives the presentation child time to animate from its previous model to
    // null; it must not pretend the Bot is still working.
    presence: Object.freeze([]),
  });
}

function sameRetiringExecutions(
  left: ReadonlyMap<string, RetiringExecution>,
  right: ReadonlyMap<string, RetiringExecution>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const candidate = right.get(key);
    if (
      candidate === undefined ||
      candidate.expiresAtMs !== value.expiresAtMs ||
      candidate.unit !== value.unit
    ) return false;
  }
  return true;
}

/**
 * Retains a completed execution row only for its exit animation. This is a
 * View-owned presentation lease: it never enters Transcript, Execution,
 * Presence, a restore checkpoint, or the AppServer protocol.
 */
export function useBotTimelinePresentation(
  identity: string,
  timeline: BotTimelineProjection,
  exitDurationMs: number,
): BotTimelineProjection {
  const identityRef = useRef(identity);
  const previousRef = useRef<ReadonlyMap<string, BotExecutionTimelineUnit>>(
    new Map(),
  );
  const timerRef = useRef<number | null>(null);
  const [retiring, setRetiring] = useState<
    ReadonlyMap<string, RetiringExecution>
  >(new Map());

  const identityChanged = identityRef.current !== identity;
  if (identityChanged) {
    identityRef.current = identity;
    previousRef.current = new Map();
  }

  const nowMs = Date.now();
  const current = executionUnits(timeline);
  const presentedRetiring = new Map<string, RetiringExecution>();
  if (!identityChanged) {
    for (const [key, value] of retiring) {
      if (value.expiresAtMs > nowMs && !current.has(key)) {
        presentedRetiring.set(key, value);
      }
    }
  }
  for (const [key, previous] of previousRef.current) {
    if (current.has(key) || presentedRetiring.has(key)) continue;
    presentedRetiring.set(key, {
      expiresAtMs: nowMs + exitDurationMs,
      unit: exitUnit(previous, nowMs),
    });
  }

  useLayoutEffect(() => {
    previousRef.current = current;
    setRetiring((value) =>
      sameRetiringExecutions(value, presentedRetiring)
        ? value
        : presentedRetiring
    );
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    const nextExpiry = Math.min(
      ...[...presentedRetiring.values()].map((value) => value.expiresAtMs),
    );
    timerRef.current = Number.isFinite(nextExpiry)
      ? window.setTimeout(() => {
          timerRef.current = null;
          const expiredAtMs = Date.now();
          setRetiring((value) => {
            const next = new Map(
              [...value].filter(([, entry]) => entry.expiresAtMs > expiredAtMs),
            );
            return sameRetiringExecutions(value, next) ? value : next;
          });
        }, Math.max(0, nextExpiry - Date.now()))
      : null;
  }, [exitDurationMs, identity, retiring, timeline]);

  useLayoutEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return useMemo(() => {
    if (presentedRetiring.size === 0) return timeline;
    const units: BotTimelineUnit[] = [
      ...timeline.units,
      ...[...presentedRetiring.values()].map((value) => value.unit),
    ];
    // Semantic transcript order is immutable. Retiring execution rows are a
    // presentation-only tail and therefore cannot be timestamp-sorted into
    // durable history.
    return Object.freeze({
      revision: timeline.revision,
      units: Object.freeze(units),
    });
  }, [presentedRetiring, timeline]);
}
