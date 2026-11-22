import { inputExecutionEnded, type InputDeliveryReceipt } from "@opencraft/appserver-protocol";
import type { QueuedSubmission, ThreadQueueStore } from "./queue-store.js";

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
  queue: ThreadQueueStore<S>,
  threadId: string,
  port: QueueReconcilePort,
  receiptTurnIds?: readonly string[],
): Promise<void> {
  const unsettled = queue
    .list(threadId, receiptTurnIds)
    .filter((row) => row.state === "unknown" || row.state === "steering" || row.state === "closed");
  const terminal = new Map<string, Promise<{ readonly status?: unknown } | undefined>>();
  let idle: boolean | undefined;
  for (const row of unsettled) {
    if (
      row.pausedReason === "delivery-retry-requested" &&
      (row.delivery?.nativeAdmission === "accepted" || row.delivery?.context === "recorded")
    ) {
      queue.resumeRequestedRetry(threadId, row.id); // Positive evidence retires the retry, never requeues it.
      port.changed();
    }
    const target = row.targetTurnId === "unknown" ? null : row.targetTurnId;
    if (await port.historyHasInput(row.clientUserMessageId, target)) {
      queue.deliveries.recorded(threadId, row.clientUserMessageId);
      queue.settle(threadId, row.id, "delivered");
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
        queue.deliveries.recorded(threadId, row.clientUserMessageId);
        queue.settle(threadId, row.id, "delivered");
      } else {
        // Idle alone is insufficient. If the terminal notification was lost,
        // recover its exact Turn before consuming the durable retry intent.
        if (!inputExecutionEnded(row.delivery) && target) {
          const turn = await port.findTurn(target);
          if (turn && TERMINAL.includes(status(turn))) queue.deliveries.finish(threadId, target, status(turn));
        }
        queue.resumeRequestedRetry(threadId, row.id);
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
      if (queue.deliveries.finish(threadId, target, status(turn))) port.changed();
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

function sendable<S>(
  queue: ThreadQueueStore<S>,
  threadId: string,
  id: string,
  refuse: (message: string) => never,
  unknownMessage: string,
): QueuedSubmission<S> {
  const head = queue.firstAwaitingAdmission(threadId);
  if (head?.state === "unknown") refuse(unknownMessage);
  if (head?.state === "dispatching") refuse("Earlier delivery is still being sent");
  const queued = queue.find(threadId, id);
  if (!queued) refuse("Queued message is unavailable");
  return queued;
}

async function send<S, P, R, T>(
  queue: ThreadQueueStore<S>,
  threadId: string,
  id: string,
  targetTurnId: string,
  port: QueueDispatchPort<S, P, R>,
  prepared: P,
  accepted: (turnId: string) => void,
  result: (turnId: string, response: R) => T,
): Promise<T> {
  const row = queue.claim(threadId, id, targetTurnId);
  if (!row) port.refuse("Queued message is already being dispatched");
  port.changed();
  try {
    const { turnId, response } = await port.send(row, prepared);
    accepted(turnId);
    port.changed();
    // Built after settlement, so a receipt in the result reflects it.
    return result(turnId, response);
  } catch (error) {
    const failure = port.failed(error);
    queue.settle(threadId, id, failure.state, failure.reason);
    failure.after?.();
    port.changed();
    throw error;
  }
}

/** Start a new turn with a queued input. Its turn is unknown until native acknowledges it. */
export async function dispatchQueuedStart<S, P, R>(
  queue: ThreadQueueStore<S>,
  threadId: string,
  id: string,
  port: QueueDispatchPort<S, P, R>,
): Promise<R> {
  const queued = sendable(
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
  queue: ThreadQueueStore<S>,
  threadId: string,
  id: string,
  expectedTurnId: string,
  port: QueueDispatchPort<S, P, R>,
  reconcile: () => Promise<void>,
): Promise<{ turnId: string; delivery: InputDeliveryReceipt | undefined }> {
  const previous = queue.find(threadId, id);
  if (previous && (previous.delivery?.nativeAdmission === "accepted" || inputExecutionEnded(previous.delivery))) {
    if (previous.targetTurnId !== expectedTurnId) port.refuse("Message identity already belongs to another Turn");
    return { turnId: expectedTurnId, delivery: previous.delivery };
  }
  if (queue.firstAwaitingAdmission(threadId)?.state === "unknown") await reconcile();
  const queued = sendable(queue, threadId, id, port.refuse, "Managed input delivery is still unconfirmed");
  const prepared = await port.prepare(queued);
  if (inputExecutionEnded(queue.deliveries.receipt(threadId, queued.clientUserMessageId, expectedTurnId)))
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
    (turnId) => ({ turnId, delivery: queue.find(threadId, id)?.delivery }),
  );
}
