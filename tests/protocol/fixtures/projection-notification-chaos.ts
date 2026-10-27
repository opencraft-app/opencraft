import type { AppServerClient } from "@opencraft/appserver-client";
import { createCordisThreadSessionRuntime } from "@opencraft/appserver-session";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { executionChannelsFixture, flush } from "./execution-channels";
import { settleFixtureOperation } from "./execution-recovery-chaos";
import { ChaosViolation, requireThat, recoveryChaosRandom } from "./recovery-chaos";

const types = ["read-a", "read-b", "read-workbench", "cancel-a", "cancel-b", "release", "observe", "bad-projector", "archive", "delete", "restore", "overlap", "pad"] as const;
export type ProjectionChaosEvent = { type: typeof types[number] };
export type ProjectionChaosMutant = "global-buffer" | "peer-buffer" | "native-replay" | "drop-projection" | "missing-restore-wake";
export function parseProjectionTrace(value: unknown): ProjectionChaosEvent[] {
  if (!Array.isArray(value) || value.length > 10001) throw Error("Invalid projection trace");
  return value.map(event => { if (!event || !types.includes(event.type)) throw Error("Invalid projection event"); return { type: event.type }; });
}
export function generateProjectionChaos(seed: number, steps = 120): ProjectionChaosEvent[] {
  const random = recoveryChaosRandom(seed);
  return Array.from({ length: steps }, () => ({ type: types[Math.floor(random() * types.length)]! }));
}

/** Actual Workbench, shared Client and two independent peer Sessions. Native
 * observations are checked before making Read replies fair. No live service. */
