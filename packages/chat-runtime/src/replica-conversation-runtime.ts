import { userInputQuestionExtensions } from "@opencraft/chat-core";
import type {
  QueuedSubmission as ProtocolQueuedSubmission,
  ReplicaJsonValue,
  MessageSender,
  SteeringSubmission as ProtocolSteeringSubmission,
} from "@opencraft/appserver-protocol";
import type {
  UserInput,
} from "@opencraft/appserver-protocol/generated/v2";
import {
  asTurnId,
  userMessageCompareKey,
  createDefaultTimelineProjectorRegistry,
  projectTimeline,
  summarizeHookRuns,
  type ConversationKey,
  type ConversationPhase,
  type TimelineProjectorRegistry,
  type TimelineSourceItem,
  type TimelineSourceTurn,
  type TimelineStatus,
  type TurnId,
} from "@opencraft/chat-core";
import {
  composerDocumentToPlainText,
  type SubmissionReceipt,
  type SubmitIntent,
} from "@opencraft/composer-core";

import type {
  ConversationRuntimeSnapshot,
  InteractionResponse,
  PendingSubmission,
  PendingInteraction,
  QueuedSubmission,
} from "./models";
import { createInterruptInteractionResponse } from "./interaction-lifecycle";
import { ContinuationCommandError, SubmissionOutcomeUnknownError } from "./ports";
import type {
  ConversationCommandPort,
  ConversationHistoryPort,
  ConversationReplicaReader,
  TurnInterruptProvenance,
} from "./ports";

import { createConversationOutbox, type ConversationOutboxStorage } from "./conversation-outbox";

type JsonRecord = Readonly<Record<string, ReplicaJsonValue>>;

export interface ReplicaConversationRuntimeConfig {
  readonly key: ConversationKey;
  readonly outbox?: ConversationOutboxStorage;
  readonly canDispatchOutbox?: () => boolean;
  /** Compatibility retry while a connected Codex Host does not own capacity continuation. */
  readonly canAutoContinueCapacity?: () => boolean;
  readonly replica: ConversationReplicaReader;
  readonly commands: ConversationCommandPort;
  readonly history: ConversationHistoryPort;
  readonly projectors?: TimelineProjectorRegistry;
  /** Local display only; captured per submission, never sent as trusted metadata. */
  readonly getSubmissionSender?: () => MessageSender | null;
}

export interface ConversationRuntime {
  getSnapshot(): ConversationRuntimeSnapshot;
  subscribe(listener: () => void): () => void;
  loadOlder(): Promise<void>;
  submit(intent: SubmitIntent): Promise<SubmissionReceipt>;
  interrupt(turnId: TurnId, provenance?: TurnInterruptProvenance): Promise<void>;
  continueTurn(turnId: TurnId): Promise<SubmissionReceipt>;
  respond(response: InteractionResponse): Promise<void>;
  /** Replaces the AppServer-owned queue projection after list/change events. */
  replaceQueuedSubmissions(
    submissions: readonly ProtocolQueuedSubmission[],
    steeringSubmissions?: readonly ProtocolSteeringSubmission[],
  ): void;
  updateQueuedSubmission(
    queuedSubmissionId: string,
    input: readonly UserInput[],
  ): Promise<void>;
  deleteQueuedSubmission(queuedSubmissionId: string): Promise<void>;
  discardUnconfirmedSteer(queuedSubmissionId: string, expectedTurnId: TurnId): Promise<void>;
  reorderQueuedSubmissions(
    queuedSubmissionIds: readonly string[],
  ): Promise<void>;
  startQueuedSubmission(queuedSubmissionId?: string): Promise<TurnId>;
  steerQueuedSubmission(queuedSubmissionId: string): Promise<TurnId>;
  dismissFailedSubmission(commandId: string): void;
  dispose(): void;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: ReplicaJsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: ReplicaJsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolean(value: ReplicaJsonValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function array(
  value: ReplicaJsonValue | undefined,
): readonly ReplicaJsonValue[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: ReplicaJsonValue | undefined): readonly string[] {
  return array(value).flatMap((candidate) =>
    typeof candidate === "string" ? [candidate] : [],
  );
}

function phase(
  value: ReturnType<ConversationReplicaReader["getSnapshot"]>["phase"],
): ConversationPhase {
  return value;
}

function turnStatus(value: ReplicaJsonValue | undefined): TimelineStatus {
  const source = isRecord(value)
    ? (string(value.type) ?? string(value.status))
    : string(value);
  switch (source) {
    case "inProgress":
    case "active":
    case "streaming":
      return "streaming";
    case "completed":
    case "complete":
    case "idle":
      return "complete";
    case "failed":
      return "failed";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    default:
      return "pending";
  }
}

function isAutomaticError(item: TimelineSourceItem): boolean {
  return item.type === "streamError" ||
    ((item.type === "error" || item.type === "systemError") &&
      isRecord(item.payload) && item.payload.willRetry === true);
}

function sourceItems(
  value: ReplicaJsonValue | undefined,
): readonly TimelineSourceItem[] {
  return array(value).flatMap((candidate): TimelineSourceItem[] => {
    if (!isRecord(candidate)) return [];
    const id = string(candidate.id);
    if (id === null) return [];
    return [
      {
        id,
        type: string(candidate.type) ?? "unknown",
        payload: candidate,
      },
    ];
  });
}

function sourceTurns(
  value: ReplicaJsonValue | undefined,
  cache?: WeakMap<object, TimelineSourceTurn>,
): readonly TimelineSourceTurn[] {
  return array(value).flatMap((candidate): TimelineSourceTurn[] => {
    if (!isRecord(candidate)) return [];
    const cached = cache?.get(candidate);
    if (cached !== undefined) return [cached];
    const id = string(candidate.id) ?? string(candidate.turnId);
    if (id === null) return [];
    const status = turnStatus(candidate.status);
    const startedAtSeconds = number(candidate.startedAt);
    const completedAtSeconds = number(candidate.completedAt);
    const items: TimelineSourceItem[] = [];
    for (const item of sourceItems(candidate.items)) {
      if (isAutomaticError(item)) {
        // Reconnection is live progress, not a permanently animating error in history.
        if (status !== "streaming" && status !== "pending") continue;
        const previous = items.at(-1);
        if (previous && isAutomaticError(previous)) {
          items[items.length - 1] = { ...item, id: previous.id };
          continue;
        }
      }
      items.push(item);
    }
    const turnError = isRecord(candidate.error) ? candidate.error : null;
    if (
      status === "failed" &&
      turnError !== null &&
      !items.some((item) => (item.type === "error" || item.type === "systemError") &&
        (!isRecord(item.payload) || item.payload.willRetry !== true))
    ) {
      items.push({
        id: `${id}:error`,
        type: "error",
        payload: {
          codexErrorInfo: turnError.codexErrorInfo ?? null,
          message: string(turnError.message) ?? "The turn failed",
          additionalDetails: string(turnError.additionalDetails),
        },
      });
    }
    const turn: TimelineSourceTurn = {
        id,
        status,
        startedAtMs:
          number(candidate.startedAtMs) ??
          number(candidate.turnStartedAtMs) ??
          (startedAtSeconds === null ? null : startedAtSeconds * 1_000),
        completedAtMs:
          number(candidate.completedAtMs) ??
          (completedAtSeconds === null ? null : completedAtSeconds * 1_000),
        durationMs: number(candidate.durationMs),
        firstTurnWorkItemStartedAtMs: number(candidate.firstTurnWorkItemStartedAtMs),
        finalAssistantStartedAtMs: number(candidate.finalAssistantStartedAtMs),
        ...(candidate.diff !== undefined || candidate.unifiedDiff !== undefined ? {
          unifiedDiff: candidate.diff !== undefined ? string(candidate.diff) : string(candidate.unifiedDiff),
        } : {}),
        hookStats: summarizeHookRuns(candidate.hookRuns),
        params: candidate.params,
        mcpAppModelContextAttachments: candidate.mcpAppModelContextAttachments,
        preserveServerUserMessages:
          boolean(candidate.preserveServerUserMessages) ?? false,
        items,
    };
    cache?.set(candidate, turn);
    return [turn];
  });
}

interface SourceGuardianApprovalReview {
  readonly reviewId: string;
  readonly turnId: string;
  readonly targetItemId: string | null;
  readonly status: string;
  readonly payload: JsonRecord;
}

function sourceGuardianApprovalReviews(
  value: ReplicaJsonValue | undefined,
): readonly SourceGuardianApprovalReview[] {
  return array(value).flatMap((candidate): SourceGuardianApprovalReview[] => {
    if (!isRecord(candidate)) return [];
    const reviewId = string(candidate.reviewId) ?? string(candidate.id);
    const turnId = string(candidate.turnId);
    const status = string(candidate.status);
    if (reviewId === null || turnId === null || status === null) return [];
    return [
      {
        reviewId,
        turnId,
        targetItemId: string(candidate.targetItemId),
        status,
        payload: candidate,
      },
    ];
  });
}

/** The split phase attaches matched reviews to their reviewed Item. */
function attachGuardianApprovalReviews(
  source: readonly TimelineSourceTurn[],
  reviews: readonly SourceGuardianApprovalReview[],
): readonly TimelineSourceTurn[] {
  if (reviews.length === 0) return source;
  const turns = [...source];
  for (const review of reviews) {
    let turn = turns.find((candidate) => candidate.id === review.turnId);
    if (turn === undefined) {
      if (review.status === "approved") continue;
      turn = { id: asTurnId(review.turnId), status: "pending", items: [] };
      turns.push(turn);
    }
    const index = turns.indexOf(turn);
    turn = { ...turn, items: [...turn.items] };
    turns[index] = turn;
    const items = turn.items as TimelineSourceItem[];
    const targetIndex =
      review.targetItemId === null
        ? -1
        : items.findIndex((item) => item.id === review.targetItemId);
    if (targetIndex >= 0) {
      const target = items[targetIndex]!;
      const payload = isRecord(target.payload as ReplicaJsonValue)
        ? (target.payload as JsonRecord)
        : {};
      items[targetIndex] = {
        ...target,
        payload: {
          ...payload,
          automaticApprovalReviews: [
            ...array(payload.automaticApprovalReviews),
            review.payload,
          ],
        },
      };
      continue;
    }
    // Approved reviews are deliberately invisible; terminal failures without
    // a target remain standalone activity rows.
    if (review.status === "approved") continue;
    items.push({
      id: `automatic-approval-review:${review.reviewId}`,
      type: "automaticApprovalReview",
      payload: review.payload,
    });
  }
  return turns;
}

/**
 * Project every parsed command action as its own exec activity. The
 * synthetic call id is stable while the original Item id remains the source
 * identity so approvals, Guardian reviews and navigation still attach.
 */
function splitCommandExecutionActions(
  source: readonly TimelineSourceTurn[],
): readonly TimelineSourceTurn[] {
  return source.map((turn) => ({
    ...turn,
    items: turn.items.flatMap((item): readonly TimelineSourceItem[] => {
      if (
        item.type !== "commandExecution" ||
        !isRecord(item.payload as ReplicaJsonValue)
      )
        return [item];
      const { __velaSourceItemId: _legacySourceItemId, ...payload } = item.payload as JsonRecord;
      const actions = array(payload.commandActions);
      if (actions.length === 0) return [item];
      return actions.map((action, index) => {
        const actionRecord = isRecord(action) ? action : {};
        const callId = actions.length === 1 ? item.id : `${item.id}:${index}`;
        return {
          id: callId,
          type: item.type,
          payload: {
            ...payload,
            __opencraftSourceItemId: item.id,
            callId,
            commandExecutionItemId: actions.length === 1 ? null : item.id,
            command:
              string(actionRecord.command) ?? string(payload.command) ?? "",
            commandActions: [action],
          },
        };
      });
    }),
  }));
}

const interactionMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "item/tool/call",
  "item/tool/requestOptionPicker",
  "item/tool/requestSetupCodexContextPicker",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
]);

