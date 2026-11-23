import { join } from "node:path";
import { acquireCodexWriter } from "@opencraft/account-pool-host";
import { InterruptedTurnRecovery, ProviderTurnRetry, type ProviderRetryPort, type TurnRecoveryPort } from "@opencraft/host-recovery";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import { boundedWakeTimer, timeoutWakeClock, WorkspaceOwner, type OwnerWakeTimerFactory, type WorkspaceIdentity } from "@opencraft/workspace-host";
export { DEFAULT_WORKSPACE_ID, defaultWorkspace, workspaceIdentity, type WorkspaceIdentity } from "@opencraft/workspace-host";
import { ConversationSchedules, type ScheduleExecutionPort } from "./conversation-schedules.js";
import { ExecutionLeaseStore } from "./execution-lease-store.js";
import { OpenCraftHostQueue } from "./opencraft-host-queue.js";
import { OpenCraftHostStateDatabase } from "./opencraft-host-state-database.js";
import { ProvisionalThreads } from "./provisional-threads.js";

/** WorkspaceHost-owned Codex Host state (workspace-host-split.md §4.1 WH rows). Each store keeps its existing
 * SQLite owner, file name, migrations and thread placement; only who opens and closes it changes. The Node owners
 * open node:sqlite and lend the domain stores the runtime-neutral `SqlDatabase` port (`Sql*` classes), which a
 * per-workspace Durable Object can lend over its own SQL instead. */
export interface CodexWorkspaceStores {
  /** `opencraft-host-state.sqlite`: queue, execution leases, thread catalog and its sync state. */
  readonly hostState: OpenCraftHostStateDatabase;
  readonly provisionalThreads: ProvisionalThreads;
  readonly queue: OpenCraftHostQueue;
  readonly schedules: ConversationSchedules;
  readonly recovery: InterruptedTurnRecovery;
  readonly providerRetry: ProviderTurnRetry;
  readonly migratedNativeQueue: number;
}

export type CodexWorkspaceHost = WorkspaceOwner<CodexWorkspaceStores>;

export interface CodexWorkspaceHostOptions {
  /** Hold the kernel-held `host-overlays-owner` guard under the root. Required when an independent Codex core owns
   * the same directory's account/native writer; the embedded engine's combined writer lock already covers it. */
  readonly overlaysLock: boolean;
  /** Embedded engine only: import a legacy native queue once, before any owner wakes. */
  readonly migrateNativeQueueFrom?: string;
  readonly recovery: TurnRecoveryPort;
  readonly providerRetry: ProviderRetryPort;
  readonly providerRetryAdmission: () => boolean;
  readonly schedules: ScheduleExecutionPort;
  readonly diagnostic: (event: { event: string; scheduleId?: string }) => void;
  readonly schedulesChanged: () => void;
  readonly now?: () => number;
  readonly random?: () => number;
  /** Each dispatch owner's single wake-up (§4.3): schedules, interrupted-turn recovery and provider retry. Each
   * defaults to the Node implementation, a bounded `setTimeout` over `now`; a Durable Object would pass its alarm. */
  readonly scheduleWakeTimer?: OwnerWakeTimerFactory;
  readonly recoveryWakeTimer?: OwnerWakeTimerFactory;
  readonly providerRetryWakeTimer?: OwnerWakeTimerFactory;
}

/** Node wake-up for a dispatch owner: bounded relative delays that re-read the owner clock (`boundedWakeTimer`). */
export function nodeOwnerWakeTimer(now: () => number = Date.now): OwnerWakeTimerFactory {
  return wake => boundedWakeTimer(timeoutWakeClock(now), wake);
}

/**
 * Opens one workspace's Codex Host stores at its explicit root. Owners are passive until the engine wakes them
 * after native initialize. Open order: overlays lock → host state → provisional threads → (execution leases
 * suspended: a restarted owner has no live execution) → queue (+ legacy import) → schedules → turn recovery →
 * provider retry. `drain()` stops provider retry, turn recovery and schedules (reverse order, waiting for their
 * flights); `close()` then closes queue, provisional threads and host state, and releases the lock last.
 */
export function openCodexWorkspaceHost(identity: WorkspaceIdentity, options: CodexWorkspaceHostOptions): Promise<CodexWorkspaceHost> {
  const now = options.now ?? Date.now;
  const nodeWake = nodeOwnerWakeTimer(now);
  return WorkspaceOwner.open(identity, {
    lock: options.overlaysLock ? ({ root }) => acquireCodexWriter(join(root, "host-overlays-owner")) : undefined,
  }, ({ identity: { root }, own }) => {
    const hostState = own("opencraft-host-state", "state", new OpenCraftHostStateDatabase(root), store => store.close());
    const provisionalThreads = own("thread-creation-lifecycle", "state", new ProvisionalThreads(root), store => store.close());
    new ExecutionLeaseStore(hostState.sql).suspend();
    // The queue borrows the host-state connection; its close only releases what it owns itself.
    const queue = own("opencraft-host-queue", "state", new OpenCraftHostQueue(root, hostState.sql), store => store.close());
    const migratedNativeQueue = options.migrateNativeQueueFrom ? queue.migrateNativeQueue(options.migrateNativeQueueFrom) : 0;
    const schedules = own("conversation-schedules", "dispatch",
      new ConversationSchedules(root, options.schedules, now, options.diagnostic, options.schedulesChanged, undefined,
        options.scheduleWakeTimer ?? nodeWake), store => store.close());
    const recovery = own("interrupted-turn-recovery", "dispatch",
      new InterruptedTurnRecovery(root, options.recovery, undefined, undefined, now, options.recoveryWakeTimer ?? nodeWake), store => store.close());
    const providerRetry = own("provider-turn-retry", "dispatch",
      new ProviderTurnRetry(root, options.providerRetry, now, options.random ?? Math.random, options.providerRetryAdmission,
        options.providerRetryWakeTimer ?? nodeWake), store => store.close());
    return { hostState, provisionalThreads, queue, schedules, recovery, providerRetry, migratedNativeQueue };
  });
}

export function codexWorkspaceStorageOutcomes({ stores }: CodexWorkspaceHost): readonly { name: string; outcome: DatabaseOutcome }[] {
  return [
    { name: "opencraft-host-state", outcome: stores.hostState.outcome },
    { name: "thread-creation-lifecycle", outcome: stores.provisionalThreads.outcome },
    { name: "conversation-schedules", outcome: stores.schedules.outcome },
    { name: "interrupted-turn-recovery", outcome: stores.recovery.outcome },
    { name: "provider-turn-retry", outcome: stores.providerRetry.outcome },
  ];
}
