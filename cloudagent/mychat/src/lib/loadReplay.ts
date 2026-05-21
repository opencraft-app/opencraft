export interface LoadReplayLifecycle {
  startedAt: number;
  replayDone: boolean;
}

export type LoadReplayDecision = 'restoring' | 'live' | 'error';

export function beginLoadReplayState(now: number): LoadReplayLifecycle {
  return { startedAt: now, replayDone: false };
}

export function markLoadReplayDone(state: LoadReplayLifecycle): LoadReplayLifecycle {
  return { ...state, replayDone: true };
}

export function evaluateLoadReplay(state: LoadReplayLifecycle): LoadReplayDecision {
  return state.replayDone ? 'live' : 'restoring';
}
