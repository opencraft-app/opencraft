import { AppServerClientError } from "@opencraft/appserver-client";
import { SubmissionOutcomeUnknownError } from "@opencraft/chat-runtime";
import type { SubmissionReceipt, SubmitIntent } from "@opencraft/composer-core";
import type { ThreadGoalResource } from "@opencraft/workbench-runtime";

/** Owns the irreversible thread receipt across Goal confirmation/navigation retries. */
export function createNewThreadGoalFlow(config: {
  createThread(intent: SubmitIntent): Promise<SubmissionReceipt>;
  goals(hostId: string): ThreadGoalResource;
  openThread(receipt: SubmissionReceipt): Promise<void>;
  onThreadCreated?(intent: SubmitIntent, receipt: SubmissionReceipt): void;
}) {
  const attempts = new WeakMap<object, {
    receipt?: SubmissionReceipt;
    pending?: Promise<SubmissionReceipt>;
    objective: string;
    writeAttempted: boolean;
    unknownCreation?: Error;
  }>();
  return (intent: SubmitIntent, objective: string, isCurrent: () => boolean): Promise<SubmissionReceipt> => {
    if (intent.target.type !== "new-thread") return Promise.reject(new Error("Expected a new conversation"));
    objective = objective.trim();
    if (!objective || !isCurrent()) return Promise.reject(new Error("The new conversation is no longer active"));
    const target = intent.target;
    const goals = config.goals(target.execution.hostId);
    if (!goals.capability(intent.selections.model)?.write) return Promise.reject(new Error("This Host cannot create goals"));
    let attempt = attempts.get(target);
    if (attempt?.pending) return attempt.pending;
    if (attempt?.unknownCreation) return Promise.reject(attempt.unknownCreation);
    if (attempt && attempt.objective !== objective) return Promise.reject(new Error("请先重试原目标，或新建会话。"));
    if (!attempt) {
      attempt = { objective, writeAttempted: false };
      attempts.set(target, attempt);
    }
    const owned = attempt;
    owned.pending = (async () => {
      if (!owned.receipt) {
        try { owned.receipt = await config.createThread(intent); }
        catch (cause) {
          if (cause instanceof SubmissionOutcomeUnknownError || (cause instanceof AppServerClientError
            && ["TIMEOUT", "TRANSPORT_ERROR", "ABORTED"].includes(cause.code))) {
            owned.unknownCreation = new Error("会话创建结果尚未确认，请先检查会话列表，避免重复创建。", { cause });
            throw owned.unknownCreation;
          }
          throw cause;
        }
        config.onThreadCreated?.(intent, owned.receipt);
      }
      const receipt = owned.receipt;
      if (!isCurrent()) throw new Error("The new conversation changed before its Goal was started");
      // A lost confirmation must first read the durable result, never blindly
      // reactivate a Goal which may already have started or completed a Turn.
      if (owned.writeAttempted) await goals.refresh(receipt.threadId, true);
      if (!isCurrent()) throw new Error("The new conversation changed before its Goal was started");
      const existing = goals.getSnapshot(receipt.threadId).goal;
      if (existing === null) {
        owned.writeAttempted = true;
        await goals.set(receipt.threadId, { objective, status: "active" });
        if (goals.getSnapshot(receipt.threadId).goal?.objective !== objective) {
          throw new Error("Goal creation was not confirmed");
        }
      } else if (existing.objective !== objective) {
        throw new Error("The new conversation already has a different Goal");
      }
      if (isCurrent()) await config.openThread(receipt);
      return receipt;
    })().finally(() => { owned.pending = undefined; });
    return owned.pending;
  };
}
