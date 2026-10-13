import type { ReplicaJsonValue } from "@opencraft/appserver-protocol";
import type { InteractionResponse, PendingInteraction } from "@opencraft/chat-runtime";

/** Renderer-neutral user intent. Web, Electron and Native can share this mapping. */
export type WorkbenchInteractionAction =
  | { readonly type: "approve-once" }
  | { readonly type: "approve-session" }
  | { readonly type: "approve-always" }
  | { readonly type: "approve-similar" }
  | { readonly type: "approve-network-host" }
  | { readonly type: "decline"; readonly persist?: "session" | "always" }
  | { readonly type: "cancel"; readonly persist?: "session" | "always" }
  | { readonly type: "answer"; readonly values: readonly string[] }
  | { readonly type: "answer-questions"; readonly answers: Readonly<Record<string, readonly string[]>> }
  | {
      readonly type: "submit-option-picker";
      readonly action: "submit" | "skip" | "dismiss";
      readonly selectedOptions: readonly string[];
      readonly freeformAnswer: string | null;
    }
  | {
      readonly type: "submit-setup-role";
      readonly action: "submit" | "skip" | "dismiss";
      readonly selectedRoles: readonly string[];
    }
  | {
      readonly type: "submit-setup-task";
      readonly action: "submit" | "skip" | "dismiss";
      readonly answers: Readonly<Record<string, readonly string[]>>;
    }
  | {
      readonly type: "submit-setup-context";
      readonly action: "continue" | "skip" | "dismiss";
      readonly selectedSources: readonly string[];
    }
  | {
      readonly type: "accept-elicitation";
      readonly content?: ReplicaJsonValue;
      readonly persist?: "session" | "always";
    };

