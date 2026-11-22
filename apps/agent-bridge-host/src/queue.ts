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
    "list",
    "find",
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
  /** Bind a route's session again after a Host restart; settles turns that ended unobserved. */
  recover(route: string): Promise<void>;
  /** Whether the route's generation can be started without explicit recovery. */
  dispatchable(route: string): Promise<boolean>;
}

const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
const PAUSED = ["delivery-rejected"];
const items = (thread: Record<string, any>) =>
  (Array.isArray(thread.turns) ? thread.turns : []).flatMap((turn: any) =>
    (Array.isArray(turn?.items) ? turn.items : []).map((item: any) => ({ turnId: turn.id, item })),
  );

/**
 * Queued follow-up input for bridge Threads. Lives in the Engine Host so the
 * next input is sent when a turn ends even while no gateway is attached.
 * Sending goes through the Host's ordinary command custody with a command ID
 * derived from the queued input, so a restart never sends it twice.
 */
export class HostQueue {
  private readonly store: QueueRequestStore<never>;
  private readonly chains = new Map<string, Promise<unknown>>();
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
    void this.storage.call("queueChanged", { route }).catch(() => {});
  }
  private parts(route: string): [string, string] {
    const [serverId, threadId] = JSON.parse(route) as [string, string];
    return [serverId, threadId];
  }
  private async thread(route: string): Promise<Record<string, any>> {
    const [serverId, threadId] = this.parts(route);
    return object(object(await this.port.history(serverId, threadId, { view: "thread", includeTurns: true })).thread);
  }
  private async historyHasInput(route: string, clientId: string, target: string | null): Promise<boolean> {
    return items(await this.thread(route)).some(
      ({ turnId, item }) =>
        (target === null || turnId === target) && item?.type === "userMessage" && item.clientId === clientId,
    );
  }
  private reconcile(route: string, receiptTurnIds?: readonly string[]): Promise<void> {
    return reconcileThreadQueue(
      this.store,
      route,
      {
        historyHasInput: (clientId, target) => this.historyHasInput(route, clientId, target),
        isIdle: () => this.storage.call("routeIdle", { route }),
        findTurn: async (target) => (await this.thread(route)).turns?.find((turn: any) => turn?.id === target),
        changed: () => this.changed(route),
      },
      receiptTurnIds,
    );
  }
  /** Stable per attempt: a restart cannot send twice, while an explicit retry is a new attempt. */
  private commandId(kind: string, route: string, row: QueuedSubmission<never>): string {
    return `queue-${kind}:${createHash("sha256")
      .update(JSON.stringify([route, row.clientUserMessageId, row.targetTurnId, row.delivery?.revision ?? 0]))
      .digest("hex")}`;
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
          this.commandId(kind, route, row),
          kind === "start" ? "turn/start" : "turn/steer",
          params,
        );
        const response = object(receipt.response);
        if (receipt.state !== "accepted")
          throw Object.assign(Error(object(response.error).message ?? "Queued delivery was not accepted"), {
            settlement: receipt.state,
          });
        const result = object(response.result),
          turnId = String(object(result.turn).id ?? result.turnId ?? "");
        if (!turnId || (kind === "steer" && turnId !== expectedTurnId))
          throw Object.assign(Error("Invalid native acknowledgement"), { settlement: "unknown" });
        return { turnId, response: result };
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
      if (!(await this.storage.call("routeIdle", { route }))) return;
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
      isIdle: () => this.storage.call("routeIdle", { route }),
      historyHasInput: (clientId, target) => this.historyHasInput(route, clientId, target),
      reconcile: (receiptTurnIds) => this.reconcile(route, receiptTurnIds),
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
