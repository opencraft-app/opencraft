import { inputExecutionEnded, THREAD_QUEUE_RECEIPT_TURN_LIMIT } from "@opencraft/appserver-protocol";
import type { QueueStoreAccess } from "./dispatch.js";
import type { QueueListPage, QueuedSubmission } from "./queue-store.js";

type Awaitable<T> = T | Promise<T>;

/** The queue operations request handling needs beyond reconciliation and dispatch. */
export interface QueueRequestStore<S> extends QueueStoreAccess<S> {
  listPage(threadId: string, offset: number, limit: number, receiptTurnIds?: readonly string[]): Awaitable<QueueListPage<S>>;
  add(threadId: string, clientId: string, input: readonly unknown[]): Awaitable<QueuedSubmission<S>>;
  update(threadId: string, id: string, input: readonly unknown[]): Awaitable<QueuedSubmission<S> | null>;
  delete(threadId: string, id: string): Awaitable<boolean>;
  reorder(threadId: string, ids: readonly string[]): Awaitable<void>;
  requestRetry(threadId: string, id: string, expectedTurnId: string): Awaitable<boolean>;
  discardUnknown(threadId: string, id: string, expectedTurnId: string): Awaitable<boolean>;
  findByClientId?(threadId: string, clientId: string): Awaitable<QueuedSubmission<S> | null>;
}

/** What an owner supplies; every call is already serialized per Thread by the owner. */
export interface QueueRequestPort {
  isIdle(): Promise<boolean>;
  historyHasInput(clientId: string, targetTurnId: string | null): Promise<boolean>;
  reconcile(receiptTurnIds?: readonly string[]): Promise<void>;
  /** Refresh evidence for a list snapshot in the background. */
  scheduleReconciliation(receiptTurnIds?: readonly string[]): void;
  dispatchStart(id: string): Promise<unknown>;
  dispatchSteer(id: string, expectedTurnId: string): Promise<unknown>;
  /** Serialize work on this Thread with the owner's other Thread operations. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  changed(): void;
  /** Ask the owner to dispatch the queue head when the Thread is idle. */
  schedule(): void;
}

export class QueueRequestError extends Error {
  /** Bridge error kind for the code: a refusal changed nothing, an invalid request or an unsupported method. */
  readonly kind: "explicit-reject" | "invalid" | "unsupported";
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.kind = code === -32602 ? "invalid" : code === -32601 ? "unsupported" : "explicit-reject";
  }
}
const refuse = (message: string, code = -32600): never => {
  throw new QueueRequestError(code, message);
};
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Owner-neutral list projection: no sender attribution and no managed (owner-reconciled) inputs. */
export function projectQueuedSubmission<S>(row: QueuedSubmission<S>) {
  const open = !inputExecutionEnded(row.delivery);
  return {
    actions: { edit: open, delete: true, start: open, reorder: open },
    delivery: row.delivery,
    id: row.id,
    input: row.input,
    clientUserMessageId: row.clientUserMessageId,
    sender: null,
    createdAt: row.createdAt,
    pausedReason: row.pausedReason,
  };
}

/**
 * The thread/queue/* methods over the shared queue, for owners without
 * collaboration-managed inputs. Results follow the AppServer queue protocol.
 */
