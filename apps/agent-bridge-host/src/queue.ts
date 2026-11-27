import { createHash } from "node:crypto";
import {
  dispatchQueuedStart,
  dispatchQueuedSteer,
  reconcileThreadQueue,
  threadQueueRequest,
  QueueRequestError,
  type QueueRequestStore,
  type QueuedSubmission,
} from "@opencraft/thread-queue";
import type { Storage } from "./storage.js";
import type { Receipt } from "./types.js";

/** The Host's view of the shared queue: every operation runs in the storage worker. */
function remoteQueue(storage: Storage): QueueRequestStore<never> {
  const call =
    (method: string) =>
    (...args: unknown[]) =>
      storage.call("queue", { method, args });
  const methods = [
    "listPage",
    "listReconciliation",
    "find",
    "findByClientId",
    "firstAwaitingAdmission",
    "claim",
    "settle",
    "resumeRequestedRetry",
    "recordInput",
    "finishTurn",
    "receipt",
    "add",
    "update",
    "delete",
    "reorder",
    "requestRetry",
    "discardUnknown",
  ] as const;
  return Object.fromEntries(methods.map((method) => [method, call(method)])) as unknown as QueueRequestStore<never>;
}

export interface HostQueuePort {
  /** Admit a command through the Host's normal custody and wait for its settlement. */
  command(
    serverId: string,
    threadId: string,
    commandId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Receipt>;
  history(serverId: string, threadId: string, params: Record<string, unknown>): Promise<unknown>;
  canReconcile(route: string): Promise<boolean>;
  /** Bind a route's session again after a Host restart; settles turns that ended unobserved. */
  recover(route: string): Promise<void>;
  isIdle(route: string): Promise<boolean>;
  /** Whether the route's generation can be started without explicit recovery. */
  dispatchable(route: string): Promise<boolean>;
  outboxWritten?(): void;
}

type HistoryTurn = { id?: string; status?: unknown; items?: unknown };
type HistoryItem = { type?: unknown; clientId?: unknown };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const turns = (thread: Record<string, unknown>): HistoryTurn[] =>
  Array.isArray(thread.turns) ? (thread.turns as HistoryTurn[]) : [];
const PAUSED = ["delivery-rejected"];
/** Dispatch and recovery must address the same durable receipt for a queue attempt. */
export function queuedCommandId(
  kind: "start" | "steer",
  route: string,
  row: QueuedSubmission<never>,
  revision = row.delivery?.revision ?? 0,
): string {
  return `queue-${kind}:${createHash("sha256")
    .update(JSON.stringify([route, row.clientUserMessageId, row.targetTurnId, revision]))
    .digest("hex")}`;
}

export function queuedTurnAcknowledgement(response: unknown, expectedTurnId?: string) {
  const result = object(object(response).result);
  const turnId = object(result.turn).id ?? result.turnId;
  if (typeof turnId !== "string" || !turnId || (expectedTurnId !== undefined && turnId !== expectedTurnId))
    return null;
  return { turnId, response: result };
}

/**
 * Queued follow-up input for bridge Threads. Lives in the Engine Host so the
 * next input is sent when a turn ends even while no gateway is attached.
 * Sending goes through the Host's ordinary command custody with a command ID
 * derived from the queued input, so a restart never sends it twice.
 */
export class HostQueue {
  private readonly store: QueueRequestStore<never>;
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly listScopes = new Map<string, Set<string | null>>();
  private closed = false;
  constructor(
    private readonly storage: Storage,
    private readonly port: HostQueuePort,
    private readonly log: (event: Record<string, unknown>) => void = () => {},
  ) {
    this.store = remoteQueue(storage);
  }
  close(): void {
    this.closed = true;
  }

