import type {
  AppServerClient,
  ServerRequestResponseContext,
} from "@opencraft/appserver-client";
import type {
  AppServerServerMethod,
  AppServerServerRequestParams,
  AppServerServerRequestResult,
  JsonRpcId,
} from "@opencraft/appserver-protocol";
import type { ConversationKey } from "@opencraft/chat-core";
import type { InteractionResponse, PendingInteraction } from "@opencraft/chat-runtime";

import type { InteractionResponsePort } from "./command-port";
import { AppServerInteractionLedger } from "./interaction-ledger";

export interface PendingInteractionStore {
  upsertPendingInteraction(interaction: PendingInteraction & { readonly threadId: string }): unknown;
  removePendingInteraction(threadId: string, requestId: string): unknown;
}

export interface AppServerInteractionBrokerConfig {
  readonly hostId: string;
  readonly client: Pick<AppServerClient, "handleServerRequest" | "interceptServerRequest" | "subscribeNotification" | "subscribeStatus">;
  readonly store: PendingInteractionStore;
  readonly ledger?: AppServerInteractionLedger;
  readonly now?: () => number;
}

interface DeferredServerRequest<TMethod extends AppServerServerMethod = AppServerServerMethod> {
  readonly method: TMethod;
  readonly interaction: PendingInteraction & { readonly threadId: string };
  resolve(value: AppServerServerRequestResult<TMethod>): void;
  reject(error: Error): void;
  readonly delivered: Promise<void>;
}

export class AppServerInteractionError extends Error {
  readonly code: "DUPLICATE_REQUEST" | "REQUEST_NOT_FOUND" | "RESPONSE_KIND_MISMATCH" | "HOST_MISMATCH" | "DISCONNECTED";

  constructor(code: AppServerInteractionError["code"], message: string) {
    super(message);
    this.name = "AppServerInteractionError";
    this.code = code;
  }
}

export function encodeServerRequestId(id: JsonRpcId): string {
  return `appserver-rpc:${JSON.stringify([typeof id, id])}`;
}

function identity(params: object): { threadId: string; turnId: string | null; itemId: string | null } {
  const source = params as { threadId?: unknown; turnId?: unknown; itemId?: unknown; callId?: unknown };
  if (typeof source.threadId !== "string" || source.threadId.length === 0) {
    throw new AppServerInteractionError("RESPONSE_KIND_MISMATCH", "Server interaction has no Thread identity");
  }
  return {
    threadId: source.threadId,
    turnId: typeof source.turnId === "string" ? source.turnId : null,
    itemId: typeof source.itemId === "string" ? source.itemId : typeof source.callId === "string" ? source.callId : null,
  };
}

function dynamicToolContent(value: unknown) {
  return {
    contentItems: [{ type: "inputText" as const, text: JSON.stringify(value) }],
    success: true,
  };
}

