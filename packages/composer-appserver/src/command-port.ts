import { AppServerClientError, AppServerRpcError, type AppServerClient } from "@opencraft/appserver-client";
import { ContinuationCommandError, SubmissionNotDispatchedError, SubmissionOutcomeUnknownError } from "@opencraft/chat-runtime";
import type {
  AppServerMethod,
  ThreadForkParams,
} from "@opencraft/appserver-protocol";
import type {
  DynamicToolSpec,
  UserInput,
} from "@opencraft/appserver-protocol/generated/v2";
import {
  asTurnId,
  type ConversationKey,
  type HostId,
  type TurnId,
} from "@opencraft/chat-core";
import type {
  ConversationCommandPort,
  InteractionResponse,
  TurnInterruptProvenance,
} from "@opencraft/chat-runtime";
import type { ModelSelectionPolicy, SubmissionReceipt, SubmitIntent } from "@opencraft/composer-core";

import {
  compileSubmitIntent,
  SubmitCompileError,
  type SubmitCompileDiagnostic,
  type SubmitCompilerOptions,
} from "./compiler";

export interface InteractionResponsePort {
  respond(key: ConversationKey, response: InteractionResponse): Promise<void>;
}

export interface AppServerConversationCommandPortConfig {
  readonly hostId: HostId;
  readonly client: Pick<AppServerClient, "hostId" | "request">;
  readonly interactions: InteractionResponsePort;
  /** Only a Host with one queue-to-active-Turn operation may consume a queued steer. */
  readonly queueAtomicSteer?: boolean;
  readonly queueUnconfirmedSteerDiscard?: boolean;
  readonly canRequest?: (method: AppServerMethod) => boolean;
  readonly compiler?: SubmitCompilerOptions;
  /** Host defaults supersede persisted Composer model and effort choices. */
  readonly modelSelectionPolicy?: ModelSelectionPolicy;
  readonly resolveCompilerOptions?: (intent: SubmitIntent) => Promise<SubmitCompilerOptions>;
  /** Product-owned tools installed on every newly-created Thread. */
  readonly dynamicTools?: readonly DynamicToolSpec[];
  readonly now?: () => number;
  readonly createCommandId?: () => string;
  readonly createClientMessageId?: () => string;
  readonly onDiagnostic?: (
    diagnostic: SubmitCompileDiagnostic,
    intent: SubmitIntent,
  ) => void;
  readonly onInterrupt?: (event: {
    readonly hostId: HostId;
    readonly threadId: string;
    readonly turnId: TurnId;
    readonly provenance: TurnInterruptProvenance;
  }) => void;
}

export class AppServerConversationCommandError extends Error {
  readonly code: "HOST_MISMATCH";

  constructor(
    code: AppServerConversationCommandError["code"],
    message: string,
  ) {
    super(message);
    this.name = "AppServerConversationCommandError";
    this.code = code;
  }
}

function targetHostId(intent: SubmitIntent): HostId {
  return intent.target.type === "new-thread"
    ? intent.target.execution.hostId
    : intent.target.key.hostId;
}

function forkOptions(
  options: ReturnType<typeof compileSubmitIntent>["threadOptions"],
): Omit<ThreadForkParams, "threadId"> {
  return {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.modelProvider === undefined
      ? {}
      : { modelProvider: options.modelProvider }),
    ...(options.serviceTier === undefined
      ? {}
      : { serviceTier: options.serviceTier }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.runtimeWorkspaceRoots === undefined
      ? {}
      : { runtimeWorkspaceRoots: options.runtimeWorkspaceRoots }),
    ...(options.approvalPolicy === undefined
      ? {}
      : { approvalPolicy: options.approvalPolicy }),
    ...(options.approvalsReviewer === undefined
      ? {}
      : { approvalsReviewer: options.approvalsReviewer }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    ...(options.permissions === undefined
      ? {}
      : { permissions: options.permissions }),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.baseInstructions === undefined
      ? {}
      : { baseInstructions: options.baseInstructions }),
    ...(options.developerInstructions === undefined
      ? {}
      : { developerInstructions: options.developerInstructions }),
  };
}

