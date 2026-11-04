/** Observed page lifecycle intervals, not proof that the network was usable. */
export interface PagePauseDiagnostic {
  pagePauseMs?: number;
  pageResumeAgoMs?: number;
  pageHiddenForMs?: number;
}

export function createPagePauseDiagnostics(now: () => number = () => Date.now()) {
  let pausedAt: number | undefined;
  let resumedAt: number | undefined;
  let pauseMs: number | undefined;
  return {
    pause() { pausedAt ??= now(); },
    resume(restoredFromCache = false) {
      if (pausedAt === undefined && !restoredFromCache) return;
      const time = now();
      pauseMs = pausedAt === undefined ? undefined : Math.max(0, time - pausedAt);
      pausedAt = undefined;
      resumedAt = time;
    },
    snapshot(): PagePauseDiagnostic {
      const time = now();
      return {
        ...(pauseMs === undefined ? {} : { pagePauseMs: pauseMs }),
        ...(resumedAt === undefined ? {} : { pageResumeAgoMs: Math.max(0, time - resumedAt) }),
        ...(pausedAt === undefined ? {} : { pageHiddenForMs: Math.max(0, time - pausedAt) }),
      };
    },
  };
}
