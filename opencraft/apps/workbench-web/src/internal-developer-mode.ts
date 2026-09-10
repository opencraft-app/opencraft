import { useSyncExternalStore } from "react";

const INTERNAL_DEVELOPER_MODE_SESSION_KEY = "opencraft.internal-developer-mode.v1";
export const INTERNAL_DEVELOPER_MODE_ESCAPE_COUNT = 5;
export const INTERNAL_DEVELOPER_MODE_MAX_GAP_MS = 1_250;

export interface EscapeSequenceState {
  readonly count: number;
  readonly lastPressAt: number | null;
}

export interface EscapeSequenceResult {
  readonly state: EscapeSequenceState;
  readonly unlocked: boolean;
}

export const EMPTY_ESCAPE_SEQUENCE: EscapeSequenceState = Object.freeze({
  count: 0,
  lastPressAt: null,
});

/** Pure transition used by the one Workbench-owned global gesture listener. */
export function advanceInternalDeveloperModeGesture(
  state: EscapeSequenceState,
  input: { readonly key: string; readonly repeat: boolean; readonly now: number },
): EscapeSequenceResult {
  if (input.repeat) return { state, unlocked: false };
  if (input.key !== "Escape") return { state: EMPTY_ESCAPE_SEQUENCE, unlocked: false };

  const insideSequence = state.lastPressAt !== null
    && input.now - state.lastPressAt >= 0
    && input.now - state.lastPressAt <= INTERNAL_DEVELOPER_MODE_MAX_GAP_MS;
  const count = insideSequence ? state.count + 1 : 1;
  if (count >= INTERNAL_DEVELOPER_MODE_ESCAPE_COUNT) {
    return { state: EMPTY_ESCAPE_SEQUENCE, unlocked: true };
  }
  return {
    state: { count, lastPressAt: input.now },
    unlocked: false,
  };
}

function restoreSessionValue(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(INTERNAL_DEVELOPER_MODE_SESSION_KEY) === "enabled";
  } catch {
    return false;
  }
}

let enabled = restoreSessionValue();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return enabled;
}

function getServerSnapshot(): boolean {
  return false;
}

export function enableInternalDeveloperMode(): boolean {
  if (enabled) return false;
  enabled = true;
  try {
    window.sessionStorage.setItem(INTERNAL_DEVELOPER_MODE_SESSION_KEY, "enabled");
  } catch {
    // Storage availability is optional; the in-memory session still unlocks.
  }
  for (const listener of listeners) listener();
  return true;
}

export function useInternalDeveloperMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