function sourcePendingInteractions(
  value: ReplicaJsonValue | undefined,
): readonly PendingInteraction[] {
  return array(value).flatMap((candidate): PendingInteraction[] => {
    if (!isRecord(candidate)) return [];
    const requestId = string(candidate.requestId);
    const method = string(candidate.method);
    const receivedAtMs = number(candidate.receivedAtMs);
    if (
      requestId === null ||
      method === null ||
      receivedAtMs === null ||
      !interactionMethods.has(method)
    )
      return [];
    if (method === "item/tool/call") {
      const params = isRecord(candidate.params) ? candidate.params : {};
      const tool = string(params.tool);
      if (
        tool !== "request_onboarding_input" &&
        tool !== "request_option_picker" &&
        tool !== "setup_codex_context_picker" &&
        tool !== "setup_codex_step"
      )
        return [];
      if (tool === "setup_codex_step") {
        const args = isRecord(params.arguments) ? params.arguments : {};
        const step = string(args.step);
        if (step !== "role" && step !== "task" && step !== "context") return [];
      }
    }
    return [
      {
        requestId,
        method,
        turnId:
          string(candidate.turnId) === null
            ? null
            : asTurnId(string(candidate.turnId)!),
        itemId: string(candidate.itemId),
        receivedAtMs,
        params: candidate.params,
      } as unknown as PendingInteraction,
    ];
  });
}

function interactionPayload(interaction: PendingInteraction): {
  type: string;
  payload: JsonRecord;
} {
  const params = isRecord(interaction.params as unknown as ReplicaJsonValue)
    ? (interaction.params as unknown as JsonRecord)
    : {};
  switch (interaction.method) {
    case "item/commandExecution/requestApproval": {
      const network = isRecord(params.networkApprovalContext)
        ? params.networkApprovalContext
        : {};
      const networkHost = string(network.host);
      const networkProtocol = string(network.protocol);
      const destination =
        networkHost === null
          ? null
          : networkProtocol === "http" || networkProtocol === "https"
            ? `${networkProtocol}://${networkHost}`
            : networkHost;
      const reason = string(params.reason)?.trim() || null;
      return {
        type: "interaction:approval",
        payload: {
          requestId: interaction.requestId,
          approvalKind: "command",
          title:
            destination === null
              ? (reason ?? "Allow this command to run?")
              : `Allow a connection to ${destination}?`,
          detail:
            destination === null
              ? string(params.command)
              : `${networkHost} isn't on the current network allowlist`,
          command: string(params.command),
          cwd: string(params.cwd),
          reason,
          networkApprovalContext: params.networkApprovalContext ?? null,
          proposedExecpolicyAmendment:
            params.proposedExecpolicyAmendment ?? null,
          proposedNetworkPolicyAmendments:
            params.proposedNetworkPolicyAmendments ?? null,
          additionalPermissions: params.additionalPermissions ?? null,
          availableDecisions: array(params.availableDecisions).filter(
            (value): value is string => typeof value === "string",
          ),
          ...(params.approvalScopes === undefined ? {} : { approvalScopes: params.approvalScopes }),
          state: "pending",
          method: interaction.method,
          itemId: interaction.itemId,
        },
      };
    }
    case "item/fileChange/requestApproval":
      return {
        type: "interaction:approval",
        payload: {
          requestId: interaction.requestId,
          approvalKind: "file-change",
          title: "Allow file changes?",
          detail: string(params.reason) ?? string(params.grantRoot),
          reason: string(params.reason),
          grantRoot: string(params.grantRoot),
          state: "pending",
          method: interaction.method,
          itemId: interaction.itemId,
        },
      };
    case "item/permissions/requestApproval": {
      const requestedPermissions = isRecord(params.permissions)
        ? params.permissions
        : {};
      return {
        type: "interaction:approval",
        payload: {
          requestId: interaction.requestId,
          approvalKind: "permissions",
          title:
            requestedPermissions.network !== null &&
            requestedPermissions.network !== undefined
              ? "Allow OpenCraft to connect to the internet?"
              : "Allow additional access?",
          detail: string(params.reason) ?? string(params.cwd),
          reason: string(params.reason),
          cwd: string(params.cwd),
          permissions: params.permissions ?? null,
          state: "pending",
          method: interaction.method,
          itemId: interaction.itemId,
        },
      };
    }
    case "item/tool/requestUserInput": {
      const questions = array(params.questions).flatMap(
        (candidate): ReplicaJsonValue[] => {
          if (!isRecord(candidate)) return [];
          const options = array(candidate.options).flatMap(
            (option): ReplicaJsonValue[] => {
              if (!isRecord(option)) return [];
              const label = string(option.label) ?? "";
              return [
                { id: label, label, description: string(option.description) },
              ];
            },
          );
          return [
            {
              id: string(candidate.id) ?? "",
              header: string(candidate.header),
              prompt: string(candidate.question) ?? "Input required",
              ...userInputQuestionExtensions(candidate),
              options,
              isOther: boolean(candidate.isOther) ?? false,
              isSecret: boolean(candidate.isSecret) ?? false,
            },
          ];
        },
      );
      return {
        type: "interaction:question",
        payload: {
          requestId: interaction.requestId,
          questions,
          state: "pending",
          method: interaction.method,
          itemId: interaction.itemId,
        },
      };
    }
    case "item/tool/call": {
      const dynamicArguments = isRecord(params.arguments)
        ? params.arguments
        : {};
      const tool = string(params.tool);
      if (tool === "request_onboarding_input") {
        const questions = array(dynamicArguments.questions).flatMap(
          (candidate): ReplicaJsonValue[] => {
            if (!isRecord(candidate)) return [];
            const options = array(candidate.options).flatMap(
              (option): ReplicaJsonValue[] => {
                if (!isRecord(option)) return [];
                const label = string(option.label) ?? "";
                return [
                  { id: label, label, description: string(option.description) },
                ];
              },
            );
            return [
              {
                id: string(candidate.id) ?? "",
                header: string(candidate.header),
                prompt: string(candidate.question) ?? "Input required",
              ...userInputQuestionExtensions(candidate),
                options,
                isOther: true,
                isSecret: false,
              },
            ];
          },
        );
        return {
          type: "interaction:question",
          payload: {
            requestId: interaction.requestId,
            questions,
            onboarding: true,
            state: "pending",
            method: interaction.method,
            itemId: interaction.itemId,
          },
        };
      }
      if (tool === "setup_codex_step")
        return {
          type: "interaction:setup-step",
          payload: {
            requestId: interaction.requestId,
            step: string(dynamicArguments.step),
            state: "pending",
            method: interaction.method,
            itemId: interaction.itemId,
          },
        };
      if (tool === "setup_codex_context_picker")
        return {
          type: "interaction:setup-context-picker",
          payload: {
            requestId: interaction.requestId,
            state: "pending",
            method: interaction.method,
            itemId: interaction.itemId,
          },
        };
      const options = array(dynamicArguments.options).flatMap(
        (option): ReplicaJsonValue[] => {
          if (!isRecord(option)) return [];
          const label = string(option.label);
          return label === null
            ? []
            : [{ id: label, label, description: string(option.description) }];
        },
      );
      return {
        type: "interaction:option-picker",
        payload: {
          requestId: interaction.requestId,
          question: string(dynamicArguments.question) ?? "Choose an option",
          options,
          allowMultiple: boolean(dynamicArguments.allowMultiple) ?? false,
          submitLabel: string(dynamicArguments.submitLabel),
          skipLabel: string(dynamicArguments.skipLabel),
          state: "pending",
          method: interaction.method,
          itemId: interaction.itemId,
        },
      };
    }
    case "item/tool/requestOptionPicker": {
      const options = array(params.options).flatMap(
        (option): ReplicaJsonValue[] => {
          if (!isRecord(option)) return [];
          const label = string(option.label);
          return label === null
            ? []
            : [{ id: label, label, description: string(option.description) }];
        },
      );
      return {
        type: "interaction:option-picker",
        payload: {
          requestId: interaction.requestId,
          question: string(params.question) ?? "Choose an option",
          options,
          allowMultiple: boolean(params.allowMultiple) ?? false,
          submitLabel: string(params.submitLabel),
          skipLabel: string(params.skipLabel),
          state: "pending",
          method: interaction.method,
          itemId: interaction.itemId,
        },
      };
    }
    case "item/tool/requestSetupCodexContextPicker":
      return {
        type: "interaction:setup-context-picker",
        payload: {
          requestId: interaction.requestId,
          state: "pending",
          method: interaction.method,
          itemId: interaction.itemId,
        },
      };
    case "mcpServer/elicitation/request":
      return {
        type: "interaction:elicitation",
        payload: {
          requestId: interaction.requestId,
          serverName: string(params.serverName),
          message: string(params.message) ?? "MCP server requests input",
          mode: string(params.mode) ?? "form",
          requestedSchema: params.requestedSchema ?? null,
          url: string(params.url),
          elicitationId: string(params.elicitationId),
          _meta: params._meta ?? null,
          state: "pending",
          method: interaction.method,
          itemId: interaction.itemId,
        },
      };
  }
}

