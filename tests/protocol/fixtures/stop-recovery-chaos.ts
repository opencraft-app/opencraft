import { createStopControlFixture, drainStopFixture } from "./stop-control";
import { settleFixtureOperation } from "./execution-recovery-chaos";
import { ChaosViolation, requireThat, recoveryChaosRandom } from "./recovery-chaos";

export type StopChaosMutant = "history-gated-stop" | "prompt-gated-stop" | "retarget-stop" | "replay-stop";
const types = ["read", "release-history", "question", "hold-receipt", "release-receipt", "advance-target", "stop", "reenter", "dispose-on-send", "release-on-send", "lost-ack", "reset", "pad"] as const;
export type StopChaosEvent = { type: typeof types[number] };
export function parseStopTrace(value: unknown): StopChaosEvent[] {
  if (!Array.isArray(value) || value.length > 10001) throw Error("Invalid stop trace");
  return value.map(event => {
    if (!event || !types.includes(event.type)) throw Error("Invalid stop event");
    return { type: event.type };
  });
}
export function generateStopChaos(seed: number, steps = 120): StopChaosEvent[] {
  const random = recoveryChaosRandom(seed);
  return Array.from({ length: steps }, () => ({ type: types[Math.floor(random() * types.length)]! }));
}

/** Real Workbench/Session/Conversation/Client. Only native processing is fair:
 * Read replies and prompt delivery receipts can remain held through every stop.
 * This does not assert that an arbitrary native engine cancels the exact Turn. */
export async function simulateStopRecovery(events: readonly StopChaosEvent[], options: { mutant?: StopChaosMutant } = {}) {
  const coverage: Record<string, number> = {}, count = (key: string) => { coverage[key] = (coverage[key] ?? 0) + 1; };
  let current = await createStopControlFixture(), stopped = false, released = false, advanced = false;
  let arm: "reenter" | "dispose-on-send" | "release-on-send" | null = null, lostAck = false, holdReceipt = false;
  let totalWires = 0, historyRuns = 0, operations = 0, primaryFailure: unknown;
  let nested: Promise<unknown>[] = [], postponed: (() => void)[] = [], cleanups: Promise<unknown>[] = [];
  let remove = () => {};
  const install = () => {
    const { f, client, runtime, view } = current;
    const request = client.request.bind(client);
    client.request = (async (...args: Parameters<typeof client.request>) => {
      if (args[0] === "turn/interrupt" && ((options.mutant === "history-gated-stop" && f.reads.length > 0)
        || (options.mutant === "prompt-gated-stop" && holdReceipt && view.getSnapshot().pendingInteractions.length > 0))) {
        await new Promise<void>(resolve => postponed.push(resolve));
      }
      return request(...args);
    }) as typeof client.request;
    const send = f.transport.send.bind(f.transport);
    f.transport.send = async frame => {
      const message = JSON.parse(frame);
      if (message.method !== "turn/interrupt") return send(frame);
      if (options.mutant === "retarget-stop") message.params.turnId = "successor-turn";
      await send(JSON.stringify(message));
      if (options.mutant === "replay-stop") await send(JSON.stringify(message));
      if (lostAck) throw Error("Synthetic lost stop receipt after native admission");
    };
    remove = client.subscribeRequestLifecycle(event => {
      if (event.type !== "started" || event.method !== "turn/interrupt" || !arm) return;
      const action = arm; arm = null; count("effective-" + action);
      if (action === "reenter") {
        const joining = view.interrupt("known-turn"); void joining.catch(() => undefined); nested.push(joining);
      } else if (action === "release-on-send") { view.release(); released = true; }
      else { stopped = true; const disposal = runtime.dispose(); void disposal.catch(() => undefined); cleanups.push(disposal); }
    });
  };
  const close = async () => {
    remove(); current.f.release(); for (const run of postponed.splice(0)) run();
    await settleFixtureOperation(Promise.allSettled([...nested, ...cleanups]), "STOP_CLEANUP", "stop observers");
    await settleFixtureOperation(current.runtime.dispose(), "STOP_CLEANUP", "stop fixture disposal");
    totalWires += current.f.stops.length;
  };
  const stop = async () => {
    if (stopped || released) return;
    const { f, view, runtime } = current, before = f.stops.length;
    const generation = runtime.getSnapshot().connectionGeneration, disposeBeforeSend = arm === "dispose-on-send";
    const reading = f.reads.length > 0, receipt = holdReceipt && view.getSnapshot().pendingInteractions.length > 0;
    f.holdStopReply = lostAck;
    let failure: unknown;
    const operation = view.interrupt("known-turn").catch(error => { failure = error; });
    nested.push(operation); operations++;
    await settleFixtureOperation(operation, "STOP_PROGRESS", "explicit stop before unrelated Read/reply receipts");
    await settleFixtureOperation(Promise.allSettled(nested), "STOP_PROGRESS", "same-intent stop observers"); nested = [];
    const frames = f.stops.slice(before);
    requireThat(frames.every(target => target === "known-turn") && f.stopRequests.slice(before).every(request => request.threadId === "a"), "STOP_TARGET", "a stop must retain its input Turn, even after the server head changes");
    requireThat(frames.length <= 1, "STOP_NO_REPLAY", "one explicit stop intent cannot be replayed or duplicated by reentry");
    requireThat(frames.length === (disposeBeforeSend ? 0 : 1), "STOP_ADMISSION", "a current stop is admitted once; final disposal prevents admission");
    requireThat(Boolean(failure) === (disposeBeforeSend || advanced || lostAck), "STOP_RESULT", "native rejection and uncertain send results must reach the caller");
    requireThat(runtime.getSnapshot().connectionGeneration === generation && f.initializations === 1, "STOP_HOST", "stopping cannot restart the healthy physical Host");
    if (reading && frames.length === 1) count("stop-before-history"); if (receipt && frames.length === 1) count("stop-before-prompt-receipt");
    if (advanced && frames.length === 1) count("stale-target-rejected"); if (lostAck && !advanced && frames.length === 1) count("uncertain-stop");
    count("effective-stop"); lostAck = false; f.holdStopReply = false;
  };
  install();
  try {
    for (const event of events) {
      count(event.type);
      if (event.type === "reset") {
        await close(); current = await createStopControlFixture();
        stopped = released = advanced = holdReceipt = lostAck = false; arm = null; nested = []; cleanups = []; install(); count("effective-reset");
      } else if (!stopped && !released) {
        const { f, runtime, view } = current;
        if (event.type === "read") { f.holdRead = true; await runtime.reconnect(); historyRuns++; }
        else if (event.type === "release-history") f.releaseHistory();
        else if (event.type === "question" && view.getSnapshot().pendingInteractions.length === 0) f.question();
        else if (event.type === "hold-receipt") { holdReceipt = true; f.holdReceipt = true; }
        else if (event.type === "release-receipt") { holdReceipt = false; f.releaseReceipts(); }
        else if (event.type === "advance-target") { advanced = true; f.active = "successor-turn"; }
        else if (event.type === "reenter" || event.type === "dispose-on-send" || event.type === "release-on-send") arm = event.type;
        else if (event.type === "lost-ack") lostAck = true;
        else if (event.type === "stop") await stop();
      }
      await drainStopFixture();
    }
    // Native progress is checked before cleanup releases any historical work.
    await stop();
    return { events: events.length + 1, coverage, historyRuns, wires: totalWires + current.f.stops.length, stopIntents: operations };
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    try { await close(); }
    catch (error) {
      if (primaryFailure instanceof ChaosViolation) primaryFailure.cleanupFailure = String(error);
      else if (primaryFailure === undefined) throw error;
    }
  }
}
