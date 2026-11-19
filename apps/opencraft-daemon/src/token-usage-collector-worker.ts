import { parentPort, workerData } from "node:worker_threads";
import { CodexCoreControlClient } from "@opencraft/account-pool-host";
import { CodexNativeStorage } from "./codex-native-storage.js";
import { TokenUsageStateDatabase } from "./token-usage-state-database.js";
import { OpenCraftTokenUsageLedger, type UsageSubmission } from "./token-usage-ledger.js";
import { CodexTokenUsageRuntime } from "./token-usage-runtime.js";
import { TokenUsageTelemetry } from "./token-usage-telemetry.js";
import type { CollectorCall, CollectorEvent, CollectorReply } from "./token-usage-collector.js";

/** Off-main-thread owner of the usage collector and its ledger connection.
 * The Host keeps native RPC and trusted submission identity; this worker
 * receives only accounting events and asks for those two capabilities. */
export function runTokenUsageCollectorWorker(): void {
  const port = parentPort!;
  // The Host has already opened, migrated and recovered this store.
  const state = new TokenUsageStateDatabase(workerData.directory);
  const telemetry = new TokenUsageTelemetry();
  const ledger = new OpenCraftTokenUsageLedger(state, workerData.serverId, Date.now, telemetry, {
    recoverPendingAttempts: false,
    projectLegacy: workerData.projectLegacy,
  });
  const storage = new CodexNativeStorage(
    workerData.coreEndpoint
      ? new CodexCoreControlClient(workerData.coreEndpoint, workerData.coreAuthToken ?? "")
      : null,
    () => nativeHome,
  );
  let nativeHome = "",
    sequence = 0,
    closed = false;
  const calls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const call = (request: CollectorCall): Promise<unknown> => {
    if (closed) return Promise.reject(new Error("Usage collector closed"));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject });
      port.postMessage({ type: "call", id, request });
    });
  };
  // Identity is resolved by the Host. Unknown entries return null now and are
  // fetched asynchronously; the ledger's receipt recovery revisits them.
  const identities = new Map<string, UsageSubmission | null>();
  const asked = new Set<string>();
  const identityKey = (threadId: string, inputId: string) => JSON.stringify([threadId, inputId]);
  const submission = (threadId: string, inputId: string): UsageSubmission | null => {
    const key = identityKey(threadId, inputId);
    if (identities.has(key)) return identities.get(key)!;
    if (!asked.has(key) && asked.size < 4096) {
      asked.add(key);
      void call({ kind: "submission", threadId, inputId }).then(
        (value) => {
          asked.delete(key);
          remember(threadId, inputId, value as UsageSubmission | null);
          if (value) runtime.recheck(threadId);
        },
        () => {
          asked.delete(key);
        },
      );
    }
    return null;
  };
  const remember = (threadId: string, inputId: string, value: UsageSubmission | null) => {
    if (identities.size >= 8192) identities.delete(identities.keys().next().value!);
    identities.set(identityKey(threadId, inputId), value);
  };
  const runtime = new CodexTokenUsageRuntime(ledger, {
    request: (method, params) => call({ kind: "request", method, params }),
    source: (threadId, path) => storage.resolve(threadId, path),
    submission: workerData.submission ? submission : undefined,
    diagnostic: (category) => port.postMessage({ type: "diagnostic", category }),
    // Derived projections live in the Host query worker; forward invalidations.
    derived: workerData.derived
      ? { invalidate: (threadId: string, path?: string) => port.postMessage({ type: "invalidate", threadId, path }) }
      : undefined,
  });
  const reply = (id: number, body: () => unknown) => {
    let message: CollectorReply;
    try {
      message = { type: "reply", id, result: body() ?? null };
    } catch {
      message = { type: "reply", id, error: true };
    }
    port.postMessage(message);
  };
  const liveGaps = () => port.postMessage({ type: "gaps", count: runtime.liveGapCount() });
  let gapsTimer: ReturnType<typeof setInterval> | null = setInterval(liveGaps, 1000);
  port.on("message", (message: CollectorEvent) => {
    if (closed) return;
    switch (message.type) {
      case "result": {
        const pending = calls.get(message.id);
        if (!pending) return;
        calls.delete(message.id);
        if (message.error)
          pending.reject(Object.assign(new Error(message.error.message ?? "request failed"), message.error));
        else pending.resolve(message.result);
        return;
      }
      case "identity":
        remember(message.input.threadId, message.input.inputId, message.input);
        return;
      case "initialize":
        nativeHome = message.codexHome;
        runtime.initialize({ codexHome: message.codexHome });
        return;
      case "notification":
        runtime.notification(message.method, message.params);
        return;
      case "threadStarted":
        runtime.threadStarted(message.value);
        return;
      case "threadLoaded":
        runtime.threadLoaded(message.threadId);
        return;
      case "releaseEphemeral":
        runtime.releaseEphemeral(message.threadId);
        return;
      case "submission":
        remember(message.input.threadId, message.input.inputId, message.input);
        runtime.submission(message.input);
        return;
      case "admission":
        runtime.admission(message.key, message.inputId);
        return;
      case "attempt":
        if (message.identity) remember(message.identity.threadId, message.identity.inputId, message.identity);
        void Promise.resolve(
          runtime.attempt(message.attemptId, message.threadId, message.inputId, message.mode, message.identity),
        ).finally(() => reply(message.id, () => null));
        return;
      case "attemptOutcome":
        runtime.attemptOutcome(message.attemptId, message.outcome, message.turnId);
        return;
      case "setEnabled":
        reply(message.id, () => {
          ledger.setEnabled(message.enabled);
          return ledger.coverage();
        });
        return;
      case "coverage":
        reply(message.id, () => ledger.coverage());
        return;
      case "storedSubmission":
        reply(message.id, () => ledger.storedSubmission(message.threadId, message.inputId));
        return;
      case "close":
        closed = true;
        if (gapsTimer) clearInterval(gapsTimer);
        gapsTimer = null;
        for (const pending of calls.values()) pending.reject(new Error("Usage collector closed"));
        calls.clear();
        try {
          runtime.close();
        } finally {
          state.close();
          port.postMessage({ type: "closed" });
        }
        return;
    }
  });
  port.postMessage({ type: "ready", coverage: ledger.coverage() });
}
