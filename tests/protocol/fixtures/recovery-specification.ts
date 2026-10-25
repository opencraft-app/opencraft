// Test-only, independent specification of the proposed recovery contract.
// Budgets are normalized logical units, not production timeout recommendations.
export const budgets = { stage: 10, attempt: 25, validation: 5 } as const;
const stages = ["dial", "bridge", "admission", "initialize"] as const;
type Stage = typeof stages[number];
export type Phase = "idle" | "attempting" | "usable" | "backoff" | "blocked" | "disposed";
export type Event =
  | { type: "connect" | "hint" | "tick" | "dispose"; at: number }
  | { type: "demand" | "barrier"; at: number; value: boolean }
  | { type: "progress"; at: number; id: number; stage: Stage }
  | { type: "ready" | "probe-ok" | "baseline" | "expire"; at: number; id: number }
  | { type: "loss"; at: number; id: number; manual?: boolean; retryAfter?: number };
export type Effect = { type: "dial" | "retire" | "probe" | "catch-up"; id: number };
export interface State {
  phase: Phase;
  now: number;
  generation: number;
  attempt: { id: number; started: number; progressed: number; stage: Stage } | null;
  hostGeneration: number | null;
  baselineGeneration: number | null;
  demand: boolean;
  barrierReady: boolean;
  pendingWake: boolean;
  failures: number;
  retryAt: number;
  validationAt: number;
  serverNotBefore: number;
}
export const initialState = (): State => ({ phase: "idle", now: 0, generation: 0,
  attempt: null, hostGeneration: null, baselineGeneration: null, demand: true,
  barrierReady: true, pendingWake: false, failures: 0, retryAt: Infinity,
  validationAt: 0, serverNotBefore: 0 });

export function transition(previous: State, event: Event): { state: State; effects: Effect[] } {
  if (previous.phase === "disposed") return { state: previous, effects: [] };
  if (event.at < previous.now) throw new Error("Observation clock must not go backwards");
  const state = { ...previous, now: event.at,
    attempt: previous.attempt === null ? null : { ...previous.attempt } };
  const effects: Effect[] = [];
  const stale = () => state.attempt !== null && (
    state.now - state.attempt.progressed >= budgets.stage
    || state.now - state.attempt.started >= budgets.attempt);
  const current = (id: number) => id === (state.attempt?.id ?? state.hostGeneration);
  const retire = () => {
    const id = state.attempt?.id ?? state.hostGeneration;
    if (id !== null) effects.push({ type: "retire", id });
    state.attempt = null;
    state.hostGeneration = state.baselineGeneration = null;
  };
  const start = () => {
    if (!state.demand || !state.barrierReady || state.now < state.serverNotBefore) return;
    state.generation++;
    state.phase = "attempting";
    state.attempt = { id: state.generation, started: state.now, progressed: state.now, stage: "dial" };
    state.pendingWake = false;
    state.validationAt = state.now + budgets.validation;
    state.retryAt = Infinity;
    effects.push({ type: "dial", id: state.generation });
  };
  const fail = () => {
    retire();
    state.phase = "backoff";
    const delay = [1, 2, 4, 8, 16, 32, 60][Math.min(state.failures++, 6)]!;
    state.retryAt = state.now + delay;
  };
  switch (event.type) {
    case "dispose":
      retire(); state.phase = "disposed"; state.pendingWake = false; state.retryAt = Infinity;
      return { state, effects };
    case "demand": state.demand = event.value; break;
    case "barrier": state.barrierReady = event.value; break;
    case "connect":
      if (state.phase === "usable" || state.attempt !== null) break;
      // Explicit retry may leave a manual block, but cannot bypass a physical barrier.
      state.phase = "backoff"; state.retryAt = state.now; break;
    case "hint":
      if (state.phase === "blocked") break;
      state.pendingWake = true;
      if (state.phase === "usable" && state.demand && state.now >= state.validationAt) {
        effects.push({ type: "probe", id: state.hostGeneration! });
        state.validationAt = state.now + budgets.validation;
      }
      break;
    case "progress":
      if (state.attempt?.id === event.id && !stale() && stages.indexOf(event.stage) > stages.indexOf(state.attempt.stage)) {
        state.attempt.stage = event.stage; state.attempt.progressed = state.now;
      }
      break;
    case "ready":
      if (state.attempt?.id === event.id && !stale()) {
        state.attempt = null; state.phase = "usable";
        state.hostGeneration = event.id; state.pendingWake = false;
        effects.push({ type: "catch-up", id: event.id });
      }
      break;
    case "baseline":
      if (state.phase === "usable" && state.hostGeneration === event.id) state.baselineGeneration = event.id;
      break;
    case "probe-ok":
      // This proves only the shared gateway route, never Host or Thread readiness.
      break;
    case "loss":
      if (!current(event.id)) break;
      state.serverNotBefore = Math.max(state.serverNotBefore, event.retryAfter ?? 0);
      if (event.manual) {
        retire(); state.phase = "blocked"; state.pendingWake = false; state.retryAt = Infinity;
      } else fail();
      break;
    case "expire":
      if (state.attempt?.id === event.id && stale()) fail();
      break;
    case "tick": break;
  }
  // Wake-up rechecks absolute deadlines even if browser timers were suspended.
  // A recent meaningful stage transition keeps the current attempt; duplicate
  // observations cannot extend either the stage or total attempt deadline.
  if (state.attempt !== null && stale()) fail();
  if (state.phase === "backoff" && state.demand && state.barrierReady
    && state.now >= state.serverNotBefore
    && (state.now >= state.retryAt || (state.pendingWake && state.now >= state.validationAt))) start();
  if (state.phase === "idle" && state.pendingWake && state.now >= state.validationAt) start();
  return { state, effects };
}
