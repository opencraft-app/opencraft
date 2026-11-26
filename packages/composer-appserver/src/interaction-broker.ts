import { SHARED_INTERACTIONS_CHANGED, SHARED_INTERACTIONS_EXTENSION, SHARED_INTERACTIONS_READ, SHARED_INTERACTIONS_RESPOND, parseSharedInteractionSnapshot } from "@opencraft/appserver-protocol";
import { executionEngineExtension } from "@opencraft/appserver-client";
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

export interface SharedPendingInteractionStore extends PendingInteractionStore {
  applyPendingInteractionPatch(threadId: string, patch: {
    readonly remove: readonly string[];
    readonly upsert: readonly (PendingInteraction & { readonly threadId: string })[];
  }): unknown;
}

export type AppServerInteractionBrokerConfig = {
  readonly hostId: string;
  readonly client: Pick<AppServerClient, "handleServerRequest" | "interceptServerRequest" | "subscribeStatus">;
  readonly ledger?: AppServerInteractionLedger;
  readonly now?: () => number;
} & ({
  readonly store: PendingInteractionStore;
  readonly sharedClient?: undefined;
} | {
  readonly store: SharedPendingInteractionStore;
  readonly sharedClient: Pick<AppServerClient, "request" | "subscribeNotification" | "initializeResult">;
});