function wrappedQuestionAnswers(answers: Readonly<Record<string, readonly string[]>>) {
  return {
    answers: Object.fromEntries(
      Object.entries(answers).map(([questionId, values]) => [questionId, { answers: [...values] }]),
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const dynamicInteractionTools = new Set([
  "request_onboarding_input",
  "request_option_picker",
  "setup_codex_context_picker",
  "setup_codex_step",
]);

function shouldCaptureDynamicTool(params: { readonly tool?: unknown; readonly arguments?: unknown } | null): boolean {
  if (typeof params?.tool !== "string" || !dynamicInteractionTools.has(params.tool)) return false;
  if (params.tool !== "setup_codex_step") return true;
  if (!isRecord(params.arguments)) return false;
  return params.arguments.step === "role" || params.arguments.step === "task" || params.arguments.step === "context";
}

function responseResult(
  pending: Pick<DeferredServerRequest, "method" | "interaction">,
  response: InteractionResponse,
): unknown {
  switch (pending.method) {
    case "item/commandExecution/requestApproval":
      if (response.type === "command-approval") return {
        decision: response.decision,
        ...(response._meta === undefined ? {} : { _meta: response._meta }),
      };
      break;
    case "item/fileChange/requestApproval":
      if (response.type === "file-change-approval") return { decision: response.decision };
      break;
    case "item/permissions/requestApproval":
      if (response.type === "permissions-approval") return {
        permissions: response.permissions,
        scope: response.scope,
        ...(response.strictAutoReview === undefined ? {} : { strictAutoReview: response.strictAutoReview }),
      };
      break;
    case "item/tool/requestUserInput":
      if (response.type === "question") return {
        ...wrappedQuestionAnswers(response.answers),
      };
      break;
    case "mcpServer/elicitation/request":
      if (response.type === "elicitation") return {
        action: response.action,
        content: response.content ?? null,
        _meta: response._meta ?? null,
      };
      break;
    case "item/tool/call":
      if (response.type === "question" && (pending.interaction.params as { readonly tool?: unknown }).tool === "request_onboarding_input") {
        return dynamicToolContent(wrappedQuestionAnswers(response.answers));
      }
      if (response.type === "option-picker" && (pending.interaction.params as { readonly tool?: unknown }).tool === "request_option_picker") {
        return dynamicToolContent({
          action: response.action,
          selectedOptions: [...response.selectedOptions],
          freeformAnswer: response.freeformAnswer,
        });
      }
      if (response.type === "setup-codex-step" && (pending.interaction.params as { readonly tool?: unknown }).tool === "setup_codex_step") {
        const args = (pending.interaction.params as { readonly arguments?: unknown }).arguments;
        if (!isRecord(args) || args.step !== response.step) break;
        if (response.step === "role") return dynamicToolContent({
          action: response.action,
          selectedRoles: [...response.selectedRoles],
        });
        if (response.step === "task") return dynamicToolContent({
          action: response.action,
          answers: response.answers,
        });
        return dynamicToolContent({
          action: response.action,
          selectedSources: [...response.selectedSources],
        });
      }
      if (response.type === "setup-context-picker" && (pending.interaction.params as { readonly tool?: unknown }).tool === "setup_codex_context_picker") {
        return dynamicToolContent({
          action: response.action,
          selectedSources: [...response.selectedSources],
        });
      }
      break;
    case "item/tool/requestOptionPicker":
      if (response.type === "option-picker") return {
        action: response.action,
        selectedOptions: [...response.selectedOptions],
        freeformAnswer: response.freeformAnswer,
      };
      break;
    case "item/tool/requestSetupCodexContextPicker":
      if (response.type === "setup-context-picker") return {
        action: response.action,
        selectedSources: [...response.selectedSources],
      };
      break;
  }
  throw new AppServerInteractionError(
    "RESPONSE_KIND_MISMATCH",
    `${response.type} cannot answer ${pending.method}`,
  );
}

function cancelledResult(pending: DeferredServerRequest): unknown {
  switch (pending.method) {
    case "item/commandExecution/requestApproval": return { decision: "cancel" };
    case "item/fileChange/requestApproval": return { decision: "cancel" };
    case "item/permissions/requestApproval": return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput": return { answers: {} };
    case "mcpServer/elicitation/request": return { action: "cancel", content: null, _meta: null };
    case "item/tool/requestOptionPicker": return { action: "dismiss", selectedOptions: [], freeformAnswer: null };
    case "item/tool/requestSetupCodexContextPicker": return { action: "dismiss", selectedSources: [] };
    case "item/tool/call": {
      const params = pending.interaction.params as { readonly tool?: unknown; readonly arguments?: unknown };
      if (params.tool === "request_onboarding_input") return dynamicToolContent({ answers: {} });
      if (params.tool === "request_option_picker") return dynamicToolContent({ action: "dismiss", selectedOptions: [], freeformAnswer: null });
      if (params.tool === "setup_codex_context_picker") return dynamicToolContent({ action: "dismiss", selectedSources: [] });
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (args.step === "role") return dynamicToolContent({ action: "dismiss", selectedRoles: [] });
      if (args.step === "task") return dynamicToolContent({ action: "dismiss", answers: {} });
      return dynamicToolContent({ action: "dismiss", selectedSources: [] });
    }
  }
}

export class AppServerInteractionBroker implements InteractionResponsePort {
  private readonly hostId: string;
  private readonly store: PendingInteractionStore;
  private readonly now: () => number;
  private readonly ledger: AppServerInteractionLedger;
  private readonly pending = new Map<string, DeferredServerRequest>();
  private readonly removeHandlers: (() => void)[];
  private readonly removeStatus: () => void;
  private readonly removeNotification: () => void;
  private disposed = false;

  constructor(config: AppServerInteractionBrokerConfig) {
    this.hostId = config.hostId;
    this.store = config.store;
    this.now = config.now ?? Date.now;
    this.ledger = config.ledger ?? new AppServerInteractionLedger();
    this.removeHandlers = [
      config.client.handleServerRequest("item/commandExecution/requestApproval", (params, request, context) =>
        this.capture(request.method, params, request.id, context)),
      config.client.handleServerRequest("item/fileChange/requestApproval", (params, request, context) =>
        this.capture(request.method, params, request.id, context)),
      config.client.handleServerRequest("item/tool/requestUserInput", (params, request, context) =>
        this.capture(request.method, params, request.id, context)),
      config.client.handleServerRequest("mcpServer/elicitation/request", (params, request, context) =>
        this.capture(request.method, params, request.id, context)),
      config.client.handleServerRequest("item/permissions/requestApproval", (params, request, context) =>
        this.capture(request.method, params, request.id, context)),
      config.client.handleServerRequest("item/tool/requestOptionPicker", (params, request, context) =>
        this.capture(request.method, params, request.id, context)),
      config.client.handleServerRequest("item/tool/requestSetupCodexContextPicker", (params, request, context) =>
        this.capture(request.method, params, request.id, context)),
      config.client.interceptServerRequest((request, next, context) => {
        const params = request.params as { tool?: unknown; arguments?: unknown } | null;
        if (request.method !== "item/tool/call" || !shouldCaptureDynamicTool(params)) return next();
        return this.capture("item/tool/call", request.params as AppServerServerRequestParams<"item/tool/call">, request.id, context);
      }),
    ];
    this.removeStatus = config.client.subscribeStatus((status) => {
      if (status.state === "closed" || status.state === "failed") {
        this.failAll(new AppServerInteractionError("DISCONNECTED", status.reason ?? "AppServer disconnected"));
      }
    });
    this.removeNotification = config.client.subscribeNotification((notification) => {
      if (notification.method !== "serverRequest/resolved") return;
      const params = notification.params as { readonly requestId?: unknown; readonly threadId?: unknown };
      if ((typeof params.requestId !== "string" && typeof params.requestId !== "number") || typeof params.threadId !== "string") return;
      const requestId = encodeServerRequestId(params.requestId);
      const pending = this.pending.get(requestId);
      if (pending === undefined || pending.interaction.threadId !== params.threadId) return;
      this.ledger.forget(pending.interaction);
      this.pending.delete(requestId);
      this.store.removePendingInteraction(pending.interaction.threadId, requestId);
      pending.resolve(cancelledResult(pending) as never);
    });
  }

  async respond(key: ConversationKey, response: InteractionResponse): Promise<void> {
    if (key.hostId !== this.hostId) {
      throw new AppServerInteractionError("HOST_MISMATCH", "Interaction belongs to a different Host");
    }
    const pending = this.pending.get(response.requestId);
    if (pending === undefined || pending.interaction.threadId !== key.threadId) {
      throw new AppServerInteractionError("REQUEST_NOT_FOUND", `Pending interaction ${response.requestId} was not found`);
    }
    const result = responseResult(pending, response);
    this.ledger.remember(pending.interaction, response);
    pending.resolve(result as never);
    await pending.delivered;
    this.ledger.markDelivered(pending.interaction, response);
    if (this.pending.get(response.requestId) === pending) {
      this.pending.delete(response.requestId);
      this.store.removePendingInteraction(pending.interaction.threadId, response.requestId);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const remove of this.removeHandlers.reverse()) remove();
    this.removeNotification();
    this.removeStatus();
    this.failAll(new AppServerInteractionError("DISCONNECTED", "Interaction broker disposed"));
  }

  private capture<TMethod extends AppServerServerMethod>(
    method: TMethod,
    params: AppServerServerRequestParams<TMethod>,
    id: JsonRpcId,
    context: ServerRequestResponseContext,
  ): Promise<AppServerServerRequestResult<TMethod>> {
    if (this.disposed) return Promise.reject(new AppServerInteractionError("DISCONNECTED", "Interaction broker is disposed"));
    const requestId = encodeServerRequestId(id);
    if (this.pending.has(requestId)) {
      return Promise.reject(new AppServerInteractionError("DUPLICATE_REQUEST", `Duplicate AppServer request ${requestId}`));
    }
    const requestIdentity = identity(params);
    const interaction = {
      requestId,
      method,
      ...requestIdentity,
      receivedAtMs: this.now(),
      params,
    } as PendingInteraction & { readonly threadId: string };
    const remembered = this.ledger.recall(interaction);
    if (remembered !== null) {
      const result = responseResult({ method, interaction }, remembered.response);
      void context.delivered.then(
        () => this.ledger.markDelivered(interaction, remembered.response),
        () => undefined,
      );
      return Promise.resolve(result as AppServerServerRequestResult<TMethod>);
    }
    return new Promise<AppServerServerRequestResult<TMethod>>((resolve, reject) => {
      const deferred: DeferredServerRequest<TMethod> = {
        method,
        interaction,
        resolve,
        reject,
        delivered: context.delivered,
      };
      this.pending.set(requestId, deferred as DeferredServerRequest);
      try {
        this.store.upsertPendingInteraction(interaction);
      } catch (error) {
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private failAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.store.removePendingInteraction(pending.interaction.threadId, requestId);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
