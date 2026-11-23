import { inputExecutionEnded, type InputDeliveryReceipt } from "@opencraft/appserver-protocol";
import type { QueuedSubmission } from "./queue-store.js";

type Awaitable<T> = T | Promise<T>;

/**
 * The queue operations reconciliation and dispatch use. `ThreadQueueStore`
 * provides them synchronously; an owner whose SQL runs off the event loop
 * provides them asynchronously over the same database.
 */
export interface QueueStoreAccess<S> {
  list(threadId: string, receiptTurnIds?: readonly string[]): Awaitable<QueuedSubmission<S>[]>;
  find(threadId: string, id: string): Awaitable<QueuedSubmission<S> | null>;
  firstAwaitingAdmission(threadId: string): Awaitable<QueuedSubmission<S> | null>;
  claim(threadId: string, id: string, targetTurnId: string | null): Awaitable<QueuedSubmission<S> | null>;
  settle(
    threadId: string,
    id: string,
    state: "queued" | "steering" | "unknown" | "delivered" | "discarded",
    reason?: string | null,
    turnId?: string | null,
  ): Awaitable<boolean>;
  resumeRequestedRetry(threadId: string, id: string): Awaitable<boolean>;
  /** Native history shows the input: admitted and recorded in context. */
  recordInput(threadId: string, clientId: string): Awaitable<void>;
  /** First terminal outcome of a turn; true when newly recorded. */
  finishTurn(threadId: string, turnId: string, outcome: string): Awaitable<boolean>;
  receipt(threadId: string, clientId: string, targetTurnId: string | null): Awaitable<InputDeliveryReceipt>;
}

/** What an engine supplies to reconcile unsettled queue inputs against its own history. */
export interface QueueReconcilePort {
  /** Whether native history contains this client message, in the target turn when given. */
  historyHasInput(clientId: string, targetTurnId: string | null): Promise<boolean>;
  isIdle(): Promise<boolean>;
  /** The native turn, if it can be found, with its status. */
  findTurn(turnId: string): Promise<{ readonly status?: unknown } | undefined>;
  /** A turn proven terminal while reconciling. */
  turnEnded?(turnId: string): void;
  changed(): void;
}

const TERMINAL = ["completed", "failed", "interrupted"];
const status = (turn: { readonly status?: unknown } | undefined) =>
  typeof turn?.status === "string" ? turn.status : "";

/**
 * Settle inputs whose delivery is unknown, steering or closed from evidence only:
 * native history, an explicit user retry after idle, or the exact terminal turn.
 * Nothing is resent and no context evidence is fabricated.
 */
export async function reconcileThreadQueue<S>(
  queue: QueueStoreAccess<S>,
  threadId: string,
  port: QueueReconcilePort,
  receiptTurnIds?: readonly string[],
): Promise<void> {
  const unsettled = (await queue.list(threadId, receiptTurnIds)).filter(
    (row) => row.state === "unknown" || row.state === "steering" || row.state === "closed",
  );
  const terminal = new Map<string, Promise<{ readonly status?: unknown } | undefined>>();
  let idle: boolean | undefined;
  for (const row of unsettled) {
    if (
      row.pausedReason === "delivery-retry-requested" &&
      (row.delivery?.nativeAdmission === "accepted" || row.delivery?.context === "recorded")
    ) {
      await queue.resumeRequestedRetry(threadId, row.id); // Positive evidence retires the retry, never requeues it.
      port.changed();
    }
    const target = row.targetTurnId === "unknown" ? null : row.targetTurnId;
    if (await port.historyHasInput(row.clientUserMessageId, target)) {
      await queue.recordInput(threadId, row.clientUserMessageId);
      await queue.settle(threadId, row.id, "delivered");
      port.changed();
      continue;
    } else if (
      (row.state === "unknown" || row.state === "closed") &&
      row.pausedReason === "delivery-retry-requested" &&
      row.delivery?.nativeAdmission !== "accepted" &&
      (await port.isIdle())
    ) {
      // Only this explicit retry can re-enter the queue. Recheck final history
      // after idle; a positive native ACK is never a retry authorization.
      if (await port.historyHasInput(row.clientUserMessageId, target)) {
        await queue.recordInput(threadId, row.clientUserMessageId);
        await queue.settle(threadId, row.id, "delivered");
      } else {
        // Idle alone is insufficient. If the terminal notification was lost,
        // recover its exact Turn before consuming the durable retry intent.
        if (!inputExecutionEnded(row.delivery) && target) {
          const turn = await port.findTurn(target);
          if (turn && TERMINAL.includes(status(turn))) await queue.finishTurn(threadId, target, status(turn));
        }
        await queue.resumeRequestedRetry(threadId, row.id);
      }
      port.changed();
      continue;
    }
    if (inputExecutionEnded(row.delivery)) continue;
    // Idle by itself says nothing about a particular attempt. Recover its
    // exact terminal Turn, including after a lost notification/restart.
    idle ??= await port.isIdle();
    if (!idle || !target) continue;
    let lookup = terminal.get(target);
    if (!lookup) {
      lookup = port.findTurn(target);
      terminal.set(target, lookup);
    }
    const turn = await lookup;
    if (turn && TERMINAL.includes(status(turn))) {
      port.turnEnded?.(target);
      if (await queue.finishTurn(threadId, target, status(turn))) port.changed();
    }
    // No positive context evidence is fabricated. A closed attempt survives
    // as Host-authored transcript content, and no longer fences later input.
  }
}

