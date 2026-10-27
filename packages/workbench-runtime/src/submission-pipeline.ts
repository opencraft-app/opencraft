import type { SubmissionReceipt, SubmitIntent } from "@opencraft/composer-core";

import type { ConversationScopeRegistry } from "./conversation-scope-registry";

export interface WorkbenchSubmissionPipelineConfig {
  readonly scopes: ConversationScopeRegistry;
  readonly submitNewThread: (intent: SubmitIntent) => Promise<SubmissionReceipt>;
  readonly submitExistingThread: (intent: SubmitIntent) => Promise<SubmissionReceipt>;
  readonly submitFirstTurn: (
    intent: SubmitIntent,
    threadReceipt: SubmissionReceipt,
  ) => Promise<SubmissionReceipt>;
  readonly promoteDraft: (
    draftId: string,
    receipt: SubmissionReceipt,
  ) => Promise<void>;
  readonly afterAccepted?: (receipt: SubmissionReceipt) => Promise<void> | void;
}

export interface WorkbenchSubmissionPipeline {
  submit(intent: SubmitIntent): Promise<SubmissionReceipt>;
  resumeDraftPromotion(draftId: string): Promise<SubmissionReceipt>;
}

/**
 * Owns the first-Turn transaction boundary. A server receipt is irreversible:
 * after it exists, every retry resumes client-side promotion and never sends a
 * second thread/start or turn/start.
 */
export function createWorkbenchSubmissionPipeline(
  config: WorkbenchSubmissionPipelineConfig,
): WorkbenchSubmissionPipeline {
  const promoting = new Map<string, Promise<SubmissionReceipt>>();

  const promoteAccepted = (draftId: string): Promise<SubmissionReceipt> => {
    const pending = promoting.get(draftId);
    if (pending !== undefined) return pending;
    const draft = config.scopes.getDraft(draftId);
    if (draft === null || draft.receipt === null) {
      return Promise.reject(new Error(`Draft ${draftId} has no accepted submission`));
    }
    const receipt = draft.receipt;
    const submission = draft.submission;
    if (submission === null) {
      return Promise.reject(new Error(`Draft ${draftId} has no owned first Turn`));
    }
    const operation = (async () => {
      config.scopes.beginPromotion(draftId);
      try {
        await config.promoteDraft(draftId, receipt);
      } catch (error) {
        config.scopes.failPromotion(draftId, error);
        throw error;
      }
      // Promotion transfers the immutable first Turn to the target
      // Conversation Runtime. From here failures belong to that Runtime and
      // must not resurrect or mutate the retired Draft.
      const turnReceipt = receipt.turnId === null
        ? await config.submitFirstTurn(submission, receipt)
        : receipt;
      await config.afterAccepted?.(turnReceipt);
      return turnReceipt;
    })().finally(() => {
      if (promoting.get(draftId) === operation) promoting.delete(draftId);
    });
    promoting.set(draftId, operation);
    return operation;
  };

  return {
    async submit(intent) {
      if (intent.target.type !== "new-thread") {
        const receipt = await config.submitExistingThread(intent);
        await config.afterAccepted?.(receipt);
        return receipt;
      }

      const draftId = intent.target.draftId;
      const current = config.scopes.getDraft(draftId);
      if (current === null) throw new Error(`Draft ${draftId} is unavailable`);
      if (current.receipt !== null) return promoteAccepted(draftId);

      config.scopes.beginSubmit(draftId, intent);
      let receipt: SubmissionReceipt;
      try {
        receipt = await config.submitNewThread(intent);
      } catch (error) {
        config.scopes.failDraft(draftId, error);
        throw error;
      }
      config.scopes.acceptSubmission(draftId, receipt);
      return promoteAccepted(draftId);
    },
    resumeDraftPromotion: promoteAccepted,
  };
}