export async function threadQueueRequest<S>(
  queue: QueueRequestStore<S>,
  threadId: string,
  method: string,
  params: Record<string, unknown>,
  port: QueueRequestPort,
): Promise<unknown> {
  const itemId = text(params.queuedSubmissionId);
  switch (method) {
    case "thread/queue/find": {
      // One input's custody, for an owner that guards managed inputs above this queue.
      const byId = text(params.queuedSubmissionId),
        byClient = text(params.clientUserMessageId);
      if (!byId === !byClient) refuse("Find requires exactly one of queuedSubmissionId or clientUserMessageId", -32602);
      if (byClient && !queue.findByClientId) refuse("Unsupported queue method thread/queue/find", -32601);
      const row = byId ? await queue.find(threadId, byId) : await queue.findByClientId!(threadId, byClient);
      return {
        queuedSubmission: row
          ? {
              id: row.id,
              clientUserMessageId: row.clientUserMessageId,
              state: row.state,
              targetTurnId: row.targetTurnId,
              delivery: row.delivery,
            }
          : null,
      };
    }
    case "thread/queue/list": {
      const cursor = params.cursor == null ? 0 : Number(params.cursor);
      const limit = params.limit == null ? 50 : Number(params.limit);
      if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1)
        refuse("Invalid queue pagination", -32602);
      const receiptTurnIds = params.receiptTurnIds;
      if (
        receiptTurnIds !== undefined &&
        (!Array.isArray(receiptTurnIds) ||
          receiptTurnIds.length > THREAD_QUEUE_RECEIPT_TURN_LIMIT ||
          receiptTurnIds.some((id) => typeof id !== "string" || !id))
      )
        refuse("Invalid receipt Turn scope", -32602);
      const scope = receiptTurnIds as string[] | undefined;
      const page = await queue.listPage(threadId, cursor, Math.min(limit, 100), scope);
      if (cursor === 0) port.scheduleReconciliation(scope);
      return {
        data: page.queued.map(projectQueuedSubmission),
        nextCursor: page.nextCursor === null ? null : String(page.nextCursor),
        ...(page.receipts
          ? {
              steering: page.receipts.map((row) => ({
                  ...projectQueuedSubmission(row),
                  targetTurnId: row.targetTurnId ?? "unknown",
                  retryable:
                    row.state !== "closed" &&
                    row.delivery?.nativeAdmission !== "accepted" &&
                    !inputExecutionEnded(row.delivery) &&
                    row.pausedReason !== "execution-fault-unconfirmed",
                })),
            }
          : {}),
      };
    }
    case "thread/queue/add": {
      const clientId = text(params.clientUserMessageId);
      if (!clientId) refuse("Queued input requires clientUserMessageId", -32602);
      const row = await queue.add(threadId, clientId, params.input as readonly unknown[]);
      port.changed();
      port.schedule();
      return { queuedSubmission: projectQueuedSubmission(row) };
    }
    case "thread/queue/update": {
      const row = await queue.update(threadId, itemId, params.input as readonly unknown[]);
      if (!row) refuse("Queued message is not editable");
      port.changed();
      return { queuedSubmission: projectQueuedSubmission(row!) };
    }
    case "thread/queue/delete": {
      let deleted: boolean;
      if (params.acknowledgeUnknownDelivery === true) {
        const target = text(params.expectedTurnId),
          row = await queue.find(threadId, itemId);
        if (!target || !row || row.state !== "unknown" || row.targetTurnId !== target)
          refuse("Unknown delivery claim does not match the target turn");
        deleted = await port.exclusive(async () => {
          if (!(await port.isIdle())) refuse("Turn is still active");
          // Evidence that it arrived wins over the user's acknowledgement.
          if (await port.historyHasInput(row!.clientUserMessageId, target === "unknown" ? null : target)) {
            await queue.settle(threadId, itemId, "delivered");
            return true;
          }
          if (!(await queue.discardUnknown(threadId, itemId, target))) refuse("Delivery claim changed before discard");
          return true;
        });
      } else deleted = await queue.delete(threadId, itemId);
      port.changed();
      port.schedule();
      return { deleted };
    }
    case "thread/queue/reorder": {
      if (!Array.isArray(params.queuedSubmissionIds)) refuse("Queue order must be an array", -32602);
      await queue.reorder(threadId, params.queuedSubmissionIds as string[]);
      port.changed();
      return {};
    }
    case "thread/queue/retry": {
      await port.exclusive(async () => {
        const row = await queue.find(threadId, itemId);
        if (!row) refuse("Message is unavailable for retry");
        // Already settled or admitted retries are harmless no-ops.
        if (row!.state === "delivered" || (row!.state === "queued" && row!.targetTurnId === null)) return;
        if (row!.targetTurnId !== text(params.expectedTurnId))
          refuse("Message identity already belongs to another Turn");
        if (
          row!.delivery?.nativeAdmission === "accepted" ||
          inputExecutionEnded(row!.delivery) ||
          row!.state === "dispatching" ||
          row!.state === "steering"
        )
          return;
        if (!(await queue.requestRetry(threadId, itemId, text(params.expectedTurnId))))
          refuse("Message changed before retry");
        await port.reconcile();
      });
      port.changed();
      port.schedule();
      return {};
    }
    case "thread/queue/start":
      return port.exclusive(async () => {
        if (!(await port.isIdle())) refuse("Thread is not idle");
        await port.reconcile([]);
        const row = itemId ? await queue.find(threadId, itemId) : await queue.firstAwaitingAdmission(threadId);
        if (!row || row.state !== "queued") refuse("Queued message is unavailable");
        return port.dispatchStart(row!.id);
      });
    case "thread/queue/steer": {
      const target = text(params.expectedTurnId);
      if (!target) refuse("Steer requires expectedTurnId", -32602);
      return port.exclusive(() => port.dispatchSteer(itemId, target));
    }
    default:
      return refuse(`Unsupported queue method ${method}`, -32601);
  }
}