function quoteShellToken(value: string): string {
  if (/^[A-Za-z0-9_@+=:,./-]+$/u.test(value)) return value;
  if (!/[`$\\!]/u.test(value) && !value.includes('"')) return `"${value}"`;
  if (value.length === 0) return "''";
  if (!/[^\w@%\-+=:,./]/u.test(value)) return value;
  return `'${value.replace(/('+)/gu, `'"$1"'`)}'`.replace(/^''|''$/gu, "");
}

function joinCommandTokens(value: ReplicaJsonValue | undefined): string {
  return array(value)
    .filter((token): token is string => typeof token === "string")
    .map(quoteShellToken)
    .join(" ");
}

/**
 * A command approval can arrive before its commandExecution Item. Avoid a
 * visually orphaned approval in that interval by deriving one
 * unfinished exec row from the request itself. Keep that row view-only and
 * keyed by itemId so the authoritative Item can replace it without mutating
 * Replica state.
 *
 * Pending approvals intentionally expose only the first parsed action. This
 * is the pending-request display contract; the authoritative
 * commandExecution Item may fan out into every action after execution starts.
 */
function provisionalCommandApprovalItem(
  interaction: PendingInteraction,
): TimelineSourceItem | null {
  if (
    interaction.method !== "item/commandExecution/requestApproval" ||
    interaction.itemId === null
  )
    return null;
  const params = isRecord(interaction.params as unknown as ReplicaJsonValue)
    ? (interaction.params as unknown as JsonRecord)
    : {};
  const actions = array(params.commandActions).filter(isRecord);
  const actionCommands = actions.flatMap((action): string[] => {
    const command = string(action.command);
    return command === null ? [] : [command];
  });
  const fallbackCommand =
    string(params.command) ??
    joinCommandTokens(params.proposedExecpolicyAmendment);
  const command =
    actionCommands.length > 0 ? actionCommands.join(" && ") : fallbackCommand;
  const firstAction = actions[0] ?? { type: "unknown", command };
  return {
    id: interaction.itemId,
    type: "commandExecution",
    payload: {
      id: interaction.itemId,
      type: "commandExecution",
      command,
      cwd: string(params.cwd),
      startedAtMs: number(params.startedAtMs),
      processId: null,
      commandActions: [firstAction],
      status: "inProgress",
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
      approvalRequestId: interaction.requestId,
      approvalReason: string(params.reason),
      networkApprovalContext: params.networkApprovalContext ?? null,
      proposedNetworkPolicyAmendments:
        params.proposedNetworkPolicyAmendments ?? null,
      proposedExecpolicyAmendment: params.proposedExecpolicyAmendment ?? null,
      __opencraftProvisionalApproval: true,
    },
  };
}

function attachPendingInteractions(
  source: readonly TimelineSourceTurn[],
  interactions: readonly PendingInteraction[],
): readonly TimelineSourceTurn[] {
  if (interactions.length === 0) return source;
  const turns = [...source];
  for (const interaction of interactions) {
    const targetTurnId =
      interaction.turnId ?? asTurnId(`interaction:${interaction.requestId}`);
    let turn = turns.find((candidate) => candidate.id === targetTurnId);
    if (turn === undefined) {
      turn = { id: targetTurnId, status: "pending", items: [] };
      turns.push(turn);
    }
    const index = turns.indexOf(turn);
    turn = { ...turn, items: [...turn.items] };
    turns[index] = turn;
    const items = turn.items as TimelineSourceItem[];
    const provisionalCommand = provisionalCommandApprovalItem(interaction);
    if (
      provisionalCommand !== null &&
      !items.some(
        (item) =>
          item.id === provisionalCommand.id && item.type === "commandExecution",
      )
    ) {
      items.push(provisionalCommand);
    }
    const projected = interactionPayload(interaction);
    items.push({
      id: `server-request:${interaction.requestId}`,
      type: projected.type,
      payload: projected.payload,
    });
  }
  return turns;
}

function assertIntentTarget(key: ConversationKey, intent: SubmitIntent): void {
  const target = intent.target;
  if (target.type === "new-thread") {
    if (target.execution.hostId !== key.hostId) {
      throw new Error("SubmitIntent targets a different Host");
    }
    return;
  }
  if (
    target.key.hostId !== key.hostId ||
    target.key.threadId !== key.threadId
  ) {
    throw new Error("SubmitIntent targets a different Conversation");
  }
}

function queuedInputPreview(input: readonly UserInput[]): string {
  return (
    input
      .flatMap((item) => {
        switch (item.type) {
          case "text":
            return [item.text];
          case "skill":
            return [`$${item.name}`];
          case "mention":
            return [`@${item.name}`];
          case "image":
          case "localImage":
            return ["Image attachment"];
          case "audio":
          case "localAudio":
            return ["Audio attachment"];
        }
      })
      .join(" ")
      .trim() || "Follow-up"
  );
}

interface OptimisticSubmissionState extends PendingSubmission {
  readonly kind: "turn" | "steer";
  readonly targetTurnId: TurnId | null;
  /**
   * Authoritative Turn that immediately preceded this local Turn when the
   * submission crossed the Composer boundary. `null` is a resolved beginning
   * of transcript; `undefined` means the initial Resume baseline has not
   * arrived yet and placement must remain append-only until it does.
   */
  readonly predecessorTurnId: string | null | undefined;
  readonly input: readonly UserInput[];
  readonly attachments: SubmitIntent["attachments"];
}

function optimisticInput(intent: SubmitIntent): readonly UserInput[] {
  const input: UserInput[] = [];
  const text = composerDocumentToPlainText(intent.document);
  if (text.length > 0) input.push({ type: "text", text, text_elements: [] });
  for (const attachment of intent.attachments) {
    if (attachment.uri === null) continue;
    let localPath: string | null = null;
    if (attachment.uri.startsWith("file://")) {
      try {
        localPath = decodeURIComponent(
          attachment.uri.slice("file://".length),
        );
      } catch {
        localPath = attachment.uri.slice("file://".length);
      }
    } else if (attachment.uri.startsWith("/")) {
      localPath = attachment.uri;
    }
    if (attachment.mimeType.startsWith("image/")) {
      input.push(
        localPath === null
          ? { type: "image", url: attachment.uri }
          : { type: "localImage", path: localPath },
      );
    } else if (attachment.mimeType.startsWith("audio/")) {
      input.push(
        localPath === null
          ? { type: "audio", url: attachment.uri }
          : { type: "localAudio", path: localPath },
      );
    }
  }
  return input;
}