export async function simulateProjectionNotifications(events: readonly ProjectionChaosEvent[], options: { mutant?: ProjectionChaosMutant } = {}) {
  const f = executionChannelsFixture(), coverage: Record<string, number> = {};
  const count = (key: string) => { coverage[key] = (coverage[key] ?? 0) + 1; };
  let holdRestorationRead = false; const deferredReads: (() => void)[] = [];
  let client!: AppServerClient, scope = 0, sequence = 0, historyRuns = 0, nativeEvents = 0, primaryFailure: unknown;
  const native: number[] = [], expectedNative: number[] = [], coupled: (() => void)[] = [], replayed = new Set<number>();
  type Reader = { actual: number[]; expected: number[]; buffered: number[]; reading?: { controller: AbortController; promise: Promise<unknown> } };
  const a: Reader = { actual: [], expected: [], buffered: [] }, b: Reader = { actual: [], expected: [], buffered: [] };
  const runtime = createAppServerWorkbenchRuntime({ hostId: "h", transport: f.transport, autoReconnect: false, requestTimeoutMs: 60000, onRecoveryEvent() {},
    frameScheduler: { schedule(run) { queueMicrotask(run); return () => {}; } },
    installClientHandlers(current) {
      client = current;
      const request = current.request.bind(current);
      current.request = (async (...args: Parameters<typeof current.request>) => {
        if (args[0] === "thread/read" && options.mutant === "missing-restore-wake" && holdRestorationRead) await new Promise<void>(resolve => deferredReads.push(resolve));
        return request(...args);
      }) as typeof current.request;
      const subscribe = current.subscribeNotification.bind(current);
      current.subscribeNotification = (listener, subscriptionOptions) => {
        if (!subscriptionOptions) return subscribe(listener);
        const index = ++scope;
        if (options.mutant === "global-buffer") {
          const removeIntercept = current.interceptNotification(subscriptionOptions.intercept), remove = subscribe(listener);
          return () => { removeIntercept(); remove(); };
        }
        return subscribe(listener, { intercept(notification, next) {
          const project = () => {
            if (index === 2 && options.mutant === "drop-projection" && notification.method.startsWith("fixture/")) return;
            next();
            const token = (notification.params as { token?: number } | null)?.token;
            if (options.mutant === "native-replay" && notification.method.startsWith("fixture/") && token !== undefined && !replayed.has(token)) {
              replayed.add(token); f.emit(notification.method, notification.params);
            }
          };
          subscriptionOptions.intercept(notification, () => {
            if (index === 3 && options.mutant === "peer-buffer" && a.reading) coupled.push(project); else project();
          });
        } });
      };
      return () => {};
    },
  });
  await runtime.connect(); const view = await runtime.acquireThread("a"); view.setRecoveryVisibility(true); await flush();
  const sessionA = await createCordisThreadSessionRuntime({ client }), sessionB = await createCordisThreadSessionRuntime({ client });
  const bad = new Set<number>(), errors: Error[] = [];
  const removeError = client.subscribeProtocolError(error => { errors.push(error); if (/^Received AppServer response for unknown request id /.test(error.message)) count("late-read-diagnostic"); });
  const removeNative = client.subscribeNotification(n => {
    const token = (n.params as { token?: number } | null)?.token;
    if (token !== undefined) native.push(token);
  });
  const removeProjectors = [sessionA, sessionB].map((session, index) => session.notificationProjectors.register({ name: "projection-chaos", priority: 1000,
    project(current, notification) {
      if (notification.method.startsWith("fixture/")) {
        const token = (notification.params as { token: number }).token; (index === 0 ? a : b).actual.push(token);
        if (bad.has(token)) throw Error("Synthetic isolated projector failure");
      }
      return current;
    },
  }));
  let expectedReason: "archived" | "not-found" | null = null;
  const workbench: { promise: Promise<unknown>; settled: boolean }[] = [];
  const emit = (method: string) => {
    const token = ++sequence; expectedNative.push(token); nativeEvents++;
    if (method.startsWith("fixture/")) {
      if (method === "fixture/bad") bad.add(token);
      for (const reader of [a, b]) (reader.reading ? reader.buffered : reader.expected).push(token);
    }
    f.emit(method, { threadId: "a", token });
  };
  const inspect = () => {
    requireThat(JSON.stringify(native) === JSON.stringify(expectedNative), "NATIVE_NOTIFICATION", "a Session must neither hold nor replay shared native observations");
    requireThat(runtime.resources.threads.getUnavailableReason?.("a") === expectedReason, "RESOURCE_AUTHORITY", "current native resource authority cannot wait for history");
    requireThat(JSON.stringify(a.actual) === JSON.stringify(a.expected), "PROJECTION_CONSERVED", "the first Session owns only its ordered projection delivery");
    requireThat(JSON.stringify(b.actual) === JSON.stringify(b.expected), "PEER_INDEPENDENT", "another Session's Read cannot hold this Session's projection");
    const isolated = errors.filter(error => error.cause instanceof Error && error.cause.message === "Synthetic isolated projector failure");
    requireThat(isolated.length === [...a.actual, ...b.actual].filter(token => bad.has(token)).length, "PROJECTION_ERRORS", "each invoked synthetic projector failure reaches the isolated Client error channel once");
    requireThat(errors.every(error => isolated.includes(error) || /^Received AppServer response for unknown request id /.test(error.message)), "UNEXPECTED_PROTOCOL_ERROR", "only deliberate projector errors and observed late cancelled Read replies are admitted");
    requireThat(f.activations === 0, "READ_ONLY", "notification projection must not acquire execution");
  };
  const release = async () => {
    const completingA = Boolean(a.reading), completingB = Boolean(b.reading);
    for (const reader of [a, b]) { reader.expected.push(...reader.buffered); reader.buffered = []; }
    f.hold = false; f.release(); for (const run of coupled.splice(0)) run();
    for (const reader of [a, b]) { if (reader.reading) await settleFixtureOperation(reader.reading.promise, "PROJECTION_PROGRESS", "released historical projector"); reader.reading = undefined; }
    for (const work of workbench) await settleFixtureOperation(work.promise, "RESOURCE_RETIREMENT", "Workbench restore");
    await flush(); f.hold = true;
    requireThat((!completingA || sessionA.views.get("a")!.turns.length === 0) && (!completingB || sessionB.views.get("a")!.turns.length === 0), "CANONICAL_CUT", "a buffered old Turn start cannot replace the empty current snapshot");
  };
  try {
    await sessionA.resume.read("a"); await sessionB.resume.read("a"); f.hold = true;
    for (const event of events) {
      count(event.type);
      if ((event.type === "read-a" || event.type === "read-b")) {
        const reader = event.type === "read-a" ? a : b, session = event.type === "read-a" ? sessionA : sessionB;
        if (!reader.reading) {
          const controller = new AbortController(); reader.reading = { controller, promise: session.resume.read("a", { signal: controller.signal }).catch(() => undefined) }; historyRuns++; count("effective-" + event.type);
        }
      } else if (event.type === "cancel-a" || event.type === "cancel-b") {
        const reader = event.type === "cancel-a" ? a : b;
        if (reader.reading) {
          const old = reader.reading; reader.reading = undefined; reader.buffered = []; old.controller.abort();
          await settleFixtureOperation(old.promise, "PROJECTION_RETIREMENT", "cancelled history");
          if (reader === a) for (const run of coupled.splice(0)) run(); count("effective-" + event.type);
        }
      } else if (event.type === "read-workbench" && expectedReason === null && workbench.every(work => work.settled)) {
        const work = { settled: false, promise: Promise.resolve() as Promise<unknown> };
        work.promise = view.retryRestore().catch(() => undefined).finally(() => { work.settled = true; }); workbench.push(work); historyRuns++; count("effective-read-workbench");
      } else if (event.type === "release") await release();
      else if (event.type === "observe" || event.type === "bad-projector") {
        emit(event.type === "observe" ? "fixture/observation" : "fixture/bad");
        if (a.reading) count("native-during-a-read"); if (b.reading) count("native-during-b-read");
      } else if (event.type === "archive" || event.type === "delete" || event.type === "restore") {
        const changedToAvailable = event.type === "restore" && expectedReason !== null, readsBeforeRestore = f.reads;
        holdRestorationRead = changedToAvailable;
        expectedReason = event.type === "archive" ? "archived" : event.type === "delete" ? "not-found" : null;
        emit(event.type === "archive" ? "thread/archived" : event.type === "delete" ? "thread/deleted" : "thread/unarchived");
        await flush();
        if (event.type === "restore") {
          requireThat(changedToAvailable ? f.reads > readsBeforeRestore : f.reads === readsBeforeRestore, "RESOURCE_RESTORE_PROGRESS", "a restored demanded resource starts current history once; duplicate availability is not a new epoch");
          count(changedToAvailable ? "effective-restoration-read" : "duplicate-availability");
        }
        holdRestorationRead = false;
        if (expectedReason !== null) {
          for (const work of workbench) requireThat(work.settled, "RESOURCE_RETIREMENT", "native retirement must settle the local restore before its Read reply");
          count("native-retirement");
        }
      } else if (event.type === "overlap" && (a.reading || b.reading)) {
        f.emit("turn/started", { threadId: "a", turn: { id: "obsolete", status: "inProgress", items: [] } }); count("snapshot-overlap");
      }
      await flush(); inspect();
    }
    // Native checks above do not require Read fairness. Only the final suffix
    // releases current history to check projection conservation and quiet cuts.
    await release(); inspect();
    return { events: events.length + 1, coverage, historyRuns: f.reads, requestedReads: historyRuns, nativeEvents };
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    holdRestorationRead = false; for (const run of deferredReads.splice(0)) run();
    f.hold = false; f.release(); for (const run of coupled.splice(0)) run();
    a.reading?.controller.abort(); b.reading?.controller.abort();
    try {
      for (const step of [() => Promise.allSettled([a.reading?.promise, b.reading?.promise, ...workbench.map(work => work.promise)]), () => sessionA.dispose(), () => sessionB.dispose(), () => runtime.dispose()]) {
        await settleFixtureOperation(Promise.resolve().then(step), "PROJECTION_CLEANUP", "projection fixture cleanup");
      }
    } catch (error) {
      if (primaryFailure instanceof ChaosViolation) primaryFailure.cleanupFailure = String(error); else if (primaryFailure === undefined) throw error;
    } finally { removeError(); removeNative(); for (const remove of removeProjectors) remove(); }
  }
}