interface DeferredServerRequest<TMethod extends AppServerServerMethod = AppServerServerMethod> {
  readonly method: TMethod;
  readonly interaction: PendingInteraction & { readonly threadId: string };
  resolve(value: AppServerServerRequestResult<TMethod>): void;
  reject(error: Error): void;
  readonly delivered: Promise<void>;
  readonly context: ServerRequestResponseContext;
  removeRetirementListener(): void;
  response?: InteractionResponse;
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
      if (response.type === "setup-step" && (pending.interaction.params as { readonly tool?: unknown }).tool === "setup_codex_step") {
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

type SharedPendingInteraction = PendingInteraction & { threadId: string; canRespond: boolean };

interface SharedThreadSnapshot {
  readonly epoch: string;
  readonly revision: number;
  /** Order of the request's start or the live notification's arrival. */
  readonly observation: number;
  readonly canRespond: boolean;
  readonly requests: ReadonlyMap<string, SharedPendingInteraction>;
}

export class AppServerInteractionBroker implements InteractionResponsePort {
  private readonly hostId: string;
  private readonly store: PendingInteractionStore;
  private readonly now: () => number;
  private readonly ledger: AppServerInteractionLedger;
  private readonly pending = new Map<string, DeferredServerRequest>();
  private readonly removeHandlers: (() => void)[];
  private readonly removeStatus: () => void;
  private disposed = false;
  private readonly sharedClient: AppServerInteractionBrokerConfig["sharedClient"];
  private readonly sharedStore: SharedPendingInteractionStore | undefined;
  private readonly sharedSnapshots = new Map<string, SharedThreadSnapshot>();
  private sharedObservation = 0;
  private readonly retiredSharedEpochs = new Set<string>();
  private connectionRevision = 0;
  private readonly removeShared: (() => void) | undefined;

  constructor(config: AppServerInteractionBrokerConfig) {
    this.hostId = config.hostId;
    this.store = config.store;
    this.now = config.now ?? Date.now;
    this.ledger = config.ledger ?? new AppServerInteractionLedger();
    this.sharedClient = config.sharedClient;
    this.sharedStore = config.sharedClient === undefined ? undefined : config.store;
    this.removeShared = config.sharedClient?.subscribeNotification(event => {
      if (event.method !== SHARED_INTERACTIONS_CHANGED || this.disposed) return;
      this.applyShared(event.params, ++this.sharedObservation);
    });
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
        this.connectionRevision++;
        const revoked: Array<[string, SharedThreadSnapshot]> = [];
        // Retire every reply route before the first synchronous View listener.
        for (const [threadId, snapshot] of this.sharedSnapshots) {
          if (!snapshot.canRespond) continue;
          const requests = new Map<string, SharedPendingInteraction>();
          for (const [id, interaction] of snapshot.requests) requests.set(id, { ...interaction, canRespond: false });
          const unavailable = { ...snapshot, canRespond: false, requests };
          this.sharedSnapshots.set(threadId, unavailable);
          revoked.push([threadId, unavailable]);
        }
        this.failAll(new AppServerInteractionError("DISCONNECTED", status.reason ?? "AppServer disconnected"));
        for (const [threadId, unavailable] of revoked) {
          if (this.sharedSnapshots.get(threadId) !== unavailable || unavailable.requests.size === 0) continue;
          this.sharedStore?.applyPendingInteractionPatch(threadId, { remove: [], upsert: [...unavailable.requests.values()] });
        }
      }
    });

  }

  async respond(key: ConversationKey, response: InteractionResponse): Promise<void> {
    if (this.disposed) throw new AppServerInteractionError("DISCONNECTED", "Interaction broker disposed");
    if (key.hostId !== this.hostId) {
      throw new AppServerInteractionError("HOST_MISMATCH", "Interaction belongs to a different Host");
    }
    const shared = this.sharedSnapshots.get(key.threadId)?.requests.get(response.requestId);
    if (shared && this.sharedClient) {
      if (!shared.canRespond) throw new AppServerInteractionError("REQUEST_NOT_FOUND", "This subscription cannot answer the interaction");
      const result = responseResult({ method: shared.method, interaction: shared }, response);
      const revision = this.connectionRevision;
      const observation = ++this.sharedObservation;
      const reply = await this.sharedClient.request(SHARED_INTERACTIONS_RESPOND, {
        threadId: shared.threadId, interactionId: shared.requestId.slice("host-interaction:".length),
        submissionId: `answer:${crypto.randomUUID()}`, result: result as Record<string, unknown>,
      });
      if (!this.disposed && revision === this.connectionRevision) this.applyShared(reply.snapshot, observation, key.threadId);
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (pending === undefined || pending.interaction.threadId !== key.threadId) {
      throw new AppServerInteractionError("REQUEST_NOT_FOUND", `Pending interaction ${response.requestId} was not found`);
    }
    const result = responseResult(pending, response);
    if (pending.context.signal.aborted) throw new AppServerInteractionError("REQUEST_NOT_FOUND", "Native request has retired");
    this.ledger.remember(pending.interaction, response);
    pending.response = response;
    pending.resolve(result as never);
    await pending.delivered;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const remove of this.removeHandlers.reverse()) remove();
    this.removeStatus();
    this.removeShared?.();
    const snapshots = [...this.sharedSnapshots];
    this.sharedSnapshots.clear();
    this.retiredSharedEpochs.clear();
    this.failAll(new AppServerInteractionError("DISCONNECTED", "Interaction broker disposed"));
    for (const [threadId, snapshot] of snapshots) {
      if (snapshot.requests.size > 0)
        this.sharedStore?.applyPendingInteractionPatch(threadId, { remove: [...snapshot.requests.keys()], upsert: [] });
    }
  }


  async sync(threadId: string): Promise<void> {
    if (this.disposed || !this.sharedClient || executionEngineExtension(this.sharedClient.initializeResult?.capabilities?.extensions,
      threadId, SHARED_INTERACTIONS_EXTENSION)?.version !== 1) return;
    const revision = this.connectionRevision;
    const observation = ++this.sharedObservation;
    const snapshot = await this.sharedClient.request(SHARED_INTERACTIONS_READ, { threadId });
    if (!this.disposed && revision === this.connectionRevision) this.applyShared(snapshot, observation, threadId);
  }
  private applyShared(value: unknown, observation: number, expectedThreadId?: string): void {
    const snapshot = parseSharedInteractionSnapshot(value);
    if (this.disposed || !snapshot || (expectedThreadId !== undefined && snapshot.threadId !== expectedThreadId)) return;
    const { threadId, epoch, revision } = snapshot;
    if (this.retiredSharedEpochs.has(JSON.stringify([threadId, epoch]))) return;
    const previous = this.sharedSnapshots.get(threadId);
    const olderObservation = previous !== undefined && observation < previous.observation;
    if (previous?.epoch === epoch && previous.revision > revision) return;
    // Revisions only order facts within one producer. A reply to an earlier
    // read cannot replace a producer that the view has since observed.
    if (olderObservation && (previous.epoch !== epoch || previous.revision === revision)) return;
    if (previous && previous.epoch !== epoch) this.retiredSharedEpochs.add(JSON.stringify([threadId, previous.epoch]));
    while (this.retiredSharedEpochs.size > 1024) this.retiredSharedEpochs.delete(this.retiredSharedEpochs.values().next().value!);

    // Subscriber permission can change without incrementing a producer's
    // revision. Keep the latest permission even when an older read has newer facts.
    const canRespond = olderObservation ? previous.canRespond : snapshot.canRespond;
    const requests = new Map<string, SharedPendingInteraction>();
    for (const source of snapshot.requests) {
      const requestId = `host-interaction:${source.id}`;
      requests.set(requestId, {
        requestId, method: source.method,
        threadId, turnId: typeof source.params.turnId === "string" ? source.params.turnId : null,
        itemId: typeof source.params.itemId === "string" ? source.params.itemId : typeof source.params.callId === "string" ? source.params.callId : null,
        params: source.params, receivedAtMs: source.receivedAtMs,
        responseState: source.state, canRespond: canRespond && source.canRespond !== false,
      } as SharedPendingInteraction);
    }
    this.sharedSnapshots.set(threadId, {
      epoch, revision, canRespond, observation: Math.max(previous?.observation ?? 0, observation), requests,
    });
    const remove = [...(previous?.requests.keys() ?? [])].filter(id => !requests.has(id));
    if (remove.length > 0 || requests.size > 0)
      this.sharedStore?.applyPendingInteractionPatch(threadId, { remove, upsert: [...requests.values()] });
  }

  private capture<TMethod extends AppServerServerMethod>(
    method: TMethod,
    params: AppServerServerRequestParams<TMethod>,
    id: JsonRpcId,
    context: ServerRequestResponseContext,
  ): Promise<AppServerServerRequestResult<TMethod>> {
    if (this.disposed || context.signal.aborted) return Promise.reject(new AppServerInteractionError("DISCONNECTED", "Interaction request is no longer active"));
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
      context.signal.addEventListener("abort", () => {
        if (context.retirement === "resolved") this.ledger.forget(interaction);
        else if (context.retirement === "answered") this.ledger.markDelivered(interaction, remembered.response);
      }, { once: true });
      return Promise.resolve(result as AppServerServerRequestResult<TMethod>);
    }
    return new Promise<AppServerServerRequestResult<TMethod>>((resolve, reject) => {
      const deferred: DeferredServerRequest<TMethod> = {
        method,
        interaction,
        resolve,
        reject,
        delivered: context.delivered,
        context,
        removeRetirementListener: () => context.signal.removeEventListener("abort", retire),
      };
      const retire = () => {
        if (this.pending.get(requestId) !== deferred) return;
        // Release the exact native owner and settle before synchronous View
        // observers can admit a successor with the same wire id.
        this.pending.delete(requestId);
        deferred.removeRetirementListener();
        if (context.retirement === "resolved") this.ledger.forget(interaction);
        else if (context.retirement === "answered" && deferred.response) this.ledger.markDelivered(interaction, deferred.response);
        if (context.retirement === "lost") reject(new AppServerInteractionError("DISCONNECTED", "Native request lost its connection"));
        else resolve(cancelledResult(deferred as DeferredServerRequest) as AppServerServerRequestResult<TMethod>);
        this.store.removePendingInteraction(interaction.threadId, requestId);
      };
      this.pending.set(requestId, deferred as DeferredServerRequest);
      context.signal.addEventListener("abort", retire, { once: true });
      try {
        this.store.upsertPendingInteraction(interaction);
      } catch (error) {
        if (this.pending.get(requestId) === deferred) this.pending.delete(requestId);
        deferred.removeRetirementListener();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private failAll(error: Error): void {
    const pending = [...this.pending.entries()];
    this.pending.clear();
    for (const [requestId, request] of pending) {
      request.removeRetirementListener();
      request.reject(error);
      this.store.removePendingInteraction(request.interaction.threadId, requestId);
    }
  }
}