function sourceClientMessageIds(turns: readonly TimelineSourceTurn[]): Set<string> {
  const ids = new Set<string>();
  for (const turn of turns) {
    const params = isRecord(turn.params as ReplicaJsonValue)
      ? (turn.params as JsonRecord)
      : {};
    const paramsId =
      string(params.clientUserMessageId) ?? string(params.clientId);
    if (paramsId !== null) ids.add(paramsId);
    for (const item of turn.items) {
      if (!isRecord(item.payload as ReplicaJsonValue)) continue;
      const payload = item.payload as JsonRecord;
      const itemId =
        string(payload.clientUserMessageId) ?? string(payload.clientId);
      if (itemId !== null) ids.add(itemId);
    }
  }
  return ids;
}

function authoritativeUserMessageVisible(
  turn: TimelineSourceTurn,
  state: OptimisticSubmissionState,
): boolean {
  const params = isRecord(turn.params as ReplicaJsonValue) ? turn.params as JsonRecord : {};
  const paramsId = string(params.clientUserMessageId) ?? string(params.clientId);
  const paramsInput = params.input;
  if (paramsId === state.clientMessageId
    && (Array.isArray(paramsInput) ? paramsInput.length > 0 : paramsInput != null)) return true;
  return turn.items.some((item) => {
    if (item.type !== "userMessage" || !isRecord(item.payload as ReplicaJsonValue)) return false;
    const payload = item.payload as JsonRecord;
    return (string(payload.clientUserMessageId) ?? string(payload.clientId)) === state.clientMessageId;
  });
}

function sameUserMessageInput(left: unknown, right: unknown): boolean {
  const leftKey = userMessageCompareKey(left);
  const rightKey = userMessageCompareKey(right);
  return leftKey.rawText === rightKey.rawText
    && leftKey.imageCount === rightKey.imageCount;
}

function steeringAcknowledgementIndex(
  turn: TimelineSourceTurn,
  state: OptimisticSubmissionState,
): number {
  return turn.items.findIndex((candidate, index) => {
    if (candidate.type !== "userMessage" || !isRecord(candidate.payload as ReplicaJsonValue)) return false;
    const payload = candidate.payload as JsonRecord;
    const clientId = string(payload.clientId) ?? string(payload.clientUserMessageId);
    if (clientId !== null) return clientId === state.clientMessageId;
    // Reconstructed Hermes history can omit client ids. Only compare content
    // after the Turn has crossed an assistant-owned boundary, otherwise a
    // repeated steer could steal the primary Composer message.
    const followsAssistantOutput = turn.items.slice(0, index).some((item) =>
      item.type !== "userMessage"
      && item.type !== "steeringUserMessage"
      && item.type !== "hookPrompt");
    return followsAssistantOutput
      && sameUserMessageInput(payload.content ?? payload.input, state.input);
  });
}

function optimisticItem(state: OptimisticSubmissionState): TimelineSourceItem {
  return {
    id: `optimistic-user:${state.clientMessageId}`,
    type: state.kind === "steer" ? "steeringUserMessage" : "userMessage",
    payload: {
      id: `optimistic-user:${state.clientMessageId}`,
      type: state.kind === "steer" ? "steeringUserMessage" : "userMessage",
      content: [...state.input],
      input: [...state.input],
      clientId: state.clientMessageId,
      clientUserMessageId: state.clientMessageId,
      attachments: [...state.attachments],
      status: state.state === "failed"
        ? "cancelled"
        : state.state === "accepted"
          ? "accepted"
          : "pending",
      deliveryStatus:
        state.state === "unknown" ? "unknown" : state.state === "failed"
          ? "failed"
          : state.state === "accepted"
            ? "sent"
            : "sending",
      sentAtMs: state.createdAt,
    },
  };
}

function mergeOptimisticSubmissions(
  turns: readonly TimelineSourceTurn[],
  submissions: Iterable<OptimisticSubmissionState>,
): readonly TimelineSourceTurn[] {
  const states = [...submissions];
  if (states.length === 0) return turns;
  const result = [...turns];
  const writable = (id: string) => {
    const index = result.findIndex(turn => String(turn.id) === id);
    if (index < 0) return undefined;
    const turn = { ...result[index]!, items: [...result[index]!.items] };
    result[index] = turn;
    return turn;
  };
  const turnIds = new Set(turns.map((turn) => String(turn.id)));
  const localTurns: Array<{
    readonly state: OptimisticSubmissionState;
    readonly turn: TimelineSourceTurn;
  }> = [];
  for (const state of states) {
    // A steer response returns the already-active Turn id. That is only a
    // target binding, never acknowledgement of this user message. Keep the
    // local steering item as display owner until the Turn settles; the server
    // UserMessage is then joined to it by client id/compare key.
    const authoritativeTurn = state.kind === "turn"
      ? authoritativeTurnForSubmission(turns, state)
      : undefined;
    if (authoritativeTurn !== undefined && authoritativeUserMessageVisible(authoritativeTurn, state)) {
      continue;
    }
    const item = optimisticItem(state);
    if (authoritativeTurn !== undefined && state.kind === "turn") {
      const target = writable(String(authoritativeTurn.id));
      if (target !== undefined) target.items.unshift(item);
      continue;
    }
    if (state.kind === "steer") {
      const target = writable(String(state.targetTurnId));
      if (target !== undefined) {
        const acknowledgementIndex = steeringAcknowledgementIndex(target, state);
        const nextItems = [...target.items];
        if (acknowledgementIndex < 0) nextItems.push(item);
        else nextItems.splice(acknowledgementIndex, 0, item);
        target.items = nextItems;
      }
      continue;
    }
    const errorItem: TimelineSourceItem[] =
      state.state === "failed"
        ? [
            {
              id: `optimistic-error:${state.commandId}`,
              type: "error",
              payload: {
                message: state.error?.message ?? "Error submitting message",
              },
            },
          ]
        : [];
    localTurns.push({
      state,
      turn: {
        id: state.turnId ?? asTurnId(`optimistic:${state.commandId}`),
        status: state.state === "failed" ? "failed" : "pending",
        startedAtMs: state.createdAt,
        params: {
          clientUserMessageId: state.clientMessageId,
          input: [...state.input],
          attachments: [...state.attachments],
        },
        items: [item, ...errorItem],
      },
    });
  }

  // Transcript order is causal, not source-grouped. A failed local Turn stays
  // at the boundary where it was submitted even after a later Turn moves from
  // the optimistic projection into authoritative history. Grouping every
  // local Turn after every authoritative Turn makes an acknowledgement visibly
  // jump backwards across older failures.
  const beforeFirst: TimelineSourceTurn[] = [];
  const afterTurn = new Map<string, TimelineSourceTurn[]>();
  const unresolved: typeof localTurns = [];
  for (const candidate of localTurns) {
    const predecessor = candidate.state.predecessorTurnId;
    if (predecessor === null) {
      beforeFirst.push(candidate.turn);
    } else if (predecessor !== undefined && turnIds.has(predecessor)) {
      const group = afterTurn.get(predecessor) ?? [];
      group.push(candidate.turn);
      afterTurn.set(predecessor, group);
    } else {
      unresolved.push(candidate);
    }
  }

  const ordered: TimelineSourceTurn[] = [...beforeFirst];
  for (const turn of result) {
    ordered.push(turn);
    ordered.push(...(afterTurn.get(String(turn.id)) ?? []));
  }
  for (const candidate of unresolved) {
    const insertionIndex = ordered.findIndex(
      (turn) => turn.startedAtMs !== null
        && turn.startedAtMs !== undefined
        && turn.startedAtMs > candidate.state.createdAt,
    );
    if (insertionIndex < 0) ordered.push(candidate.turn);
    else ordered.splice(insertionIndex, 0, candidate.turn);
  }
  return ordered;
}

function resolveOptimisticTurnPlacements(
  turns: readonly TimelineSourceTurn[],
  authoritative: boolean,
  submissions: Map<string, OptimisticSubmissionState>,
): void {
  if (!authoritative) return;
  const predecessorTurnId = turns.at(-1)?.id ?? null;
  for (const [commandId, state] of submissions) {
    if (state.kind !== "turn" || state.predecessorTurnId !== undefined) continue;
    submissions.set(commandId, { ...state, predecessorTurnId });
  }
}

function authoritativeTurnForSubmission(
  turns: readonly TimelineSourceTurn[],
  state: OptimisticSubmissionState,
): TimelineSourceTurn | undefined {
  if (state.kind !== "turn") return undefined;
  return turns.find((turn) =>
    sourceClientMessageIds([turn]).has(state.clientMessageId)
    || (state.turnId !== null && String(turn.id) === String(state.turnId))
  );
}

/**
 * Move the insertion boundary forward when an older local Turn acquires its
 * authoritative identity. Several rapid submissions can share the same
 * predecessor because the Replica has not painted the earlier acknowledgement
 * yet. Map insertion order is their causal order; acknowledgement may replace
 * a slot, but it must never let a later local slot cross that slot.
 */