  private exclusive<T>(route: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(route) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.chains.set(route, next);
    void next
      .finally(() => {
        if (this.chains.get(route) === next) this.chains.delete(route);
      })
      .catch(() => {});
    return next;
  }
  private changed(route: string): void {
    void this.storage.call("queueChanged", { route }).then(() => this.port.outboxWritten?.(), () => {});
  }
  private parts(route: string): [string, string] {
    const [serverId, threadId] = JSON.parse(route) as [string, string];
    return [serverId, threadId];
  }
  private async readHistoryEvidence(route: string) {
    const [serverId, threadId] = this.parts(route);
    const reply = object(await this.port.history(serverId, threadId, { view: "thread", includeTurns: true }));
    const turnOutcomes = new Map<string, { status?: unknown }>();
    const inputTurns = new Map<string, Set<string | undefined>>();
    for (const turn of turns(object(reply.thread))) {
      if (typeof turn?.id === "string" && !turnOutcomes.has(turn.id))
        turnOutcomes.set(turn.id, { status: turn.status });
      if (!Array.isArray(turn?.items)) continue;
      for (const item of turn.items as HistoryItem[]) {
        if (item?.type !== "userMessage" || typeof item.clientId !== "string") continue;
        let targets = inputTurns.get(item.clientId);
        if (!targets) {
          targets = new Set();
          inputTurns.set(item.clientId, targets);
        }
        targets.add(turn.id);
      }
    }
    return {
      hasInput: (clientId: string, target: string | null) => {
        const targets = inputTurns.get(clientId);
        return target === null ? targets !== undefined : targets?.has(target) === true;
      },
      turnOutcomes,
    };
  }
  private async reconcile(route: string, receiptTurnIds?: readonly string[]): Promise<void> {
    if (!(await this.port.canReconcile(route))) return;
    let evidence: ReturnType<HostQueue["readHistoryEvidence"]> | undefined;
    const read = () => (evidence ??= this.readHistoryEvidence(route));
    return reconcileThreadQueue(
      this.store,
      route,
      {
        historyHasInput: async (clientId, target) => (await read()).hasInput(clientId, target),
        isIdle: async () => {
          const idle = await this.port.isIdle(route);
          // Retry and terminal proof must observe history after the idle check.
          if (idle) evidence = undefined;
          return idle;
        },
        findTurn: async (target) => (await read()).turnOutcomes.get(target),
        changed: () => this.changed(route),
      },
      receiptTurnIds,
    );
  }
  private scheduleReconciliation(route: string, receiptTurnIds: readonly string[] | undefined): void {
    if (this.closed) return;
    const scope = receiptTurnIds && [...new Set(receiptTurnIds)].sort();
    const key = scope ? JSON.stringify(scope) : null;
    let scopes = this.listScopes.get(route);
    if (!scopes) {
      scopes = new Set();
      this.listScopes.set(route, scopes);
    }
    if (scopes.has(key) || scopes.has(null)) return;
    scopes.add(key);
    const pending = scopes;
    void this.exclusive(route, async () => {
      if (!this.closed) await this.reconcile(route, scope);
    }).catch(error => {
      this.log({ event: "queue-reconciliation-failed", reason: error instanceof Error ? error.message : "unknown" });
    }).finally(() => {
      pending.delete(key);
      if (pending.size === 0) this.listScopes.delete(route);
    });
  }
  private port_(route: string, kind: "start" | "steer", expectedTurnId?: string) {
    const [serverId, threadId] = this.parts(route);
    return {
      refuse: (message: string): never => {
        throw new QueueRequestError(-32600, message);
      },
      prepare: async () => undefined,
      send: async (row: QueuedSubmission<never>) => {
        const params =
          kind === "start"
            ? { native: { input: row.input, clientUserMessageId: row.clientUserMessageId } }
            : {
                inputId: row.clientUserMessageId,
                clientRequestId: row.clientUserMessageId,
                expectedTurnId,
                input: row.input,
              };
        const receipt = await this.port.command(
          serverId,
          threadId,
          queuedCommandId(kind, route, row),
          kind === "start" ? "turn/start" : "turn/steer",
          params,
        );
        const response = object(receipt.response);
        if (receipt.state !== "accepted")
          throw Object.assign(Error(String(object(response.error).message ?? "Queued delivery was not accepted")), {
            settlement: receipt.state,
          });
        const acknowledgement = queuedTurnAcknowledgement(response, expectedTurnId);
        if (!acknowledgement)
          throw Object.assign(Error("Invalid native acknowledgement"), { settlement: "unknown" });
        return acknowledgement;
      },
      // Only an explicit rejection proves nothing was sent; it pauses instead of retrying in a loop.
      failed: (error: unknown) =>
        object(error).settlement === "rejected"
          ? { state: "queued" as const, reason: kind === "start" ? "delivery-rejected" : null }
          : { state: "unknown" as const, reason: "steer-delivery-unconfirmed" },
      changed: () => this.changed(route),
    };
  }

  /** Send the queue head when the Thread is idle. Never sends anything whose outcome is unknown. */
  schedule(route: string): void {
    if (this.closed) return;
    void this.exclusive(route, async () => {
      if (this.closed || !(await this.port.dispatchable(route))) return;
      // A refused recovery (for example a turn still running natively) is retried on the next trigger.
      try {
        await this.port.recover(route);
      } catch {
        return;
      }
      await this.reconcile(route, []);
      const head = await this.store.firstAwaitingAdmission(route);
      if (!head || head.state !== "queued" || PAUSED.includes(head.pausedReason ?? "")) return;
      if (!(await this.port.isIdle(route))) return;
      await dispatchQueuedStart(this.store, route, head.id, this.port_(route, "start"));
    }).catch((error) =>
      this.log({ event: "queue-dispatch-failed", reason: error instanceof Error ? error.message : "unknown" }),
    );
  }
  /** A turn ended natively: record its first terminal outcome and move the queue. */
  async turnClosed(route: string, nativeTurnId: string, status: string): Promise<void> {
    if (await this.store.finishTurn(route, nativeTurnId, status)) this.changed(route);
    this.schedule(route);
  }
  async resume(): Promise<void> {
    for (const route of await this.storage.call<string[]>("queue", { method: "pendingThreads", args: [] }))
      this.schedule(route);
  }
  request(route: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    return threadQueueRequest(this.store, route, method, params, {
      isIdle: () => this.port.isIdle(route),
      historyHasInput: async (clientId, target) => (await this.readHistoryEvidence(route)).hasInput(clientId, target),
      reconcile: (receiptTurnIds) => this.reconcile(route, receiptTurnIds),
      scheduleReconciliation: (receiptTurnIds) => this.scheduleReconciliation(route, receiptTurnIds),
      dispatchStart: (id) => dispatchQueuedStart(this.store, route, id, this.port_(route, "start")),
      dispatchSteer: (id, expectedTurnId) =>
        dispatchQueuedSteer(this.store, route, id, expectedTurnId, this.port_(route, "steer", expectedTurnId), () =>
          this.reconcile(route, []),
        ),
      exclusive: (work) => this.exclusive(route, work),
      changed: () => this.changed(route),
      schedule: () => this.schedule(route),
    });
  }
}