export function createAppServerConversationCommandPort(
  config: AppServerConversationCommandPortConfig,
): ConversationCommandPort {
  const compile = async (intent: SubmitIntent) => {
    if (config.modelSelectionPolicy === "host-default"
      || (config.modelSelectionPolicy === "session" && intent.selections.model === undefined)) {
      const { model: _model, effort: _effort, ...selections } = intent.selections;
      intent = { ...intent, selections };
    }
    let resolved: SubmitCompilerOptions | undefined;
    try { resolved = await config.resolveCompilerOptions?.(intent); }
    catch (cause) { throw new SubmitCompileError("CAPABILITY_UNAVAILABLE", `无法确认模型能力，尚未发送请求：${cause instanceof Error ? cause.message : String(cause)}`); }
    return compileSubmitIntent(intent, { ...config.compiler, ...resolved });
  };
  const now = config.now ?? Date.now;
  const createCommandId =
    config.createCommandId ?? (() => `continue-command-${crypto.randomUUID()}`);
  const createClientMessageId =
    config.createClientMessageId ?? (() => `continue-message-${crypto.randomUUID()}`);

  const assertConversationHost = (key: ConversationKey): void => {
    if (
      key.hostId !== config.hostId ||
      config.client.hostId !== config.hostId
    ) {
      throw new AppServerConversationCommandError(
        "HOST_MISMATCH",
        `Conversation host ${key.hostId} cannot be sent through AppServer host ${config.hostId}`,
      );
    }
  };

  const actualTurnIdFromMismatch = (error: unknown): string | null => {
    if (!(error instanceof AppServerRpcError)) return null;
    const data = error.data as { code?: unknown; actualTurnId?: unknown } | undefined;
    return data?.code === "EXPECTED_TURN_MISMATCH" && typeof data.actualTurnId === "string"
      ? data.actualTurnId
      : null;
  };

  const steer = async (
    threadId: string,
    expectedTurnId: string,
    clientUserMessageId: string,
    input: readonly UserInput[],
    additionalContext?: NonNullable<ReturnType<typeof compileSubmitIntent>["additionalContext"]>,
  ) => {
    const request = (turnId: string) => config.client.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      clientUserMessageId,
      input: [...input],
      ...(additionalContext === undefined ? {} : { additionalContext }),
    });
    try {
      return await request(expectedTurnId);
    } catch (error) {
      const actualTurnId = actualTurnIdFromMismatch(error);
      if (actualTurnId === null) throw error;
      return await request(actualTurnId);
    }
  };

  const execute = async (
    intent: SubmitIntent,
    options?: { readonly canDispatch: () => boolean },
  ): Promise<SubmissionReceipt> => {
    const method = intent.target.type === "enqueue-follow-up" ? "thread/queue/add"
      : intent.target.type === "steer-active-turn" ? "turn/steer" : "turn/start";
    if (config.canRequest?.(method) === false) throw new Error("此连接暂不支持该操作");
    const hostId = targetHostId(intent);
    if (hostId !== config.hostId || config.client.hostId !== config.hostId) {
      throw new AppServerConversationCommandError(
        "HOST_MISMATCH",
        `SubmitIntent host ${hostId} cannot be sent through AppServer host ${config.hostId}`,
      );
    }
    const compiled = await compile(intent);
    if (options?.canDispatch() === false) throw new SubmissionNotDispatchedError();
    for (const diagnostic of compiled.diagnostics)
      config.onDiagnostic?.(diagnostic, intent);
    let threadId: string;
    let turnId: string | null;
    let disposition: SubmissionReceipt["disposition"];

    switch (intent.target.type) {
      case "new-thread": {
        const started = await config.client.request("thread/start", {
          ...compiled.threadOptions,
          ...(config.dynamicTools === undefined
            ? {}
            : { dynamicTools: [...config.dynamicTools] }),
          ...(intent.target.execution.workspace.cwd === null
            ? {}
            : { cwd: intent.target.execution.workspace.cwd }),
          runtimeWorkspaceRoots: [
            ...intent.target.execution.workspace.runtimeWorkspaceRoots,
          ],
          ...(intent.target.execution.workspace.projectId == null
            ? {}
            : { projectId: intent.target.execution.workspace.projectId }),
        });
        threadId = started.thread.id;
        const turn = await config.client.request("turn/start", {
          threadId,
          clientUserMessageId: intent.clientMessageId,
          input: [...compiled.input],
          ...(compiled.additionalContext === null
            ? {}
            : { additionalContext: compiled.additionalContext }),
          ...compiled.turnOptions,
        });
        turnId = turn.turn.id;
        break;
      }
      case "fork-thread": {
        const forked = await config.client.request("thread/fork", {
          threadId: intent.target.key.threadId,
          lastTurnId: intent.target.fromTurnId,
          ...forkOptions(compiled.threadOptions),
        });
        threadId = forked.thread.id;
        const turn = await config.client.request("turn/start", {
          threadId,
          clientUserMessageId: intent.clientMessageId,
          input: [...compiled.input],
          ...(compiled.additionalContext === null
            ? {}
            : { additionalContext: compiled.additionalContext }),
          ...compiled.turnOptions,
        });
        turnId = turn.turn.id;
        break;
      }
      case "existing-thread": {
        threadId = intent.target.key.threadId;
        const turn = await config.client.request("turn/start", {
          threadId,
          clientUserMessageId: intent.clientMessageId,
          input: [...compiled.input],
          ...(compiled.additionalContext === null
            ? {}
            : { additionalContext: compiled.additionalContext }),
          ...compiled.turnOptions,
        });
        turnId = turn.turn.id;
        break;
      }
      case "steer-active-turn": {
        threadId = intent.target.key.threadId;
        const turn = await steer(
          threadId,
          intent.target.turnId,
          intent.clientMessageId,
          compiled.input,
          compiled.additionalContext ?? undefined,
        );
        disposition = turn.disposition === "queued" ? "queue" : undefined;
        turnId = disposition === "queue" ? null : turn.turnId;
        break;
      }
      case "enqueue-follow-up": {
        threadId = intent.target.key.threadId;
        await config.client.request("thread/queue/add", {
          threadId,
          input: [...compiled.input],
          clientUserMessageId: intent.clientMessageId,
        });
        turnId = null;
        break;
      }
    }

    const receipt: SubmissionReceipt = {
      commandId: intent.commandId,
      clientMessageId: intent.clientMessageId,
      hostId,
      threadId,
      turnId,
      acceptedAt: now(),
      replayed: false,
      ...(disposition === undefined ? {} : { disposition }),
    };
    return receipt;
  };

  const createThread = async (intent: SubmitIntent): Promise<SubmissionReceipt> => {
    if (intent.target.type !== "new-thread") {
      throw new Error("Only a New Thread intent can create a Thread");
    }
    const hostId = targetHostId(intent);
    if (hostId !== config.hostId || config.client.hostId !== config.hostId) {
      throw new AppServerConversationCommandError(
        "HOST_MISMATCH",
        `SubmitIntent host ${hostId} cannot be sent through AppServer host ${config.hostId}`,
      );
    }
    const compiled = await compile(intent);
    for (const diagnostic of compiled.diagnostics)
      config.onDiagnostic?.(diagnostic, intent);
    const started = await config.client.request("thread/start", {
      ...compiled.threadOptions,
      ...(config.dynamicTools === undefined
        ? {}
        : { dynamicTools: [...config.dynamicTools] }),
      ...(intent.target.execution.workspace.cwd === null
        ? {}
        : { cwd: intent.target.execution.workspace.cwd }),
      runtimeWorkspaceRoots: [
        ...intent.target.execution.workspace.runtimeWorkspaceRoots,
      ],
      ...(intent.target.execution.workspace.projectId == null
        ? {}
        : { projectId: intent.target.execution.workspace.projectId }),
    });
    return {
      commandId: intent.commandId,
      clientMessageId: intent.clientMessageId,
      hostId,
      threadId: started.thread.id,
      turnId: null,
      acceptedAt: now(),
      replayed: false,
    };
  };

  return {
    createThread,
    async submit(intent, options) {
      try { return await execute(intent, options); }
      catch (cause) {
        if (options && cause instanceof AppServerClientError && cause.code === "NOT_CONNECTED") throw new SubmissionNotDispatchedError();
        const hermesCode = cause instanceof AppServerRpcError
          ? (cause.data as { hermesCode?: unknown } | undefined)?.hermesCode : undefined;
        if ((cause instanceof AppServerClientError && ["TIMEOUT", "TRANSPORT_ERROR", "ABORTED"].includes(cause.code))
          || ["timeout", "disconnected", "disposed"].includes(String(hermesCode))) {
          throw new SubmissionOutcomeUnknownError({ cause });
        }
        throw cause;
      }
    },
    async interrupt(key, turnId, provenance) {
      if (key.hostId !== config.hostId) {
        throw new AppServerConversationCommandError(
          "HOST_MISMATCH",
          "Conversation belongs to a different Host",
        );
      }
      config.onInterrupt?.({
        hostId: key.hostId,
        threadId: key.threadId,
        turnId,
        provenance: provenance ?? {
          source: "unknown",
          trigger: "programmatic",
          isTrusted: null,
          occurredAt: now(),
        },
      });
      await config.client.request("turn/interrupt", {
        threadId: key.threadId,
        turnId,
      });
    },
    async continueTurn(key) {
      assertConversationHost(key);
      const commandId = createCommandId();
      const clientMessageId = createClientMessageId();
      const result = await config.client.request("turn/start", {
        threadId: key.threadId,
        input: [],
        clientUserMessageId: clientMessageId,
      }).catch((cause: unknown) => {
        const rejected = cause instanceof AppServerRpcError;
        throw new ContinuationCommandError(
          rejected ? "rejected" : "unknown",
          rejected ? cause.message : "Could not confirm continuation. Wait for the host to reconnect before sending again.",
          { cause },
        );
      });
      return {
        commandId, clientMessageId, hostId: key.hostId,
        threadId: key.threadId, turnId: result.turn.id,
        acceptedAt: now(), replayed: false,
      };
    },
    respond: (key, response) => config.interactions.respond(key, response),
    async updateQueuedSubmission(
      key,
      queuedSubmissionId,
      input: readonly UserInput[],
    ) {
      assertConversationHost(key);
      const response = await config.client.request("thread/queue/update", {
        threadId: key.threadId,
        queuedSubmissionId,
        input: [...input],
      });
      return response.queuedSubmission;
    },
    async deleteQueuedSubmission(key, queuedSubmissionId) {
      assertConversationHost(key);
      const response = await config.client.request("thread/queue/delete", {
        threadId: key.threadId,
        queuedSubmissionId,
      });
      return response.deleted;
    },
    async discardUnconfirmedSteer(key, queuedSubmissionId, expectedTurnId) {
      assertConversationHost(key);
      if (config.queueUnconfirmedSteerDiscard !== true)
        throw new Error("This Host cannot discard a native steering claim");
      const response = await config.client.request("thread/queue/delete", {
        threadId: key.threadId,
        queuedSubmissionId,
        expectedTurnId,
        acknowledgeUnknownDelivery: true,
      });
      return response.deleted;
    },
    async reorderQueuedSubmissions(key, queuedSubmissionIds) {
      assertConversationHost(key);
      await config.client.request("thread/queue/reorder", {
        threadId: key.threadId,
        queuedSubmissionIds: [...queuedSubmissionIds],
      });
    },
    async startQueuedSubmission(key, queuedSubmissionId) {
      assertConversationHost(key);
      const response = await config.client.request("thread/queue/start", {
        threadId: key.threadId,
        ...(queuedSubmissionId === undefined ? {} : { queuedSubmissionId }),
      });
      return asTurnId(response.turn.id);
    },
    async steerQueuedSubmission(key, queuedSubmission, activeTurnId) {
      assertConversationHost(key);
      if (config.queueAtomicSteer !== true) {
        throw new Error("This Host does not support atomic steering of queued messages");
      }
      const request = (expectedTurnId: string) => config.client.request("thread/queue/steer", {
        threadId: key.threadId,
        queuedSubmissionId: queuedSubmission.id,
        expectedTurnId,
      });
      try {
        const response = await request(activeTurnId);
        return asTurnId(response.turnId);
      } catch (error) {
        const actualTurnId = actualTurnIdFromMismatch(error);
        if (actualTurnId === null) throw error;
        const response = await request(actualTurnId);
        return asTurnId(response.turnId);
      }
    },
  };
}