function isAnswerAction(action: WorkbenchInteractionAction): boolean {
  return action.type === "answer" || action.type === "answer-questions" || action.type === "submit-option-picker"
    || action.type === "submit-setup-role" || action.type === "submit-setup-task" || action.type === "submit-setup-context"
    || action.type === "accept-elicitation";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function questionResponse(
  requestId: string,
  questionIds: readonly string[],
  action: WorkbenchInteractionAction,
): InteractionResponse {
  if (action.type === "accept-elicitation") throw new Error("A user-input request requires question answers");
  const ids = new Set(questionIds.filter(Boolean));
  if (ids.size === 0) throw new Error("The AppServer question has no question identity");
  const suppliedAnswers = action.type === "answer-questions" ? action.answers
    : action.type === "answer" && ids.size === 1 ? { [questionIds[0]!]: action.values }
    : {};
  const answers = Object.fromEntries(Object.entries(suppliedAnswers)
    .filter(([questionId]) => ids.has(questionId))
    .map(([questionId, values]) => [questionId, values.map((value) => value.trim()).filter(Boolean)])
    .filter(([, values]) => values.length > 0));
  return { type: "question", requestId, answers };
}

function elicitationContent(values: readonly string[]): ReplicaJsonValue {
  if (values.length !== 1) return [...values];
  const value = values[0] ?? "";
  try {
    return JSON.parse(value) as ReplicaJsonValue;
  } catch {
    return value;
  }
}

export function createInteractionResponse(
  interaction: PendingInteraction,
  action: WorkbenchInteractionAction,
): InteractionResponse {
  const requestId = interaction.requestId;
  switch (interaction.method) {
    case "item/commandExecution/requestApproval": {
      if (isAnswerAction(action)) throw new Error("A command approval requires an approval decision");
      if (action.type === "approve-always") {
        if (!interaction.params.approvalScopes?.includes("always")) throw new Error("Persistent approval is not offered");
        return { type: "command-approval", requestId, decision: "accept", _meta: { persist: "always" } };
      }
      if (action.type === "approve-similar") {
        const amendment = interaction.params.proposedExecpolicyAmendment;
        if (amendment === null || amendment === undefined || amendment.length === 0) {
          throw new Error("The command approval has no exec-policy amendment");
        }
        return {
          type: "command-approval",
          requestId,
          decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } },
        };
      }
      if (action.type === "approve-network-host") {
        const amendment = interaction.params.proposedNetworkPolicyAmendments?.find((candidate) => candidate.action === "allow");
        if (amendment === undefined) throw new Error("The command approval has no allowed network-policy amendment");
        return {
          type: "command-approval",
          requestId,
          decision: { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } },
        };
      }
      return {
        type: "command-approval",
        requestId,
        decision: action.type === "approve-once" ? "accept"
          : action.type === "approve-session" ? "acceptForSession"
          : action.type === "decline" ? "decline"
          : "cancel",
      };
    }
    case "item/fileChange/requestApproval": {
      if (isAnswerAction(action)) throw new Error("A file approval requires an approval decision");
      if (action.type === "approve-always" || action.type === "approve-similar" || action.type === "approve-network-host") {
        throw new Error("A file approval cannot apply a command policy");
      }
      return {
        type: "file-change-approval",
        requestId,
        decision: action.type === "approve-once" ? "accept"
          : action.type === "approve-session" ? "acceptForSession"
          : action.type === "decline" ? "decline"
          : "cancel",
      };
    }
    case "item/permissions/requestApproval": {
      if (isAnswerAction(action)) throw new Error("A permission request requires an approval decision");
      if (action.type === "approve-always" || action.type === "approve-similar" || action.type === "approve-network-host") {
        throw new Error("A permission request cannot apply a command policy");
      }
      const requested = interaction.params.permissions;
      const approved = action.type === "approve-once" || action.type === "approve-session";
      return {
        type: "permissions-approval",
        requestId,
        permissions: approved ? {
          ...(requested.network === null ? {} : { network: requested.network }),
          ...(requested.fileSystem === null ? {} : { fileSystem: requested.fileSystem }),
        } : {},
        scope: action.type === "approve-session" ? "session" : "turn",
      };
    }
    case "item/tool/requestUserInput": {
      return questionResponse(requestId, interaction.params.questions.map((question) => question.id), action);
    }
    case "item/tool/call": {
      const args = record(interaction.params.arguments);
      if (interaction.params.tool === "request_onboarding_input") {
        const questions = Array.isArray(args.questions) ? args.questions : [];
        const ids = questions.flatMap((question) => {
          const id = record(question).id;
          return typeof id === "string" ? [id] : [];
        });
        return questionResponse(requestId, ids, action);
      }
      if (interaction.params.tool === "request_option_picker") {
        if (action.type !== "submit-option-picker") throw new Error("An option picker requires an option-picker response");
        return {
          type: "option-picker",
          requestId,
          action: action.action,
          selectedOptions: [...action.selectedOptions],
          freeformAnswer: action.freeformAnswer,
        };
      }
      if (interaction.params.tool === "setup_codex_step") {
        const step = args.step;
        if (step === "role" && action.type === "submit-setup-role") return {
          type: "setup-codex-step",
          requestId,
          step,
          action: action.action,
          selectedRoles: [...action.selectedRoles],
        };
        if (step === "task" && action.type === "submit-setup-task") return {
          type: "setup-codex-step",
          requestId,
          step,
          action: action.action,
          answers: Object.fromEntries(Object.entries(action.answers).map(([id, values]) => [id, { answers: [...values] }])),
        };
        if (step === "context" && action.type === "submit-setup-context") return {
          type: "setup-codex-step",
          requestId,
          step,
          action: action.action,
          selectedSources: action.action === "continue" ? [...new Set(action.selectedSources)] : [],
        };
        throw new Error(`The ${String(step)} setup step requires its matching response`);
      }
      if (interaction.params.tool === "setup_codex_context_picker") {
        if (action.type !== "submit-setup-context") throw new Error("The setup context picker requires selected sources");
        return {
          type: "setup-context-picker",
          requestId,
          action: action.action === "continue" ? "continue" : "dismiss",
          selectedSources: action.action === "continue" ? [...new Set(action.selectedSources)] : [],
        };
      }
      throw new Error(`Unsupported dynamic UI tool ${interaction.params.tool}`);
    }
    case "item/tool/requestOptionPicker": {
      if (action.type !== "submit-option-picker") throw new Error("An option picker requires an option-picker response");
      return {
        type: "option-picker",
        requestId,
        action: action.action,
        selectedOptions: [...action.selectedOptions],
        freeformAnswer: action.freeformAnswer,
      };
    }
    case "item/tool/requestSetupCodexContextPicker": {
      if (action.type !== "submit-setup-context") throw new Error("The setup context picker requires selected sources");
      return {
        type: "setup-context-picker",
        requestId,
        action: action.action === "continue" ? "continue" : "dismiss",
        selectedSources: action.action === "continue" ? [...new Set(action.selectedSources)] : [],
      };
    }
    case "mcpServer/elicitation/request": {
      if (action.type === "approve-once" || action.type === "approve-session" || action.type === "approve-always"
        || action.type === "approve-similar" || action.type === "approve-network-host" || action.type === "answer-questions"
        || action.type === "submit-option-picker" || action.type === "submit-setup-role"
        || action.type === "submit-setup-task" || action.type === "submit-setup-context") {
        throw new Error("MCP elicitation requires content or an explicit dismissal");
      }
      return {
        type: "elicitation",
        requestId,
        action: action.type === "answer" || action.type === "accept-elicitation" ? "accept" : action.type,
        ...(action.type === "answer" ? { content: elicitationContent(action.values) }
          : action.type === "accept-elicitation" && action.content !== undefined ? { content: action.content }
          : {}),
        ...((action.type === "accept-elicitation" || action.type === "decline" || action.type === "cancel") && action.persist !== undefined
          ? { _meta: { persist: action.persist } }
          : {}),
      };
    }
  }
}