function rebaseOptimisticTurnPlacements(
  turns: readonly TimelineSourceTurn[],
  submissions: Map<string, OptimisticSubmissionState>,
): void {
  let latestAcknowledgedTurnId: string | null = null;
  for (const [commandId, state] of submissions) {
    if (state.kind !== "turn") continue;
    const authoritativeTurn = authoritativeTurnForSubmission(turns, state);
    if (authoritativeTurn !== undefined) {
      latestAcknowledgedTurnId = String(authoritativeTurn.id);
      continue;
    }
    if (
      latestAcknowledgedTurnId !== null
      && state.predecessorTurnId !== latestAcknowledgedTurnId
    ) {
      submissions.set(commandId, {
        ...state,
        predecessorTurnId: latestAcknowledgedTurnId,
      });
    }
  }
}

function pruneAcknowledgedSubmissions(
  turns: readonly TimelineSourceTurn[],
  submissions: Map<string, OptimisticSubmissionState>,
  confirmedSteers: Map<string, OptimisticSubmissionState>,
): void {
  if (submissions.size === 0) return;
  const clientIds = sourceClientMessageIds(turns);
  for (const [commandId, state] of submissions) {
    if (state.state !== "accepted" && state.state !== "unknown") continue;
    const target = state.targetTurnId === null
      ? undefined
      : turns.find((turn) => String(turn.id) === String(state.targetTurnId));
    const acknowledged = state.kind === "steer"
      ? target !== undefined && steeringAcknowledgementIndex(target, state) >= 0
      : clientIds.has(state.clientMessageId);
    const targetSettled = target !== undefined
      && target.status !== "streaming"
      && target.status !== "pending";
    if (
      (state.kind === "turn" && acknowledged
        && turns.some((turn) => authoritativeUserMessageVisible(turn, state)))
    ) {
      submissions.delete(commandId);
    } else if (state.kind === "steer" && acknowledged && targetSettled) {
      // The authoritative Turn keeps an accepted steering item permanently;
      // only its pending-command bookkeeping retires when that Turn settles.
      confirmedSteers.set(commandId, state);
      submissions.delete(commandId);
    }
  }
}

function reconcileSteeringAcknowledgements(
  turns: readonly TimelineSourceTurn[],
  submissions: Map<string, OptimisticSubmissionState>,
): void {
  for (const [commandId, state] of submissions) {
    if (state.kind !== "steer" || state.targetTurnId === null) continue;
    const target = turns.find((turn) => String(turn.id) === String(state.targetTurnId));
    if (target === undefined || steeringAcknowledgementIndex(target, state) < 0) continue;
    if (state.state === "accepted" && state.error === null) continue;
    submissions.set(commandId, { ...state, state: "accepted", error: null });
  }
}

/** Only this runtime's exact client-message identities may borrow local display metadata.
 * Explicit server attribution (including null) always wins. No history is inferred
 * from the currently selected account, message text, or a Turn's position. */
function withLocalSubmissionSenders(
  turns: readonly TimelineSourceTurn[],
  senders: ReadonlyMap<string, MessageSender>,
): readonly TimelineSourceTurn[] {
  if (senders.size === 0) return turns;
  const enrich = (value: unknown) => {
    if (!isRecord(value)) return value;
    const id = string(value.clientUserMessageId) ?? string(value.clientId);
    const sender = id === null ? undefined : senders.get(id);
    return sender && value.sender === undefined ? { ...value, sender: { ...sender } } : value;
  };
  return turns.map(turn => {
    const params = isRecord(turn.params) ? turn.params : {};
    const paramsId = string(params.clientUserMessageId) ?? string(params.clientId);
    // Normalization can coalesce Turn input with a matching server Item. Do not
    // let a local Turn hint override explicit server absence on that Item.
    const hasServerSender = paramsId !== null && turn.items.some(item => {
      if (item.type !== "userMessage" && item.type !== "steeringUserMessage") return false;
      const payload = isRecord(item.payload) ? item.payload : {};
      return (string(payload.clientUserMessageId) ?? string(payload.clientId)) === paramsId
        && payload.sender !== undefined;
    });
    const nextParams = (hasServerSender ? turn.params : enrich(turn.params)) as TimelineSourceTurn["params"];
    const items = turn.items.map(item => {
      if (item.type !== "userMessage" && item.type !== "steeringUserMessage") return item;
      const payload = isRecord(item.payload) ? item.payload : {};
      const id = string(payload.clientUserMessageId) ?? string(payload.clientId);
      if (id === paramsId && params.sender !== undefined) return item;
      const nextPayload = enrich(item.payload) as TimelineSourceItem["payload"];
      return nextPayload === item.payload ? item : { ...item, payload: nextPayload };
    });
    return nextParams === turn.params && items.every((item, index) => item === turn.items[index])
      ? turn : { ...turn, params: nextParams, items };
  });
}