/** How a send failure is recorded: back to queued (nothing was sent) or unknown. */
export interface QueueSendFailure {
  readonly state: "queued" | "unknown";
  readonly reason: string | null;
  /** Runs after the failure is recorded and before the change is announced. */
  readonly after?: () => void;
}

/** What an engine supplies to send one queued input. */
export interface QueueDispatchPort<S, P, R> {
  /** Throw the engine's refusal (the queue item stays as it was). */
  refuse(message: string): never;
  /** Engine checks and input preparation before the item is claimed; throwing claims nothing. */
  prepare(row: QueuedSubmission<S>): Promise<P>;
  /** Last engine check after the shared checks, immediately before claiming. */
  beforeClaim?(row: QueuedSubmission<S>): void;
  /** Send the claimed input; resolve only on a valid native acknowledgement. */
  send(row: QueuedSubmission<S>, prepared: P): Promise<{ readonly turnId: string; readonly response: R }>;
  failed(error: unknown): QueueSendFailure;
  changed(): void;
}

async function sendable<S>(
  queue: QueueStoreAccess<S>,
  threadId: string,
  id: string,
  refuse: (message: string) => never,
  unknownMessage: string,
): Promise<QueuedSubmission<S>> {
  const head = await queue.firstAwaitingAdmission(threadId);
  if (head?.state === "unknown") refuse(unknownMessage);
  if (head?.state === "dispatching") refuse("Earlier delivery is still being sent");
  const queued = await queue.find(threadId, id);
  if (!queued) refuse("Queued message is unavailable");
  return queued;
}

async function send<S, P, R, T>(
  queue: QueueStoreAccess<S>,
  threadId: string,
  id: string,
  targetTurnId: string,
  port: QueueDispatchPort<S, P, R>,
  prepared: P,
  accepted: (turnId: string) => Awaitable<unknown>,
  result: (turnId: string, response: R) => Awaitable<T>,
): Promise<T> {
  const row = await queue.claim(threadId, id, targetTurnId);
  if (!row) port.refuse("Queued message is already being dispatched");
  port.changed();
  try {
    const { turnId, response } = await port.send(row, prepared);
    await accepted(turnId);
    port.changed();
    // Built after settlement, so a receipt in the result reflects it.
    return await result(turnId, response);
  } catch (error) {
    const failure = port.failed(error);
    await queue.settle(threadId, id, failure.state, failure.reason);
    failure.after?.();
    port.changed();
    throw error;
  }
}

/** Start a new turn with a queued input. Its turn is unknown until native acknowledges it. */
export async function dispatchQueuedStart<S, P, R>(
  queue: QueueStoreAccess<S>,
  threadId: string,
  id: string,
  port: QueueDispatchPort<S, P, R>,
): Promise<R> {
  const queued = await sendable(
    queue,
    threadId,
    id,
    port.refuse,
    "Managed input delivery or execution recovery is still unconfirmed",
  );
  const prepared = await port.prepare(queued);
  return send(
    queue,
    threadId,
    id,
    "unknown",
    port,
    prepared,
    (turnId) => queue.settle(threadId, id, "delivered", null, turnId),
    (_turnId, response) => response,
  );
}

/**
 * Steer a queued input into the active turn. A message already admitted to that
 * turn answers from its receipt instead of being sent again.
 */
export async function dispatchQueuedSteer<S, P, R>(
  queue: QueueStoreAccess<S>,
  threadId: string,
  id: string,
  expectedTurnId: string,
  port: QueueDispatchPort<S, P, R>,
  reconcile: () => Promise<void>,
): Promise<{ turnId: string; delivery: InputDeliveryReceipt | undefined }> {
  const previous = await queue.find(threadId, id);
  if (previous && (previous.delivery?.nativeAdmission === "accepted" || inputExecutionEnded(previous.delivery))) {
    if (previous.targetTurnId !== expectedTurnId) port.refuse("Message identity already belongs to another Turn");
    return { turnId: expectedTurnId, delivery: previous.delivery };
  }
  if ((await queue.firstAwaitingAdmission(threadId))?.state === "unknown") await reconcile();
  const queued = await sendable(queue, threadId, id, port.refuse, "Managed input delivery is still unconfirmed");
  const prepared = await port.prepare(queued);
  if (inputExecutionEnded(await queue.receipt(threadId, queued.clientUserMessageId, expectedTurnId)))
    port.refuse("no active turn to steer");
  port.beforeClaim?.(queued);
  return send(
    queue,
    threadId,
    id,
    expectedTurnId,
    port,
    prepared,
    () => queue.settle(threadId, id, "steering"),
    async (turnId) => ({ turnId, delivery: (await queue.find(threadId, id))?.delivery }),
  );
}
