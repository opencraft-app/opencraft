type Clock = { wall(): number; elapsed(): number; every(fn: () => void): unknown; clear(id: unknown): void };
type Source = Pick<EventTarget, "addEventListener" | "removeEventListener">;
type Fields = Record<string, string | number | null>;
/** Observe visible timer gaps and lifecycle transitions; never infer a freeze from missing samples. */
export function observeClientLifecycle(
  page: Source & { readonly visibilityState: string }, window: Source, emit: (fields: Fields) => void,
  clock: Clock = { wall: () => Date.now(), elapsed: () => performance.now(),
    every: fn => setInterval(fn, 2000), clear: id => clearInterval(id as ReturnType<typeof setInterval>) },
): () => void {
  let wall = clock.wall(), elapsed = clock.elapsed(), interval: unknown;
  let stopped = false;
  const removers: (() => void)[] = [];
  const sample = (clientSignal: string, force = true) => {
    if (stopped) return;
    const nextWall = clock.wall(), nextElapsed = clock.elapsed();
    const wallMs = Math.max(0, nextWall - wall), elapsedMs = Math.max(0, nextElapsed - elapsed);
    wall = nextWall; elapsed = nextElapsed;
    if (force || wallMs >= 6000 || elapsedMs >= 6000)
      emit({kind:'client_signal',clientSignal,clientWallMs:wallMs,clientElapsedMs:elapsedMs,measurementScope:'client'});
  };
  const pause = () => { if (interval !== undefined) clock.clear(interval); interval = undefined; };
  const resume = () => { if (interval === undefined && page.visibilityState === 'visible') interval = clock.every(() => sample('timer_gap', false)); };
  const on = (source: Source, event: string, callback: () => void) => {
    source.addEventListener(event, callback); removers.push(() => source.removeEventListener(event, callback));
  };
  on(page, 'visibilitychange', () => { sample(page.visibilityState === 'visible' ? 'visible' : 'hidden'); pause(); resume(); });
  on(page, 'freeze', () => { sample('freeze'); pause(); });
  on(page, 'resume', () => { sample('resume'); resume(); });
  on(window, 'pagehide', () => { sample('pagehide'); pause(); });
  on(window, 'pageshow', () => { sample('pageshow'); resume(); });
  on(window, 'offline', () => sample('offline'));
  on(window, 'online', () => sample('online'));
  resume();
  return () => { stopped = true; pause(); for (const remove of removers) remove(); };
}