export function createReplicaConversationRuntime(
  config: ReplicaConversationRuntimeConfig,
): ConversationRuntime {
  const projectors =
    config.projectors ?? createDefaultTimelineProjectorRegistry();
  const sourceTurnCache = new WeakMap<object, TimelineSourceTurn>();
  const actionTurnCache = new WeakMap<TimelineSourceTurn, TimelineSourceTurn>();
  const senderTurnCache = new WeakMap<TimelineSourceTurn, { revision: number; turn: TimelineSourceTurn }>();
  let senderRevision = 0;
  const projectSenders = (source: readonly TimelineSourceTurn[]) => source.map(turn => {
    const cached = senderTurnCache.get(turn);
    if (cached?.revision === senderRevision) return cached.turn;
    const projected = withLocalSubmissionSenders([turn], submissionSenders)[0]!;
    senderTurnCache.set(turn, { revision: senderRevision, turn: projected });
    return projected;
  });
  const projectActions = (source: readonly TimelineSourceTurn[]) => source.map(turn => {
    const cached = actionTurnCache.get(turn);
    if (cached !== undefined) return cached;
    const projected = splitCommandExecutionActions([turn])[0]!;
    actionTurnCache.set(turn, projected);
    return projected;
  });
  const listeners = new Set<() => void>();
  const queued = new Map<string, QueuedSubmission>();
  const submissionSenders = new Map<string, MessageSender>();
  const pendingSubmissions = new Map<string, OptimisticSubmissionState>();
  const confirmedSteers = new Map<string, OptimisticSubmissionState>();
  const authoritativeSteers = new Map<string, OptimisticSubmissionState>();
  const steeringClaims = new Map<string, ProtocolSteeringSubmission>();
  const authoritativeQueue = new Map<string, QueuedSubmission>();
  let pendingQueueOrder: readonly string[] | null = null;
  let localRevision = 0;
  let loadingOlder = false;
  let historyError: Error | null = null;
  let interruptingTurnId: TurnId | null = null;
  const interruptions = new Map<TurnId, Promise<void>>();
  // The statement "You stopped" belongs to this client's command intent,
  // not every remote/interrupted Turn. Never persist it as a server fact.
  const interruptedByThisClient = new Set<string>();
  const interruptedTurns = new WeakMap<TimelineSourceTurn, TimelineSourceTurn>();
  const recoveredHistoryTurns = new WeakMap<TimelineSourceTurn, TimelineSourceTurn>();
  let disposed = false;
  let snapshot: ConversationRuntimeSnapshot;
  let continuationPending = false;
  let continuationError: Error | null = null;
  let continuedFromTurnId: string | null = null;
  let capacityRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let capacityRetrySource: TurnId | null = null;
  let capacityRetryDispatched: TurnId | null = null;
  let capacityRetryAttempt = 0;

  const clearCapacityRetryTimer = () => {
    if (capacityRetryTimer !== null) clearTimeout(capacityRetryTimer);
    capacityRetryTimer = null;
    capacityRetrySource = null;
  };
  const resetCapacityRetry = () => {
    clearCapacityRetryTimer();
    capacityRetryDispatched = null;
    capacityRetryAttempt = 0;
  };
  const scheduleCapacityRetry = () => {
    const source = snapshot.continuation.turnId;
    if (disposed || !config.canAutoContinueCapacity?.() || source === null || snapshot.queuedSubmissions.length > 0) {
      clearCapacityRetryTimer();
      return;
    }
    if (capacityRetryDispatched === source || capacityRetrySource === source) return;
    clearCapacityRetryTimer();
    capacityRetrySource = source;
    const delayMs = Math.min(1_000 * 2 ** Math.min(capacityRetryAttempt, 7), 120_000);
    capacityRetryTimer = setTimeout(() => {
      capacityRetryTimer = null;
      capacityRetrySource = null;
      if (disposed || !config.canAutoContinueCapacity?.() || snapshot.continuation.turnId !== source
        || snapshot.queuedSubmissions.length > 0) return;
      capacityRetryDispatched = source;
      capacityRetryAttempt += 1;
      void continueTurnImpl(source).catch(() => undefined);
    }, delayMs);
  };

  async function continueTurnImpl(turnId: TurnId): Promise<SubmissionReceipt> {
    if (disposed || snapshot.continuation.turnId !== turnId) {
      throw new Error("This turn cannot be continued in the current conversation state");
    }
    clearCapacityRetryTimer();
    capacityRetryDispatched = turnId;
    continuationPending = true;
    continuationError = null;
    localRevision += 1;
    publish();
    try {
      const receipt = await config.commands.continueTurn(config.key, turnId);
      continuedFromTurnId = turnId;
      return receipt;
    } catch (cause) {
      if (!(cause instanceof ContinuationCommandError) || cause.outcome === "unknown") {
        continuedFromTurnId = turnId;
      }
      continuationError = cause instanceof Error ? cause : new Error(String(cause));
      throw cause;
    } finally {
      continuationPending = false;
      localRevision += 1;
      publish();
    }
  }

  let outbox: ReturnType<typeof createConversationOutbox> | undefined;
  const derive = (): ConversationRuntimeSnapshot => {
    const replica = config.replica.getSnapshot();
    const entity = replica.entities.get(config.key.threadId);
    const view = isRecord(entity) ? entity : {};
    const thread = isRecord(view.thread) ? view.thread : {};
    const execution = isRecord(view.execution) ? view.execution : {};
    const activePermissionProfile = isRecord(execution.activePermissionProfile)
      ? string(execution.activePermissionProfile.id)
      : string(execution.activePermissionProfile);
    const pendingInteractions = sourcePendingInteractions(
      view.pendingInteractions,
    );
    const history = sourceTurns(view.turns ?? thread.turns, sourceTurnCache);
    const source = history.map((original, index) => {
      let turn = original;
      // Native history may retain inProgress across a process restart. Only
      // a later authoritative Turn proves it has been superseded. Thread status
      // travels independently and may still be idle when a new Turn starts.
      if (replica.authoritative && turn.status === "streaming" &&
        index < history.length - 1) {
        let recovered = recoveredHistoryTurns.get(original);
        if (!recovered) {
          recovered = { ...original, status: "interrupted", items: original.items.filter(item => !isAutomaticError(item)) };
          recoveredHistoryTurns.set(original, recovered);
        }
        turn = recovered;
      }
      if (!interruptedByThisClient.has(turn.id)) return turn;
      let interrupted = interruptedTurns.get(turn);
      if (!interrupted) { interrupted = { ...turn, interruptedByThisClient: true }; interruptedTurns.set(turn, interrupted); }
      return interrupted;
    });
    if (replica.authoritative && queued.size > 0) {
      const acknowledgedClientIds = sourceClientMessageIds(source);
      for (const [commandId, submission] of queued) {
        if (submission.state === "unknown" && acknowledgedClientIds.has(submission.clientMessageId)) {
          queued.delete(commandId);
        }
      }
    }
    if (replica.authoritative) outbox?.reconcile(new Set([
      ...sourceClientMessageIds(source), ...[...authoritativeQueue.values()].map(item => item.clientMessageId),
    ]));
    resolveOptimisticTurnPlacements(
      source,
      replica.authoritative,
      pendingSubmissions,
    );
    rebaseOptimisticTurnPlacements(source, pendingSubmissions);
    reconcileSteeringAcknowledgements(source, pendingSubmissions);
    pruneAcknowledgedSubmissions(source, pendingSubmissions, confirmedSteers);
    const locallyOwnedClientIds = new Set([
      ...confirmedSteers.values(),
      ...pendingSubmissions.values(),
    ].map((submission) => submission.clientMessageId));
    const visibleAuthoritativeSteers = [...authoritativeSteers.values()].filter((submission) => {
      if (locallyOwnedClientIds.has(submission.clientMessageId)) return false;
      const target = submission.targetTurnId === null
        ? undefined
        : source.find((turn) => String(turn.id) === String(submission.targetTurnId));
      return target === undefined || steeringAcknowledgementIndex(target, submission) < 0;
    });
    const reviewedTurns = attachGuardianApprovalReviews(
      projectSenders(mergeOptimisticSubmissions(source, [
        ...confirmedSteers.values(),
        ...pendingSubmissions.values(),
        ...visibleAuthoritativeSteers,
      ])),
      sourceGuardianApprovalReviews(view.guardianApprovalReviews),
    );
    const turns = projectActions(
      attachPendingInteractions(reviewedTurns, pendingInteractions),
    );
    const timeline = projectTimeline(
      {
        key: config.key,
        revision: replica.revision,
        phase: phase(replica.phase),
        authoritative: replica.authoritative,
        turns,
      },
      projectors,
    );
    const turnsPagination = isRecord(view.turnsPagination)
      ? view.turnsPagination
      : {};
    const active = [...turns]
      .reverse()
      .find((turn) => turn.status === "streaming" || turn.status === "pending");
    const error = replica.lastError;
    const latest = source.at(-1);
    if (replica.authoritative && latest && continuedFromTurnId !== null &&
      latest.id !== continuedFromTurnId) {
      continuedFromTurnId = null;
      continuationError = null;
    }
    // Codex offers empty-turn continuation for overload, not arbitrary failures
    // (e.g. missing credentials). Eligibility is runtime policy, not banner style.
    const recoverableFailure = timeline.frames.some((frame) =>
      frame.turnId === latest?.id && frame.blocks.some((block) =>
        block.type === "error" && block.recovery === "terminal" &&
        block.code === "serverOverloaded"));
    const threadActive = isRecord(thread.status) && thread.status.type === "active";
    const canContinue = replica.authoritative && replica.phase === "live" &&
      error === null && !threadActive && active === undefined &&
      !continuationPending && pendingSubmissions.size === 0 &&
      pendingInteractions.length === 0 &&
      recoverableFailure && latest?.status === "failed" && latest.id !== continuedFromTurnId;
    const localOutbox = outbox?.project() ?? [];
    return {
      key: config.key,
      revision: replica.revision + localRevision,
      phase: error === null ? phase(replica.phase) : "error",
      authoritative: replica.authoritative,
      title: string(thread.name) ?? string(thread.title),
      threadStatus: thread.status ?? null,
      execution: {
        model: string(execution.model),
        effort: string(execution.reasoningEffort),
        serviceTier: string(execution.serviceTier),
        permissionProfile: activePermissionProfile,
        cwd: string(execution.cwd) ?? string(thread.cwd),
        runtimeWorkspaceRoots: stringArray(execution.runtimeWorkspaceRoots),
      },
      timeline,
      continuation: {
        turnId: canContinue ? asTurnId(latest!.id) : null,
        pending: continuationPending,
        error: continuationError,
      },
      activeTurn:
        active === undefined
          ? null
          : {
              turnId: asTurnId(active.id),
              status:
                interruptingTurnId === active.id
                  ? "interrupting"
                  : active.status === "streaming"
                    ? "streaming"
                    : "pending",
            },
      pendingInteractions,
      pendingSubmissions: [...pendingSubmissions.values()].map(
        ({
          kind: _kind,
          targetTurnId: _targetTurnId,
          predecessorTurnId: _predecessorTurnId,
          input: _input,
          attachments: _attachments,
          ...submission
        }) =>
          submission,
      ),
      queuedSubmissions: [
        ...localOutbox,
        ...authoritativeQueue.values(),
        ...[...queued.values()].filter(
          (candidate) =>
            !localOutbox.some(item => item.commandId === candidate.commandId) &&
            ![...authoritativeQueue.values()].some(
              (authoritative) =>
                authoritative.clientMessageId === candidate.clientMessageId,
            ),
        ),
      ].map((submission) => {
        const sender = submissionSenders.get(submission.clientMessageId);
        return submission.sender === undefined && sender ? { ...submission, sender: { ...sender } } : submission;
      }),
      unconfirmedSteers: [...steeringClaims.values()].filter(
        (item) => item.pausedReason === "steer-delivery-unconfirmed",
      ),
      history: {
        hasOlder:
          replica.authoritative &&
          boolean(turnsPagination.hasLoadedOldest) !== true,
        loading:
          loadingOlder || boolean(turnsPagination.isLoadingOlder) === true,
        cursor: string(turnsPagination.olderCursor),
        error: historyError,
      },
      error,
    };
  };

  const publish = () => {
    if (disposed) return;
    snapshot = derive();
    scheduleCapacityRetry();
    for (const listener of listeners) listener();
  };
  snapshot = derive();
  scheduleCapacityRetry();
  const removeReplicaListener = config.replica.subscribe(() => { publish(); outbox?.wake(); });

  const submitOnline = async (intent: SubmitIntent, options?: { readonly canDispatch: () => boolean }): Promise<SubmissionReceipt> => {
      assertIntentTarget(config.key, intent);
      if ([...pendingSubmissions.values(), ...queued.values()].some((submission) => submission.state === "unknown")) {
        throw new SubmissionOutcomeUnknownError();
      }
      if (continuationPending || continuedFromTurnId !== null) {
        throw new Error("Waiting for continuation to be confirmed by the conversation host");
      }
      const sender = config.getSubmissionSender?.();
      if (sender && !submissionSenders.has(intent.clientMessageId)) {
        submissionSenders.set(intent.clientMessageId, { ...sender });
        senderRevision++;
        if (submissionSenders.size > 256) submissionSenders.delete(submissionSenders.keys().next().value!);
      }
      const preview =
        composerDocumentToPlainText(intent.document).trim() ||
        (intent.attachments.length > 0
          ? intent.attachments[0]!.name
          : "Follow-up");
      if (intent.target.type === "enqueue-follow-up") {
        queued.set(intent.commandId, {
          commandId: intent.commandId,
          clientMessageId: intent.clientMessageId,
          serverSubmissionId: null,
          input: [],
          preview,
          state: "submitting",
          operation: "idle",
          createdAt: intent.createdAt,
          pausedReason: null,
          error: null,
        });
      } else {
        const replicaAtSubmission = config.replica.getSnapshot();
        const viewAtSubmission = isRecord(
          replicaAtSubmission.entities.get(config.key.threadId),
        )
          ? replicaAtSubmission.entities.get(config.key.threadId) as JsonRecord
          : {};
        const threadAtSubmission = isRecord(viewAtSubmission.thread)
          ? viewAtSubmission.thread
          : {};
        const sourceAtSubmission = sourceTurns(
          viewAtSubmission.turns ?? threadAtSubmission.turns,
        );
        pendingSubmissions.set(intent.commandId, {
          commandId: intent.commandId,
          clientMessageId: intent.clientMessageId,
          turnId: null,
          preview,
          state: "submitting",
          createdAt: intent.createdAt,
          error: null,
          kind: intent.target.type === "steer-active-turn" ? "steer" : "turn",
          targetTurnId:
            intent.target.type === "steer-active-turn"
              ? intent.target.turnId
              : null,
          predecessorTurnId: intent.target.type === "steer-active-turn"
            ? null
            : replicaAtSubmission.authoritative
              ? sourceAtSubmission.at(-1)?.id ?? null
              : undefined,
          input: optimisticInput(intent),
          attachments: intent.attachments,
        });
      }
      localRevision += 1;
      publish();
      try {
        const receipt = await config.commands.submit(intent, options);
        if (options?.canDispatch() === false) return receipt;
        if (intent.target.type === "enqueue-follow-up") {
          // A queue snapshot may already have taken ownership and consumed the
          // entry while this RPC was in flight. Its late ACK must not revive it.
          if (!queued.has(intent.commandId)) return receipt;
          queued.set(intent.commandId, {
            commandId: intent.commandId,
            clientMessageId: intent.clientMessageId,
            serverSubmissionId: null,
            input: [],
            preview,
            state: "queued",
            operation: "idle",
            createdAt: intent.createdAt,
            pausedReason: null,
            error: null,
          });
        } else {
          const previous = pendingSubmissions.get(intent.commandId);
          if (previous !== undefined) {
            if (previous.kind === "steer" && receipt.disposition === "queue") {
              // The Host accepted the bytes but the target Turn settled before
              // it could acknowledge them. Its authoritative paused Queue now
              // owns presentation and retry; the dead Turn must not retain a
              // phantom optimistic steering item.
              pendingSubmissions.delete(intent.commandId);
              return receipt;
            }
            pendingSubmissions.set(intent.commandId, {
              ...previous,
              turnId:
                receipt.turnId === null ? null : asTurnId(receipt.turnId),
              targetTurnId:
                previous.kind === "steer" && receipt.turnId !== null
                  ? asTurnId(receipt.turnId)
                  : previous.targetTurnId,
              // A steer RPC receipt is transport admission only. The steering
              // Item becomes accepted exclusively when a matching
              // authoritative userMessage arrives.
              state: previous.kind === "steer" ? previous.state : "accepted",
              error: null,
            });
          }
        }
        return receipt;
      } catch (error) {
        if (options?.canDispatch() === false) {
          queued.delete(intent.commandId); pendingSubmissions.delete(intent.commandId);
          localRevision++; publish(); throw error;
        }
        const submissionError =
          error instanceof Error ? error : new Error(String(error));
        if (intent.target.type === "enqueue-follow-up") {
          const acknowledgedByQueue = [...authoritativeQueue.values()].some((submission) =>
            submission.clientMessageId === intent.clientMessageId);
          if (!acknowledgedByQueue && queued.has(intent.commandId)) {
            queued.set(intent.commandId, {
              commandId: intent.commandId,
              clientMessageId: intent.clientMessageId,
              serverSubmissionId: null,
              input: [],
              preview,
              state: error instanceof SubmissionOutcomeUnknownError ? "unknown" : "failed",
              operation: "idle",
              createdAt: intent.createdAt,
              pausedReason: null,
              error: submissionError,
            });
          }
        } else {
          const previous = pendingSubmissions.get(intent.commandId);
          if (previous !== undefined) {
            pendingSubmissions.set(intent.commandId, {
              ...previous,
              state: error instanceof SubmissionOutcomeUnknownError ? "unknown" : "failed",
              error: submissionError,
            });
          }
        }
        throw error;
      } finally {
        localRevision += 1;
        publish();
      }
  };
  if (config.outbox) {
    outbox = createConversationOutbox({
      key: config.key, storage: config.outbox,
      ready: () => snapshot.authoritative && snapshot.phase === "live" && config.canDispatchOutbox?.() !== false,
      blocked: () => [...pendingSubmissions.values(), ...queued.values()].some(item => item.state === "unknown"),
      send: submitOnline, sender: config.getSubmissionSender, publish,
      retire: ids => { for (const id of ids) { queued.delete(id); pendingSubmissions.delete(id); } },
    });
    publish();
    queueMicrotask(() => outbox?.wake());
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) throw new Error("Conversation Runtime is disposed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async loadOlder() {
      if (!snapshot.authoritative || loadingOlder || !snapshot.history.hasOlder)
        return;
      loadingOlder = true;
      historyError = null;
      localRevision += 1;
      publish();
      try {
        await config.history.loadOlder(config.key);
      } catch (error) {
        historyError =
          error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        loadingOlder = false;
        localRevision += 1;
        publish();
      }
    },
    async submit(intent) {
      assertIntentTarget(config.key, intent);
      resetCapacityRetry();
      if (outbox && (outbox.hasPending() || !snapshot.authoritative || config.canDispatchOutbox?.() === false))
        return outbox.admit(intent);
      return submitOnline(intent);
    },
    interrupt(turnId, provenance) {
      const pending = interruptions.get(turnId);
      if (pending) return pending;
      interruptingTurnId = turnId;
      interruptedByThisClient.add(turnId);
      localRevision += 1;
      const operation = (async () => {
        try {
          const dismissals = snapshot.pendingInteractions
            .filter((interaction) => interaction.turnId === turnId)
            .map(createInterruptInteractionResponse)
            .filter((response): response is InteractionResponse => response !== null);
          await Promise.allSettled(dismissals.map(response => config.commands.respond(config.key, response)));
          await config.commands.interrupt(config.key, turnId, provenance);
        } catch (error) {
          interruptedByThisClient.delete(turnId);
          throw error;
        } finally {
          if (interruptingTurnId === turnId) interruptingTurnId = null;
          interruptions.delete(turnId);
          localRevision += 1;
          publish();
        }
      })();
      interruptions.set(turnId, operation);
      publish();
      return operation;
    },
    continueTurn: continueTurnImpl,
    respond: (response) => config.commands.respond(config.key, response),
    replaceQueuedSubmissions(submissions, steeringSubmissions = []) {
      const previousQueue = new Map(authoritativeQueue);
      authoritativeQueue.clear();
      for (const submission of submissions) {
        const previous = previousQueue.get(submission.id);
        authoritativeQueue.set(submission.id, {
          commandId: submission.id,
          ...(submission.sender === undefined ? {} : { sender: submission.sender }),
          clientMessageId: submission.clientUserMessageId,
          serverSubmissionId: submission.id,
          input: [...submission.input],
          preview: queuedInputPreview(submission.input),
          state: "queued",
          operation: previous?.operation ?? "idle",
          createdAt: submission.createdAt,
          pausedReason: submission.pausedReason,
          error: previous?.error ?? null,
        });
      }
      if (pendingQueueOrder !== null) {
        const current = new Map(authoritativeQueue);
        authoritativeQueue.clear();
        for (const id of pendingQueueOrder) {
          const submission = current.get(id);
          if (submission !== undefined) authoritativeQueue.set(id, submission);
        }
        for (const [id, submission] of current) {
          if (!authoritativeQueue.has(id))
            authoritativeQueue.set(id, submission);
        }
      }
      for (const [commandId, candidate] of queued) {
        if (submissions.some((submission) =>
          submission.clientUserMessageId === candidate.clientMessageId
        )) {
          queued.delete(commandId);
          continue;
        }
        if (candidate.state === "queued") queued.delete(commandId);
      }
      authoritativeSteers.clear();
      steeringClaims.clear();
      for (const submission of steeringSubmissions) {
        steeringClaims.set(submission.id, submission);
        const unconfirmedError = submission.pausedReason === null
          ? null
          : new Error(submission.pausedReason);
        const local = [...pendingSubmissions.entries()].find(
          ([, candidate]) => candidate.kind === "steer"
            && candidate.clientMessageId === submission.clientUserMessageId,
        );
        if (local !== undefined) {
          const [commandId, candidate] = local;
          pendingSubmissions.set(commandId, {
            ...candidate,
            turnId: asTurnId(submission.targetTurnId),
            targetTurnId: asTurnId(submission.targetTurnId),
            state: unconfirmedError === null ? "accepted" : "unknown",
            error: unconfirmedError,
          });
          continue;
        }
        if ([...confirmedSteers.values()].some(
          (candidate) => candidate.clientMessageId === submission.clientUserMessageId,
        )) continue;
        authoritativeSteers.set(submission.id, {
          commandId: submission.id,
          clientMessageId: submission.clientUserMessageId,
          turnId: asTurnId(submission.targetTurnId),
          preview: queuedInputPreview(submission.input),
          state: unconfirmedError === null ? "accepted" : "unknown",
          createdAt: submission.createdAt,
          error: unconfirmedError,
          kind: "steer",
          targetTurnId: asTurnId(submission.targetTurnId),
          predecessorTurnId: null,
          input: [...submission.input],
          attachments: [],
        });
      }
      localRevision += 1;
      publish();
    },
    async updateQueuedSubmission(queuedSubmissionId, input) {
      const previous = authoritativeQueue.get(queuedSubmissionId);
      if (previous === undefined)
        throw new Error(
          `Queued submission ${queuedSubmissionId} is not editable`,
        );
      authoritativeQueue.set(queuedSubmissionId, {
        ...previous,
        input: [...input],
        preview: queuedInputPreview(input),
        operation: "updating",
        error: null,
      });
      localRevision += 1;
      publish();
      try {
        const updated = await config.commands.updateQueuedSubmission(
          config.key,
          queuedSubmissionId,
          input,
        );
        authoritativeQueue.set(queuedSubmissionId, {
          ...previous,
          clientMessageId: updated.clientUserMessageId,
          ...(updated.sender === undefined ? {} : { sender: updated.sender }),
          input: [...updated.input],
          preview: queuedInputPreview(updated.input),
          operation: "idle",
          createdAt: updated.createdAt,
          pausedReason: updated.pausedReason,
          error: null,
        });
      } catch (error) {
        authoritativeQueue.set(queuedSubmissionId, {
          ...previous,
          operation: "idle",
          error: error instanceof Error ? error : new Error(String(error)),
        });
        throw error;
      } finally {
        localRevision += 1;
        publish();
      }
    },
    async deleteQueuedSubmission(queuedSubmissionId) {
      if (outbox?.remove(queuedSubmissionId)) return;
      if (queued.get(queuedSubmissionId)?.state === "failed") {
        queued.delete(queuedSubmissionId);
        localRevision += 1;
        publish();
        return;
      }
      const previous = authoritativeQueue.get(queuedSubmissionId);
      if (previous === undefined)
        throw new Error(
          `Queued submission ${queuedSubmissionId} is not deletable`,
        );
      authoritativeQueue.set(queuedSubmissionId, {
        ...previous,
        operation: "deleting",
        error: null,
      });
      localRevision += 1;
      publish();
      try {
        const deleted = await config.commands.deleteQueuedSubmission(
          config.key,
          queuedSubmissionId,
        );
        if (!deleted)
          throw new Error(
            `AppServer did not delete queued submission ${queuedSubmissionId}`,
          );
        authoritativeQueue.delete(queuedSubmissionId);
      } catch (error) {
        authoritativeQueue.set(queuedSubmissionId, {
          ...previous,
          operation: "idle",
          error: error instanceof Error ? error : new Error(String(error)),
        });
        throw error;
      } finally {
        localRevision += 1;
        publish();
      }
    },
    async discardUnconfirmedSteer(queuedSubmissionId, expectedTurnId) {
      const claim = steeringClaims.get(queuedSubmissionId);
      if (claim?.pausedReason !== "steer-delivery-unconfirmed" ||
          claim.targetTurnId !== expectedTurnId)
        throw new Error("The unconfirmed steering claim changed; refresh before discarding it");
      const deleted = await config.commands.discardUnconfirmedSteer(
        config.key, queuedSubmissionId, expectedTurnId,
      );
      if (!deleted)
        throw new Error("The steering claim was already reconciled or changed; refresh before continuing");
      steeringClaims.delete(queuedSubmissionId);
      authoritativeSteers.delete(queuedSubmissionId);
      for (const [id, submission] of pendingSubmissions) {
        if (submission.kind === "steer" && submission.clientMessageId === claim.clientUserMessageId)
          pendingSubmissions.delete(id);
      }
      localRevision += 1;
      publish();
    },
    async reorderQueuedSubmissions(queuedSubmissionIds) {
      const previous = [...authoritativeQueue.entries()];
      const currentIds = previous.map(([id]) => id);
      if (
        queuedSubmissionIds.length !== currentIds.length ||
        new Set(queuedSubmissionIds).size !== currentIds.length ||
        queuedSubmissionIds.some((id) => !authoritativeQueue.has(id))
      )
        throw new Error(
          "Queued submission order must contain every authoritative item exactly once",
        );
      authoritativeQueue.clear();
      pendingQueueOrder = [...queuedSubmissionIds];
      for (const id of queuedSubmissionIds) {
        authoritativeQueue.set(
          id,
          previous.find(([candidate]) => candidate === id)![1],
        );
      }
      localRevision += 1;
      publish();
      try {
        await config.commands.reorderQueuedSubmissions(
          config.key,
          queuedSubmissionIds,
        );
        pendingQueueOrder = null;
      } catch (error) {
        pendingQueueOrder = null;
        authoritativeQueue.clear();
        for (const [id, submission] of previous)
          authoritativeQueue.set(id, submission);
        localRevision += 1;
        publish();
        throw error;
      }
    },
    async startQueuedSubmission(queuedSubmissionId) {
      const targetId =
        queuedSubmissionId ?? authoritativeQueue.keys().next().value;
      const previous =
        targetId === undefined ? undefined : authoritativeQueue.get(targetId);
      if (targetId !== undefined && previous !== undefined) {
        authoritativeQueue.set(targetId, {
          ...previous,
          operation: "starting",
          pausedReason: null,
          error: null,
        });
        localRevision += 1;
        publish();
      }
      try {
        const turnId = await config.commands.startQueuedSubmission(
          config.key,
          queuedSubmissionId,
        );
        if (targetId !== undefined) authoritativeQueue.delete(targetId);
        return turnId;
      } catch (error) {
        if (targetId !== undefined && previous !== undefined) {
          authoritativeQueue.set(targetId, {
            ...previous,
            operation: "idle",
            pausedReason: error instanceof Error ? error.message : String(error),
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
        throw error;
      } finally {
        localRevision += 1;
        publish();
      }
    },
    async steerQueuedSubmission(queuedSubmissionId) {
      const previous = authoritativeQueue.get(queuedSubmissionId);
      const activeTurnId = snapshot.activeTurn?.turnId;
      if (previous === undefined || previous.serverSubmissionId === null) {
        throw new Error(
          `Queued submission ${queuedSubmissionId} is not steerable`,
        );
      }
      if (activeTurnId === undefined) {
        const turnId = await config.commands.startQueuedSubmission(
          config.key,
          queuedSubmissionId,
        );
        authoritativeQueue.delete(queuedSubmissionId);
        localRevision += 1;
        publish();
        return turnId;
      }
      authoritativeQueue.delete(queuedSubmissionId);
      pendingSubmissions.set(previous.commandId, {
        commandId: previous.commandId,
        clientMessageId: previous.clientMessageId,
        turnId: activeTurnId,
        preview: previous.preview,
        state: "submitting",
        createdAt: previous.createdAt,
        error: null,
        kind: "steer",
        targetTurnId: activeTurnId,
        predecessorTurnId: null,
        input: [...previous.input],
        attachments: [],
      });
      localRevision += 1;
      publish();
      try {
        const turnId = await config.commands.steerQueuedSubmission(
          config.key,
          {
            id: previous.serverSubmissionId,
            clientUserMessageId: previous.clientMessageId,
            input: [...previous.input],
            createdAt: previous.createdAt,
            pausedReason: previous.pausedReason,
          },
          activeTurnId,
        );
        return turnId;
      } catch (error) {
        pendingSubmissions.delete(previous.commandId);
        authoritativeQueue.set(queuedSubmissionId, {
          ...previous,
          operation: "idle",
          pausedReason: error instanceof Error ? error.message : String(error),
          error: error instanceof Error ? error : new Error(String(error)),
        });
        throw error;
      } finally {
        localRevision += 1;
        publish();
      }
    },
    dismissFailedSubmission(commandId) {
      if (queued.get(commandId)?.state === "failed") {
        queued.delete(commandId);
      } else if (pendingSubmissions.get(commandId)?.state === "failed") {
        pendingSubmissions.delete(commandId);
      } else {
        return;
      }
      localRevision += 1;
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearCapacityRetryTimer();
      removeReplicaListener();
      listeners.clear();
      outbox?.dispose();
      queued.clear();
      pendingSubmissions.clear();
      submissionSenders.clear();
      confirmedSteers.clear();
      authoritativeQueue.clear();
      pendingQueueOrder = null;
    },
  };
}
