import { ThreadCatalogPublisher } from "@opencraft/app-host-server/thread-catalog";
import { HostInteractions, InteractionFault, InteractionResponseNotDispatched } from "@opencraft/app-host-server/interactions";
import { createHash, randomUUID } from "node:crypto";
import { OPENCRAFT_DESKTOP_ATTACH } from "@opencraft/appserver-protocol/desktop";
import { COLLABORATION_METHOD } from "@opencraft/appserver-protocol/collaboration";
import {
  BridgeInteractionSnapshotIncomplete, BridgeOutboxReadError, type BridgeGatewaySession,
} from "@opencraft/agent-bridge-host/gateway-session";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import type {
  DuplexTransport,
  TransportStatus,
  TransportSubmissionContext,
} from "@opencraft/appserver-client/transport";
import {
  OPENCRAFT_STEER_EVIDENCE_NOTIFICATION,
  OPENCRAFT_STEER_EVIDENCE_EXTENSION,
  OPENCRAFT_THREAD_GOAL_EXTENSION,
  OPENCRAFT_THREAD_QUEUE_EXTENSION,
  SHARED_INTERACTIONS_CHANGED,
  SHARED_INTERACTIONS_EXTENSION,
  SHARED_INTERACTIONS_READ,
  SHARED_INTERACTIONS_RESPOND,
  isHumanInteraction,
  type InputCompletion,
} from "@opencraft/appserver-protocol";
import { CODEX_MAINTENANCE_READ, codexMaintenanceError, isCodexAdmission } from "./codex-admission-policy.js";
import { readQueuedInputCompletion } from "./input-completion.js";
import { projectThreadTopologyResult } from "./thread-orchestration-projection.js";

type BridgeQueueRow = {
  id: string;
  clientUserMessageId: string;
  state: string;
  targetTurnId: string | null;
  delivery?: unknown;
};
type BridgeClient = { evidence: boolean; sharedInteractions: boolean; epoch: number };
type BridgeSubscription = { mode: "observing" | "live" | "archive" };
/** Internal reply metadata consumed by BridgeExecutionAdmissionTransport. */
export const BRIDGE_ACCEPTED_REPLAY = "__opencraftBridgeAcceptedReplay";
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// Renderers that negotiated item details with an earlier Bridge may still
// ask for presentation pages. Codex's native page modes include full only
// for reads that require the whole Item.
const bridgeHistoryItemsView = (view: unknown): unknown => view === "presentation" ? "full" : view;

export async function observeCodexBridgeHistory(
  gateway: Pick<BridgeGatewaySession, "observe">,
  threadId: string,
  method: "thread/read" | "thread/turns/list" | "thread/items/list",
  params: Record<string, unknown>,
  onMetadata?: (archived: boolean) => void,
): Promise<unknown> {
  const archive = params.openArchivedHistory === true ? { openArchivedHistory: true } : {};
  if (method === "thread/read") {
    const includeTurns = params.includeTurns === true;
    // Admit a live watch before its first body snapshot, even for callers
    // that request Thread metadata and the complete transcript together.
    if (onMetadata && includeTurns) {
      const metadata = await gateway.observe(threadId, { view: "thread", includeTurns: false, ...archive });
      onMetadata(object(object(metadata).thread).archived === true);
    }
    const result = await gateway.observe(threadId, { view: "thread", includeTurns, ...archive });
    onMetadata?.(object(object(result).thread).archived === true);
    if (!params.initialTurnsPage) return result;
    const { limit, sortDirection, itemsView } = object(params.initialTurnsPage);
    const initialTurnsPage = await gateway.observe(threadId, {
      limit, sortDirection, itemsView: bridgeHistoryItemsView(itemsView), ...archive,
    });
    return { ...object(result), initialTurnsPage };
  }
  const { turnId, cursor, limit, sortDirection, itemsView } = params;
  if (method === "thread/turns/list" && params.detailItemId !== undefined)
    throw Object.assign(Error("Item details are unavailable for Bridge history"), { code: -32601, kind: "unsupported" });
  return gateway.observe(threadId, {
    ...archive,
    cursor: cursor ?? null,
    ...(limit !== undefined ? { limit } : {}),
    ...(sortDirection !== undefined ? { sortDirection } : {}),
    ...(method === "thread/items/list"
      ? { view: "items", ...(turnId != null ? { turnId } : {}) }
      : itemsView !== undefined ? { itemsView: bridgeHistoryItemsView(itemsView) } : {}),
  });
}

/** Opt-in composition around the existing Core path. No gateway child/owner. */
/** Turn notifications usage collection follows (see the local Host's token usage runtime). */
const PASSIVE_THREAD_REQUESTS = new Set([
  "thread/turns/list", "thread/items/list", "thread/searchOccurrences", "thread/history/cancel", "thread/unsubscribe",
  "thread/queue/list", "thread/queue/find", "thread/queue/collaborationReceipt", "thread/goal/get", "opencraft/steer/status",
]);

const USAGE_NOTIFICATIONS = new Set([
  "turn/started",
  "turn/completed",
  "thread/tokenUsage/updated",
  "thread/status/changed",
]);

export class CodexProviderBridgeSession implements DuplexTransport {
  private gateway: BridgeGatewaySession;
  private listeners = new Set<(frame: string) => void>();
  private clients = new Map<string, BridgeClient>();
  private clientEpoch = 0;
  // Bridge admission and identities are already durable in Engine Host. Retain
  // its directory updates until the native index reports them.
  private readonly catalog = new ThreadCatalogPublisher((method, params) => {
    for (const client of this.clients.keys()) this.emit({ method, params }, client);
  }, true);
  private subscriptions = new Map<string, Map<string, BridgeSubscription>>();
  private pending = new Map<string, { method: string; client: string; params?: Record<string, unknown> }>();
  private interactions = new Map<string, { threadId: string; clients: Map<string, number> }>();
  private readonly humanInteractions = new HostInteractions();
  private poll?: ReturnType<typeof setInterval>;
  private closed = false;
  private connecting?: Promise<void>;
  private creations = new Set<Promise<unknown>>();
  // Bridge admissions are invisible to the legacy Host's maintenance snapshot; merge them in.
  private admissionsInFlight = 0;
  private rejectedAdmissions = 0;
  /** `admissionPaused` is the same maintenance switch the legacy Host obeys. */
  constructor(
    private legacy: DuplexTransport,
    createGateway: (publish: (threadId: string, value: unknown) => void) => BridgeGatewaySession,
    private readonly policy: {
      admissionPaused?: () => boolean;
      /** Stage attachments and record a new submission unless editing an existing queue item. */
      prepareInput?: (
        threadId: string,
        clientId: string | undefined,
        input: readonly unknown[],
        context: TransportSubmissionContext,
        purpose?: "queue-edit",
      ) => Promise<unknown[]>;
      /** Add recorded attachments to history results. */
      projectHistory?: (method: string, params: Record<string, unknown>, result: unknown) => unknown;
      /**
       * Trusted Host dispatcher for dynamic tools (as the local Host's nativeTool). Null leaves a
       * tool to the clients; domain authorization and effect receipts belong to the dispatcher.
       */
      nativeTool?: (
        context: { threadId: string; turnId: string; callId: string },
        tool: { namespace: string | null; name: string },
        args: unknown,
        signal: AbortSignal,
      ) => Promise<unknown> | null;
      /**
       * Token usage of bridge Threads, recorded under their native session and turns as the
       * local Host records its own: submissions before they are sent, their outcome once the
       * native turn is known, and the turn notifications usage collection follows.
       */
      usage?: {
        notification(method: string, params: Record<string, unknown>): void;
        begin(
          nativeThreadId: string,
          publicThreadId: string,
          inputId: string,
          mode: "start" | "steer",
          context: TransportSubmissionContext,
        ): Promise<string | undefined>;
        settle(
          attemptId: string,
          outcome: "accepted" | "rejected" | "unknown",
          nativeThreadId: string,
          inputId: string,
          nativeTurnId?: string,
        ): void;
      };
      /** Personal Git authority and launch state belong to the local execution owner. */
      executionGit?: {
        prepare(nativeThreadId: string, inputId: string, context: TransportSubmissionContext): Promise<{
          environment: Readonly<Record<string, string>>;
          settle(outcome: "accepted" | "rejected" | "unknown", nativeTurnId?: string): void;
        }>;
        notification(method: string, params: Record<string, unknown>): void;
      };
      /** Dynamic tools every new bridge Thread declares (replacing same-named client declarations). */
      creationTools?: () => readonly Record<string, unknown>[];
      /** Live notifications of a bridge Thread, enriched as projectHistory enriches reads. */
      projectNotification?: (frame: Record<string, unknown>) => Record<string, unknown>;
      /** Whether prepareInput records verified senders (and projectHistory restores them) now. */
      senderAttribution?: () => boolean;
      /**
       * Collaboration checks of a queue request (Actor input, receipts, authorization), with
       * a finder over this Thread's queue. A reply answers the request here; null forwards it.
       */
      queueGuard?: (
        threadId: string,
        method: string,
        params: Record<string, unknown>,
        context: TransportSubmissionContext,
        find: (
          by: { queuedSubmissionId: string } | { clientUserMessageId: string },
        ) => Promise<BridgeQueueRow | null>,
        completion?: (row: BridgeQueueRow) => Promise<InputCompletion>,
      ) => Promise<{ result: Record<string, unknown> } | null>;
      /** Translate an OpenCraft permission mode into the provider's own permission fields. */
      resolvePermissions?: (selection: string, cwd: unknown) => Promise<Record<string, unknown>>;
      /** A new private directory for a Thread created without a workspace ("temporary workspace"). */
      projectlessWorkspace?: () => Promise<string>;
      /** Create every new Thread through the bridge, also for clients that do not ask for it. Off by default. */
      newThreads?: boolean;
      /** A request-scoped owner may drive event pulls itself. */
      manualPull?: boolean;
      initialEventPull?: boolean;
      /** The caller provides a live retry loop when it drives event pulls. */
      retryInitialEventPull?: boolean;
      /**
       * The bridge owns every Thread (no legacy Host underneath): new Threads are
       * created here, and any other Thread moves here on its first Thread request.
       * One it cannot adopt is only read by the layer below. Implies newThreads.
       */
      exclusive?: boolean;
      /** Move an existing local Thread to the bridge on its next turn/start, keeping its ID. Off by default. */
      adoptExisting?: boolean;
      /** The local Host releases an idle Thread for adoption, or declines. */
      releaseForAdoption?: (threadId: string) => Promise<boolean>;
      /** Let the local title generator see a bridge Thread's creation and first turn, by native identity. */
      observeTitle?: (method: string, params: Record<string, unknown>, result: unknown) => void;
      /** Report successful operations to the Host's identity owner using public Thread IDs. */
      observeIdentityResult?: (
        method: string,
        params: Record<string, unknown>,
        result: unknown,
        sender: TransportSubmissionContext["sender"],
      ) => void;
      /** Thread orchestration topology (parentThreadId / visibility) keyed by public Thread ID. */
      topology?: (threadId: string) => { parentThreadId: string | null; visibility: "visible" | "hidden" } | null;
      beforeUserInput?: (method: string, threadId: string) => void;
    } = {},
  ) {
    this.gateway = createGateway((threadId, value) => {
      const frame = object(value);
      this.observeSubscriptionLifecycle(threadId, frame.method);
      if (typeof frame.method === "string" && frame.id === undefined) {
        this.catalog.observeNotification(frame.method, { ...object(frame.params), threadId });
      }
      this.observeEvent(threadId, frame);
      if (frame.method === "interaction/resolved") {
        const id = object(frame.params).interactionId;
        if (typeof id !== "string") return;
        this.interactions.delete(id);
        this.humanInteractions.resolveNative(id, threadId);
        // Resolved elsewhere (the Turn ended): a Host tool still running stops and answers nothing.
        this.hostTools.get(id)?.abort();
        this.hostTools.delete(id);
        for (const client of this.liveSubscribers(threadId))
          this.emit({ method: "serverRequest/resolved", params: { threadId, requestId: id } }, client);
        return;
      }
      if (frame.method === "interaction/request") {
        this.offerInteraction(threadId, frame);
        return;
      }
      if (this.policy.usage && typeof frame.method === "string" && USAGE_NOTIFICATIONS.has(frame.method))
        this.observeUsage(threadId, frame.method, object(frame.params));
      if (this.policy.executionGit && typeof frame.method === "string"
        && ["turn/started", "turn/completed", "item/started", "item/completed"].includes(frame.method)) {
        const params = object(frame.params);
        const nativeThreadId = this.gateway.nativeThread(threadId);
        const nativeTurnId = this.nativeTurnOf(threadId, object(params.turn).id ?? params.turnId);
        if (nativeThreadId && nativeTurnId) this.policy.executionGit.notification(frame.method, {
          ...params, threadId: nativeThreadId, turnId: nativeTurnId,
        });
      }
      // Forwarded native notifications name native turns; clients know public ones.
      const params = object(frame.params);
      if (typeof params.turnId === "string")
        frame.params = { ...params, turnId: this.gateway.canonicalTurn(threadId, params.turnId) ?? params.turnId };
      // Live user messages carry their recorded sender, as history reads do.
      const outgoing = this.policy.projectNotification ? this.policy.projectNotification(frame) : frame;
      this.deliverThreadNotification(threadId, outgoing);
    });
    legacy.subscribeMessage((frame) => {
      void this.receiveLegacy(frame).catch(() => {});
    });
    this.humanInteractions.subscribe(threadId => {
      for (const client of this.liveSubscribers(threadId))
        if (this.clients.get(client)?.sharedInteractions)
          this.emit({ method: SHARED_INTERACTIONS_CHANGED, params: this.humanInteractions.snapshot(threadId, true) }, client);
    });
  }
  /**
   * Settle whether `method` on `threadId` runs on the bridge: an existing local Thread this
   * bridge would adopt for it is adopted now. Execution admission asks before it admits.
   */
  async prepareRoute(method: string, threadId: string, watch?: unknown): Promise<boolean> {
    const passive = (method === "thread/read" && watch !== true) || PASSIVE_THREAD_REQUESTS.has(method);
    const adopting = this.policy.exclusive
      ? !passive
      : method === "turn/start" && this.policy.adoptExisting;
    if (adopting && threadId && !threadId.startsWith("bridge:codex:") && !this.gateway.owns(threadId))
      await this.adopt(threadId);
    return threadId.startsWith("bridge:codex:") || this.gateway.owns(threadId);
  }
  /** Submissions whose native turn is not known yet, by public Thread and canonical turn. */
  private readonly usageAwaitingTurn = new Map<
    string,
    { attemptId: string; inputId: string; nativeThreadId: string }
  >();
  /** The native turn behind a canonical turn ID; a command result may already name the native turn. */
  private nativeTurnOf(threadId: string, turnId: unknown): string | undefined {
    if (typeof turnId !== "string" || !turnId) return undefined;
    if (this.gateway.canonicalTurn(threadId, turnId) !== undefined) return turnId;
    try {
      return this.gateway.nativeTurn(threadId, turnId);
    } catch {
      return undefined;
    }
  }
  /** Turn notifications for usage collection, named by native session and turn. */
  private observeUsage(threadId: string, method: string, params: Record<string, unknown>): void {
    const nativeThreadId = this.gateway.nativeThread(threadId);
    if (!nativeThreadId) return;
    const turn = object(params.turn),
      canonicalTurn = typeof turn.id === "string" ? turn.id : params.turnId;
    const nativeTurnId = this.nativeTurnOf(threadId, canonicalTurn);
    // A submission waits under the turn ID its command returned: canonical or already native.
    const awaitingKey = [canonicalTurn, nativeTurnId]
      .filter((value): value is string => typeof value === "string")
      .map((value) => JSON.stringify([threadId, value]))
      .find((key) => this.usageAwaitingTurn.has(key));
    const awaiting = awaitingKey ? this.usageAwaitingTurn.get(awaitingKey) : undefined;
    if (awaiting && nativeTurnId) {
      this.usageAwaitingTurn.delete(awaitingKey!);
      this.policy.usage!.settle(
        awaiting.attemptId,
        "accepted",
        awaiting.nativeThreadId,
        awaiting.inputId,
        nativeTurnId,
      );
    }
    this.policy.usage!.notification(method, {
      ...params,
      threadId: nativeThreadId,
      ...(typeof params.turnId === "string"
        ? { turnId: this.nativeTurnOf(threadId, params.turnId) ?? params.turnId }
        : {}),
      ...(typeof turn.id === "string" ? { turn: { ...turn, id: nativeTurnId ?? turn.id } } : {}),
    });
  }
  /** Record a submission's usage attribution around its command, as the local Host does. */
  private async withUsage<T>(
    threadId: string,
    inputId: string,
    mode: "start" | "steer",
    context: TransportSubmissionContext,
    send: () => Promise<T>,
    acceptedTurn: (result: T) => unknown,
  ): Promise<T> {
    // A new bridge Thread's native identity may not have been pulled yet.
    if (this.policy.usage && !this.gateway.nativeThread(threadId)) await this.gateway.pull().catch(() => {});
    const nativeThreadId = this.policy.usage ? this.gateway.nativeThread(threadId) : undefined;
    const attemptId = nativeThreadId
      ? await this.policy.usage!.begin(nativeThreadId, threadId, inputId, mode, context)
      : undefined;
    let result: T;
    try {
      result = await send();
    } catch (error) {
      const kind = object(error).kind;
      if (attemptId)
        this.policy.usage!.settle(
          attemptId,
          ["explicit-reject", "invalid", "stale-target"].includes(String(kind)) ? "rejected" : "unknown",
          nativeThreadId!,
          inputId,
        );
      throw error;
    }
    if (attemptId) {
      const canonical = acceptedTurn(result),
        nativeTurnId = this.nativeTurnOf(threadId, canonical);
      if (nativeTurnId) this.policy.usage!.settle(attemptId, "accepted", nativeThreadId!, inputId, nativeTurnId);
      else if (typeof canonical === "string" && canonical)
        this.usageAwaitingTurn.set(JSON.stringify([threadId, canonical]), {
          attemptId,
          inputId,
          nativeThreadId: nativeThreadId!,
        });
      else this.policy.usage!.settle(attemptId, "unknown", nativeThreadId!, inputId);
    }
    return result;
  }
  /** Dynamic tool calls the trusted Host dispatcher answers itself, by interaction ID. */
  private readonly hostTools = new Map<string, AbortController>();
  /**
   * Offer a dynamic tool call to the Host's dispatcher first, as the local Host
   * does for its own Threads; a tool it does not own goes on to the clients.
   */
  private claimHostTool(threadId: string, frame: Record<string, unknown>): boolean {
    const params = object(frame.params),
      interactionId = params.interactionId;
    if (typeof interactionId !== "string") return false;
    if (this.hostTools.has(interactionId)) return true;
    if (params.kind !== "codex/dynamic-tool" || !this.policy.nativeTool) return false;
    const call = object(this.gateway.history(threadId, object(params.payload).params));
    const abort = new AbortController();
    let operation: Promise<unknown> | null;
    try {
      operation = this.policy.nativeTool(
        { threadId, turnId: String(call.turnId ?? ""), callId: String(call.callId ?? "") },
        { namespace: typeof call.namespace === "string" ? call.namespace : null, name: String(call.tool ?? "") },
        call.arguments,
        abort.signal,
      );
    } catch (error) {
      operation = Promise.reject(error);
    }
    if (operation === null) return false;
    this.hostTools.set(interactionId, abort);
    void operation
      .catch(() => ({
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "Tool execution unavailable or unauthorized. Inspect the existing result before retrying.",
          },
        ],
      }))
      .then((result) =>
        abort.signal.aborted
          ? undefined
          : this.gateway.command(threadId, `interaction:${interactionId}`, "interaction/resolve", {
              interactionId,
              result,
            }),
      )
      .catch(() => {})
      .finally(() => {
        if (this.hostTools.get(interactionId) === abort) this.hostTools.delete(interactionId);
      });
    return true;
  }
  private offerInteraction(threadId: string, frame: Record<string, unknown>, onlyClient?: string): void {
    const params = object(frame.params),
      payload = object(params.payload);
    if (typeof params.interactionId !== "string" || typeof payload.method !== "string") return;
    const source = {
      id: params.interactionId,
      method: payload.method,
      params: { ...object(this.gateway.history(threadId, payload.params)), threadId },
      __opencraftInteractionKey: params.interactionId,
    };
    if (isHumanInteraction(source.method, source.params)) {
      if (!this.humanInteractions.threadForNative(source.id)) this.humanInteractions.capture(source);
      for (const client of onlyClient ? [onlyClient] : this.liveSubscribers(threadId)) {
        const identity = this.clients.get(client);
        if (identity && !identity.sharedInteractions && this.isLiveSubscriber(threadId, client))
          this.humanInteractions.offerLegacy(threadId, client, ({ id, method, params }) => this.emit({ id, method, params }, client));
      }
      return;
    }
    if (this.claimHostTool(threadId, frame)) return;
    const interaction = this.interactions.get(params.interactionId) ?? { threadId, clients: new Map<string, number>() };
    this.interactions.set(params.interactionId, interaction);
    for (const client of onlyClient ? [onlyClient] : this.liveSubscribers(threadId)) {
      const identity = this.clients.get(client);
      if (
        !identity ||
        !this.isLiveSubscriber(threadId, client) ||
        interaction.clients.get(client) === identity.epoch
      )
        continue;
      interaction.clients.set(client, identity.epoch);
      this.emit(
        {
          id: params.interactionId,
          method: payload.method,
          params: { ...object(this.gateway.history(threadId, payload.params)), threadId },
        },
        client,
      );
    }
  }
  private assertInteractionSubscription(threadId: string, client: string, identity: BridgeClient,
    context: TransportSubmissionContext, expected?: BridgeSubscription): BridgeSubscription {
    context.resourceOwner?.assertCurrent();
    const current = this.subscriptions.get(threadId)?.get(client);
    if (this.closed || this.clients.get(client) !== identity || current?.mode !== "live" || (expected && current !== expected))
      throw new InteractionFault({ code: "SOURCE_UNAVAILABLE" }, "Interaction subscription expired");
    return current;
  }
  private async replyToInteraction(threadId: string, client: string, identity: BridgeClient, context: TransportSubmissionContext,
    interactionId: string, result: Record<string, unknown>, assertCurrent: () => void, subscription: BridgeSubscription): Promise<void> {
    await this.gateway.command(threadId, `interaction:${interactionId}`, "interaction/resolve", { interactionId, result }, () => {
      try {
        this.assertInteractionSubscription(threadId, client, identity, context, subscription);
        assertCurrent();
      } catch (cause) { throw new InteractionResponseNotDispatched(cause); }
    });
  }
  private async restorePendingInteractions(threadId: string, client: string, identity: BridgeClient,
    context: TransportSubmissionContext, interactionId?: string): Promise<BridgeSubscription> {
    const subscription = this.assertInteractionSubscription(threadId, client, identity, context);
    const requests = await this.gateway.pendingInteractions(threadId, interactionId).catch(error => {
      if (error instanceof BridgeInteractionSnapshotIncomplete)
        throw new InteractionFault({ code: "SOURCE_UNAVAILABLE" }, error.message);
      throw error;
    });
    for (const pending of requests) {
      this.assertInteractionSubscription(threadId, client, identity, context, subscription);
      this.offerInteraction(threadId, object(pending), client);
    }
    return subscription;
  }
  private async sharedInteractionRequest(method: string, threadId: string, client: string, identity: BridgeClient,
    params: Record<string, unknown>, context: TransportSubmissionContext) {
    if (!identity.sharedInteractions) throw new InteractionFault({ code: "UNSUPPORTED" }, "Shared interactions were not negotiated");
    if (method === SHARED_INTERACTIONS_READ) {
      const subscription = await this.restorePendingInteractions(threadId, client, identity, context);
      this.assertInteractionSubscription(threadId, client, identity, context, subscription);
      return this.humanInteractions.snapshot(threadId, true);
    }
    const { interactionId, submissionId, result } = params;
    if (typeof interactionId !== "string" || !interactionId || typeof submissionId !== "string" ||
      !submissionId || !result || typeof result !== "object" || Array.isArray(result))
      throw new InteractionFault({ code: "INVALID_RESPONSE" }, "Invalid interaction response");
    const subscription = await this.restorePendingInteractions(threadId, client, identity, context, interactionId);
    this.assertInteractionSubscription(threadId, client, identity, context, subscription);
    const disposition = await this.humanInteractions.respond(threadId, interactionId, submissionId, object(result),
      (source, answer, assertCurrent) => this.replyToInteraction(threadId, client, identity, context, String(source.id), answer, assertCurrent, subscription));
    return { disposition, snapshot: this.humanInteractions.snapshot(threadId, true) };
  }
  private eventObservers = new Set<(method: string, params: Record<string, unknown>) => void>();
  /** Every Thread event the bridge delivers, whether or not a client watches that Thread (Host duties). */
  observeEvents(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.eventObservers.add(listener);
    return () => {
      this.eventObservers.delete(listener);
    };
  }
  private observeEvent(threadId: string, frame: Record<string, unknown>): void {
    if (typeof frame.method !== "string" || frame.id !== undefined || !this.eventObservers.size) return;
    const params = object(frame.params);
    const projected = object(this.gateway.history(threadId, params));
    const visible = {
      ...projected,
      threadId,
      ...(typeof params.turnId === "string"
        ? { turnId: this.gateway.canonicalTurn(threadId, params.turnId) ?? params.turnId }
        : {}),
    };
    for (const listener of this.eventObservers) {
      try {
        listener(frame.method, visible);
      } catch {
        /* observers never affect delivery */
      }
    }
  }
  private adoptions = new Map<string, Promise<void>>();
  /** Recently declined adoptions; retried after a while, not on every read. */
  private declined = new Map<string, number>();
  /**
   * Move an idle local Thread to the bridge under its own ID. The local Host
   * releases it first; if it declines or the Host refuses, the Thread simply
   * stays local. Nothing is executed before the Host has bound it.
   */
  private adopt(threadId: string): Promise<void> {
    const pending = this.adoptions.get(threadId);
    if (pending) return pending;
    if ((this.declined.get(threadId) ?? 0) > Date.now()) return Promise.resolve();
    const operation = (async () => {
      if (!(await this.policy.releaseForAdoption?.(threadId))) return;
      try {
        await this.gateway.command(threadId, `bridge-adopt:${randomUUID()}`, "session/adopt", {
          providerThreadId: threadId,
        });
        this.declined.delete(threadId);
      } catch (error) {
        if (this.declined.size > 4096) this.declined.clear();
        this.declined.set(threadId, Date.now() + 30_000);
        console.warn(
          "[codex-bridge]",
          JSON.stringify({ event: "adoption-declined", reason: error instanceof Error ? error.message : "unknown" }),
        );
      }
    })().finally(() => this.adoptions.delete(threadId));
    this.adoptions.set(threadId, operation);
    return operation;
  }
  /** What this bridge and its Host still hold, for the Host's maintenance snapshot. */
  async maintenance(): Promise<{
    pendingAdmissions: number;
    rejectedAdmissions: number;
    queued: number;
    unknown: number;
    pendingApprovals: number;
  }> {
    const host = await this.gateway.maintenance();
    return {
      pendingAdmissions: this.admissionsInFlight + host.inFlight,
      rejectedAdmissions: this.rejectedAdmissions,
      queued: host.queued,
      unknown: host.unknown,
      pendingApprovals: this.interactions.size,
    };
  }
  /** Public and native identities of bridge Threads, for Host services that address native Codex directly. */
  threadIdentities(): {
    toNative(threadId: string): string | undefined;
    toPublic(nativeId: string): string | undefined;
  } {
    return {
      toNative: (threadId) => (this.gateway.owns(threadId) ? this.gateway.nativeThread(threadId) : undefined),
      toPublic: (nativeId) => this.gateway.publicThread(nativeId),
    };
  }
  /** Rewrite native turn IDs in queue results to the public ones clients know. */
  private publicTurns(threadId: string, value: unknown): unknown {
    if (Array.isArray(value)) return value.map((entry) => this.publicTurns(threadId, entry));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        (key === "targetTurnId" || key === "turnId") && typeof entry === "string"
          ? (this.gateway.canonicalTurn(threadId, entry) ?? entry)
          : key === "turn" && entry && typeof entry === "object"
            ? object(this.gateway.history(threadId, { turn: entry })).turn
            : this.publicTurns(threadId, entry),
      ]),
    );
  }
  private isLiveSubscriber(threadId: string, client: string): boolean {
    return this.subscriptions.get(threadId)?.get(client)?.mode === "live";
  }
  private *liveSubscribers(threadId: string): Iterable<string> {
    for (const [client, subscription] of this.subscriptions.get(threadId) ?? [])
      if (subscription.mode === "live") yield client;
  }
  private archiveSubscriptions(threadId: string): void {
    const subscribers = this.subscriptions.get(threadId);
    if (!subscribers) return;
    for (const client of subscribers.keys()) {
      // Replacing the token fences history that was still awaiting metadata.
      subscribers.set(client, { mode: "archive" });
      this.forgetInteractionOffers(client, threadId);
    }
  }
  private observeSubscriptionLifecycle(threadId: string, method: unknown): void {
    if (method === "thread/archived" || method === "thread/deleted") this.archiveSubscriptions(threadId);
    if (method === "thread/unarchived") {
      const subscribers = this.subscriptions.get(threadId);
      if (!subscribers) return;
      for (const [client, subscription] of subscribers)
        if (subscription.mode !== "live") subscribers.set(client, { mode: "observing" });
    }
  }
  private deliverThreadNotification(threadId: string, frame: Record<string, unknown>): void {
    const lifecycle = frame.method === "thread/archived" || frame.method === "thread/unarchived" || frame.method === "thread/deleted";
    for (const [client, subscription] of this.subscriptions.get(threadId) ?? []) {
      if (subscription.mode !== "live" && !lifecycle) continue;
      if (frame.method === OPENCRAFT_STEER_EVIDENCE_NOTIFICATION && !this.clients.get(client)?.evidence) continue;
      this.emit(frame, client);
    }
  }
  /** Native sends lifecycle notifications only to the bridge's own connection; mirror them for subscribers. */
  private notify(threadId: string, method: string, params: Record<string, unknown>): void {
    this.observeSubscriptionLifecycle(threadId, method);
    const frame = { method, params };
    this.observeEvent(threadId, frame);
    this.deliverThreadNotification(threadId, frame);
  }
  private forgetInteractionOffers(client: string, threadId?: string): void {
    this.humanInteractions.forgetClient(client, threadId);
    for (const interaction of this.interactions.values())
      if (!threadId || interaction.threadId === threadId) interaction.clients.delete(client);
  }
  private revokeClient(client: string, threadId?: string): void {
    for (const [thread, subscribers] of this.subscriptions) {
      if (threadId && thread !== threadId) continue;
      subscribers.delete(client);
      if (!subscribers.size) this.subscriptions.delete(thread);
    }
    this.forgetInteractionOffers(client, threadId);
  }
  get status() {
    return this.legacy.status;
  }
  subscribeStatus(listener: (status: TransportStatus) => void) {
    return this.legacy.subscribeStatus(listener);
  }
  subscribeMessage(listener: (frame: string) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  connect(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(Error("Bridge gateway is closed"));
    return (this.connecting ??= (async () => {
      await this.gateway.open({ live: this.policy.initialEventPull ?? true }).catch(error => {
        const canRetry = !this.policy.manualPull || this.policy.retryInitialEventPull;
        if (!canRetry || !(error instanceof BridgeOutboxReadError && error.retryable)) throw error;
      });
      await this.legacy.connect(signal);
      if (!this.policy.manualPull)
        this.poll = setInterval(() => {
          void this.gateway.pull().catch(() => {});
        }, 100);
    })());
  }
  pull(): Promise<void> {
    return this.gateway.pull();
  }
  private emit(frame: unknown, client?: string): void {
    if (this.closed) return;
    const value = JSON.stringify({
      jsonrpc: "2.0",
      ...object(frame),
      ...(client ? { [LOGICAL_CLIENT_FIELD]: client } : {}),
    });
    for (const listener of this.listeners) listener(value);
  }
  private async receiveLegacy(raw: string): Promise<void> {
    // Native creation can broadcast before the create response binds its public
    // identity. Await only those local creates, then filter by durable ownership.
    if (this.creations.size) await Promise.allSettled([...this.creations]);
    const frame = object(JSON.parse(raw)),
      params = object(frame.params);
    if (frame.method === "account/chatgptAuthTokens/refresh") return; // existing Core account owner handles broker authentication
    const bridgeThread = typeof params.threadId === "string" ? this.gateway.publicThread(params.threadId) : undefined;
    // Pins and generated titles of bridge Threads are written by the local Host by native identity.
    if (bridgeThread && ["thread/name/updated", "thread/pins/updated"].includes(String(frame.method))) {
      this.emit({ ...frame, params: { ...params, threadId: bridgeThread } });
      return;
    }
    if (bridgeThread) return;
    const nestedThreadId = object(params.thread).id;
    if (typeof nestedThreadId === "string" && this.gateway.publicThread(nestedThreadId)) return;
    const key = JSON.stringify([frame[LOGICAL_CLIENT_FIELD], frame.id]),
      pending = this.pending.get(key);
    if (pending && ("result" in frame || "error" in frame)) {
      this.pending.delete(key);
      const result = object(frame.result);
      if (pending.method === CODEX_MAINTENANCE_READ && frame.result && typeof frame.result === "object") {
        result.pendingAdmissions = (Number(result.pendingAdmissions) || 0) + this.admissionsInFlight;
        result.rejectedAdmissions = (Number(result.rejectedAdmissions) || 0) + this.rejectedAdmissions;
      }
      if (pending.method === "initialize" && frame.result) {
        frame.result = result;
        const capabilities = object(result.capabilities);
        const extensions = object(capabilities.extensions),
          evidence = this.clients.get(pending.client)?.evidence === true;
        const engineProviders = object(extensions["opencraft/execution-engines"]).providers;
        const inputCapability = {
          version: 1,
          perInputEvidence: true,
          deliveryMethods: ["native-inject"],
          evidenceKinds: ["admission", "native-input-id"],
          withdrawal: "none",
          query: true,
        };
        const threadCapabilities = {
          [SHARED_INTERACTIONS_EXTENSION]: { version: 1 },
          "opencraft/read-history": { version: 1, initialTurnsPage: true, cancellation: false },
          "opencraft/thread-follow-up": { version: 1, queue: true, steer: evidence },
          // Host-owned queue on the shared thread-queue core.
          [OPENCRAFT_THREAD_QUEUE_EXTENSION]: {
            version: 2,
            reorder: true,
            atomicSteer: true,
            unconfirmedSteerDiscard: true,
            unconfirmedDeliveryRetry: true,
            perItemPause: true,
          },
          "opencraft/thread-lifecycle": {
            version: 1,
            fork: true,
            ephemeral: false,
            injectItems: false,
            rename: true,
            archive: true,
            openArchivedHistory: true,
            unsubscribe: true,
            delete: true,
          },
          [OPENCRAFT_THREAD_GOAL_EXTENSION]: { version: 1, read: true, write: true },
          ...(evidence ? { [OPENCRAFT_STEER_EVIDENCE_EXTENSION]: inputCapability } : {}),
        };
        result.capabilities = {
          ...capabilities,
          extensions: {
            ...extensions,
            // Owning every Thread, the bridge's Thread capabilities are the Host's.
            ...(this.policy.exclusive ? threadCapabilities : {}),
            "opencraft/agent-bridge": {
              version: 1,
              providerId: "codex",
              threadOptIn: true,
              threadPrefix: "bridge:codex:",
            },
            ...(evidence ? { [OPENCRAFT_STEER_EVIDENCE_EXTENSION]: inputCapability } : {}),
            "opencraft/execution-engines": {
              ...object(extensions["opencraft/execution-engines"]),
              version: 1,
              providers: [
                ...(Array.isArray(engineProviders) ? engineProviders : []),
                {
                  // A provider entry is the complete capability set of its Threads; owning every Thread, it is the Host's.
                  id: "codex-bridge",
                  label: "Codex",
                  threadPrefix: "bridge:codex:",
                  extensions: this.policy.exclusive
                    ? {
                        ...Object.fromEntries(
                          Object.entries(extensions).filter(
                            ([key]) => !["opencraft/execution-engines", "opencraft/agent-bridge"].includes(key),
                          ),
                        ),
                        ...threadCapabilities,
                      }
                    : threadCapabilities,
                },
              ],
            },
          },
        };
      }
      if (Array.isArray(result.data)) {
        if (pending.method === "thread/list" || pending.method === "opencraft/thread-pins/list") {
          result.data = result.data.map(thread => this.gateway.catalogThread(thread));
        } else if (pending.method === "thread/search") {
          result.data = result.data.map(match => ({ ...object(match), thread: this.gateway.catalogThread(object(match).thread) }));
        }
      }
      if (pending.method === "thread/list" && "result" in frame) {
        this.catalog.observeResult(pending.method, pending.params, result);
        const projected = this.catalog.projectList(pending.params, result);
        frame.result = this.policy.topology
          ? projectThreadTopologyResult(pending.method, projected, this.policy.topology)
          : projected;
      }
    }
    this.emit(frame);
  }
  send(frame: string): Promise<void> {
    return this.sendWithContext(frame, { sender: null });
  }
  async sendWithContext(raw: string, context: TransportSubmissionContext): Promise<void> {
    context.resourceOwner?.assertCurrent();
    if (context.validUntil !== undefined && context.validUntil <= Date.now())
      throw Error("Execution authorization expired");
    const frame = object(JSON.parse(raw)),
      client = String(frame[LOGICAL_CLIENT_FIELD] ?? "");
    const method = typeof frame.method === "string" ? frame.method : undefined;
    let p = object(frame.params);
    // The bridge owns new Threads: one request is one creation, as a native thread/start is.
    if (
      (this.policy.newThreads || this.policy.exclusive) &&
      method === "thread/start" &&
      p.agentBridge === undefined &&
      frame.id !== undefined
    )
      p = { ...p, agentBridge: { threadId: randomUUID(), clientRequestId: `implicit:${randomUUID()}` } };
    if (!client) throw Error("Logical client identity required");
    if (method === "initialize") {
      this.revokeClient(client);
      this.clients.set(client, {
        evidence: !!object(object(p.capabilities).extensions)[OPENCRAFT_STEER_EVIDENCE_EXTENSION],
        sharedInteractions: !!object(object(p.capabilities).extensions)[SHARED_INTERACTIONS_EXTENSION],
        epoch: ++this.clientEpoch,
      });
    }
    if (method === "runtime/client/disconnect") {
      this.clients.delete(client);
      this.revokeClient(client);
      return this.legacy.send(raw);
    }
    if (method === undefined && typeof frame.id === "string") {
      const threadId = this.humanInteractions.threadForNative(frame.id);
      if (threadId) {
        const identity = this.clients.get(client);
        const subscription = this.subscriptions.get(threadId)?.get(client);
        if (!identity || identity.sharedInteractions || subscription?.mode !== "live" ||
          !this.humanInteractions.wasOffered(frame.id, client) || !("result" in frame))
          throw Error("Interaction subscription required");
        await this.humanInteractions.respondNative(frame.id, `legacy:${identity.epoch}:${frame.id}`, object(frame.result),
          (source, result, assertCurrent) => this.replyToInteraction(threadId, client, identity, context, String(source.id), result, assertCurrent, subscription));
        return;
      }
    }
    if (
      method === undefined &&
      typeof frame.id === "string" &&
      frame.id.startsWith("codex-interaction:") &&
      !this.interactions.has(frame.id)
    )
      throw Error("Interaction subscription required");
    if (method === undefined && typeof frame.id === "string" && this.interactions.has(frame.id)) {
      const interaction = this.interactions.get(frame.id)!;
      if (
        interaction.clients.get(client) !== this.clients.get(client)?.epoch ||
        !this.clients.has(client) ||
        !this.isLiveSubscriber(interaction.threadId, client) ||
        !("result" in frame)
      )
        throw Error("Interaction subscription required");
      await this.gateway.command(interaction.threadId, `interaction:${frame.id}`, "interaction/resolve", {
        interactionId: frame.id,
        result: frame.result,
      });
      this.interactions.delete(frame.id);
      return;
    }
    if (method === "opencraft/thread-pins/set" && typeof p.threadId === "string" && this.gateway.owns(p.threadId)) {
      const native = this.gateway.nativeThread(p.threadId);
      if (!native) throw Error("Bridge thread has no native session yet");
      if (frame.id !== undefined) this.pending.set(JSON.stringify([client, frame.id]), { method, client });
      const pinned = JSON.stringify({ ...frame, params: { ...p, threadId: native } });
      return this.legacy.sendWithContext ? this.legacy.sendWithContext(pinned, context) : this.legacy.send(pinned);
    }
    // The local Host's desktop serves bridge Threads too: it reads the Thread by its native session.
    if (method === OPENCRAFT_DESKTOP_ATTACH && typeof p.threadId === "string" && this.gateway.owns(p.threadId)) {
      if (frame.id !== undefined) this.pending.set(JSON.stringify([client, frame.id]), { method, client });
      return this.legacy.sendWithContext ? this.legacy.sendWithContext(raw, context) : this.legacy.send(raw);
    }
    // Thread orchestration control is a trusted lane of the local Host over Core's orchestration
    // channel, independent of Thread routing: a bridge parent is named by its native session.
    if (typeof method === "string" && method.startsWith("opencraft/orchestration/")) {
      const parent =
        typeof p.threadId === "string" && this.gateway.owns(p.threadId)
          ? this.gateway.nativeThread(p.threadId)
          : undefined;
      if (typeof p.threadId === "string" && this.gateway.owns(p.threadId) && !parent)
        throw Error("Bridge thread has no native session yet");
      const routed = parent ? JSON.stringify({ ...frame, params: { ...p, threadId: parent } }) : raw;
      if (frame.id !== undefined) this.pending.set(JSON.stringify([client, frame.id]), { method, client });
      return this.legacy.sendWithContext ? this.legacy.sendWithContext(routed, context) : this.legacy.send(routed);
    }
    const optIn = method === "thread/start" && p.agentBridge !== undefined;
    const optInRequest = object(p.agentBridge);
    const seed = String(optInRequest.threadId ?? "");
    const threadId = optIn
      ? seed
        ? seed.startsWith("bridge:codex:")
          ? seed
          : `bridge:codex:${seed}`
        : ""
      : String(p.threadId ?? "");
    // A native ID behind a different public bridge ID never reaches the legacy writer; an adopted one is its own public ID.
    const behind = this.gateway.publicThread(threadId);
    if (!optIn && behind !== undefined && behind !== threadId)
      throw Error("Use the bridge thread identity; native owner bypass refused");
    // Collaboration is owned by the local Host and uses the public Thread ID.
    if (method === COLLABORATION_METHOD || method?.startsWith("opencraft/schedules/") || method === "opencraft/turn-recovery/read") {
      if (frame.id !== undefined) this.pending.set(JSON.stringify([client, frame.id]), { method, client });
      return this.legacy.sendWithContext ? this.legacy.sendWithContext(raw, context) : this.legacy.send(raw);
    }
    if (!optIn && method !== undefined) await this.prepareRoute(method, threadId, p.watch);
    // Maintenance pauses new work on bridge threads exactly as on legacy ones;
    // steering, reads and approvals of admitted work continue.
    const admission = (optIn || this.gateway.owns(threadId)) && isCodexAdmission(method, p);
    if (admission && this.policy.admissionPaused?.()) {
      this.rejectedAdmissions++;
      console.warn(
        "[codex-admission-audit]",
        JSON.stringify({
          event: "codex-admission-rejected",
          reason: "maintenance",
          route: "bridge",
          method,
          rejectedAdmissions: this.rejectedAdmissions,
        }),
      );
      if (frame.id !== undefined) this.emit({ id: frame.id, error: codexMaintenanceError() }, client);
      return;
    }
    if (optIn && threadId) this.gateway.reserve(threadId);
    // A fork of a bridge Thread is a new bridge Thread; preserve an admission-assigned or deterministic retry ID when supplied.
    const forkSeed = method === "thread/fork" ? String(object(p.agentBridge).threadId ?? "") : "";
    const forkedId =
      method === "thread/fork" && !optIn && this.gateway.owns(threadId)
        ? forkSeed
          ? forkSeed.startsWith("bridge:codex:") ? forkSeed : `bridge:codex:${forkSeed}`
          : typeof p.clientUserMessageId === "string" && p.clientUserMessageId
            ? `bridge:codex:fork-${createHash("sha256").update(JSON.stringify([threadId, p.clientUserMessageId])).digest("hex").slice(0, 32)}`
            : `bridge:codex:${randomUUID()}`
        : undefined;
    if (forkedId) this.gateway.reserve(forkedId);
    if (!optIn && !this.gateway.owns(threadId)) {
      if (threadId.startsWith("bridge:codex:"))
        throw Error("Bridge thread has no retained owner; native fallback refused");
      if (typeof method === "string" && frame.id !== undefined)
        this.pending.set(JSON.stringify([client, frame.id]), { method, client, params: p });
      if (this.legacy.sendWithContext) return this.legacy.sendWithContext(raw, context);
      return this.legacy.send(raw);
    }
    if (method === undefined) throw Error("Bridge request method required");
    const identity = this.clients.get(client);
    if (!identity || frame.id === undefined) throw Error("Initialized client and request ID required");
    const subscribers = this.subscriptions.get(threadId) ?? new Map<string, BridgeSubscription>();
    const watchedRead = method === "thread/read" && p.watch === true;
    const passive = PASSIVE_THREAD_REQUESTS.has(method);
    let watching = watchedRead ? subscribers.get(client) : undefined;
    if (watchedRead && (!watching || watching.mode === "observing")) {
      watching = { mode: "observing" };
      subscribers.set(client, watching);
    }
    // Execution operations can subscribe before their first event. History
    // reads earn a live subscription only after the route's metadata arrives.
    if (
      optIn ||
      [
        "thread/resume",
        "turn/start",
        "thread/fork",
        "thread/name/set",
        "thread/archive",
        "thread/unarchive",
        "thread/delete",
        "thread/goal/set",
        "thread/goal/clear",
      ].includes(method) ||
      (method.startsWith("thread/queue/") && !passive) ||
      method === "thread/settings/update"
    ) {
      const previous = subscribers.get(client);
      if (!previous || previous.mode === "observing") subscribers.set(client, { mode: "live" });
    }
    if (subscribers.size) this.subscriptions.set(threadId, subscribers);
    if (forkedId) this.subscriptions.set(forkedId, new Map([[client, { mode: "live" }]]));
    if (!subscribers.has(client) && !passive && method !== "thread/read")
      throw Error("Conversation subscription required");
    const requestKey = optIn ? optInRequest.clientRequestId : p.clientUserMessageId;
    const commandId =
      typeof requestKey === "string" && requestKey
        ? `bridge-mutation:${createHash("sha256")
            .update(JSON.stringify([threadId, method, requestKey]))
            .digest("hex")}`
        : `bridge-query:${randomUUID()}`;
    const command = (method: string, params: Record<string, unknown>) =>
      this.gateway.command(threadId, commandId, method, params);
    // A verified sender is recorded with the input by the Host that owns attribution; without
    // one, attributed input is refused rather than run unattributed.
    if (context.sender !== null && !(this.policy.senderAttribution?.() && this.policy.prepareInput))
      throw Error("Codex core mode does not support verified sender attribution");
    const prepare = async (input: unknown, clientId: string | undefined, purpose?: "queue-edit") =>
      this.policy.prepareInput && Array.isArray(input)
        ? this.policy.prepareInput(threadId, clientId, input, context, purpose)
        : input;
    const historyRead = ["thread/read", "thread/turns/list", "thread/items/list", "thread/searchOccurrences"].includes(method);
    const execute = async () => {
      let result: unknown;
      let acceptedReplay = false;
      if (!historyRead) await this.gateway.hydrateThread(threadId);
      context.resourceOwner?.assertCurrent();
      if (!context.commitExecution && ["turn/start", "turn/steer", "turn/interrupt"].includes(method))
        this.policy.beforeUserInput?.(method, threadId);
      if (typeof p.permissions === "string" && this.policy.resolvePermissions) {
        try {
          p = { ...p, ...(await this.policy.resolvePermissions(p.permissions, p.cwd)) };
        } catch (error) {
          throw Object.assign(Error(error instanceof Error ? error.message : "Permission mode unavailable"), {
            code: -32602,
            kind: "invalid",
          });
        }
      }
      if (method === SHARED_INTERACTIONS_READ || method === SHARED_INTERACTIONS_RESPOND) {
        result = await this.sharedInteractionRequest(method, threadId, client, identity, p, context);
      } else if (optIn) {
        if (!threadId || typeof requestKey !== "string" || !requestKey)
          throw Error("Bridge thread and client request identities required");
        const { agentBridge: _, ...declared } = p;
        const owned = this.policy.creationTools?.() ?? [];
        const names = new Set(owned.map((tool) => String(tool.name)));
        const native = owned.length
          ? {
              ...declared,
              dynamicTools: [
                ...(Array.isArray(declared.dynamicTools)
                  ? declared.dynamicTools.filter((tool: unknown) => !names.has(String(object(tool).name)))
                  : []),
                ...owned,
              ],
            }
          : declared;
        // A conversation without a workspace gets its own private one, as on the local Host.
        if (native.cwd == null && this.policy.projectlessWorkspace) {
          const cwd = await this.policy.projectlessWorkspace();
          Object.assign(native, { cwd, runtimeWorkspaceRoots: [cwd] });
        }
        // Native can persist an empty paginated Thread before its first input,
        // so the admitted sender's configuration can reload the same Thread.
        if (this.policy.executionGit && native.historyMode == null && native.ephemeral !== true)
          Object.assign(native, { historyMode: "paginated" });
        result = await command("session/create", { native });
        this.policy.observeTitle?.("thread/start", native, result);
      } else if (method === "turn/start") {
        if (!requestKey) throw Error("Stable client input identity required");
        const { threadId: _, opencraftExecutionAdmission, opencraftSessionMcp, ...native } = p;
        native.input = await prepare(native.input, String(requestKey));
        result = await this.withUsage(
          threadId,
          String(requestKey),
          "start",
          context,
          async () => {
            const git = this.policy.executionGit;
            const nativeThreadId = this.gateway.nativeThread(threadId);
            let preparation: Awaited<ReturnType<NonNullable<typeof git>["prepare"]>> | undefined;
            if (git) {
              try {
                if (!nativeThreadId) throw Error("Missing Native Thread identity");
                preparation = await git.prepare(nativeThreadId, String(requestKey), context);
              } catch {
                throw Object.assign(Error("git_execution_unavailable"), { kind: "explicit-reject" });
              }
            }
            let dispatching = false;
            let started: unknown;
            try {
              started = await this.gateway.command(threadId, commandId, "turn/start", {
                native,
                executionSource: opencraftExecutionAdmission,
                ...(opencraftSessionMcp !== undefined ? { sessionMcp: opencraftSessionMcp } : {}),
                ...(preparation ? { gitEnvironment: preparation.environment } : {}),
              }, () => {
                try {
                  context.resourceOwner?.assertCurrent();
                  if (context.commitExecution && !context.commitExecution()) throw Error("Host execution admission expired");
                } catch {
                  throw Object.assign(Error("Host execution admission expired"), { kind: "explicit-reject" });
                }
                dispatching = true;
              }, {
                ...(context.collaborationRequestId === undefined && !String(requestKey).startsWith("actor-input:")
                  ? { retryRejectedTurn: true }
                  : {}),
                onAcceptedReplay: () => { acceptedReplay = true; },
              });
            } catch (error) {
              const rejected = !dispatching || ["explicit-reject", "invalid", "stale-target", "unsupported", "frame-too-large"].includes(String(object(error).kind));
              preparation?.settle(rejected ? "rejected" : "unknown");
              throw error;
            }
            const nativeTurnId = this.nativeTurnOf(threadId, object(object(started).turn).id);
            if (acceptedReplay) preparation?.settle("rejected");
            else preparation?.settle(nativeTurnId ? "accepted" : "unknown", nativeTurnId);
            return started;
          },
          (value) => object(object(value).turn).id,
        );
        const nativeThread = this.gateway.nativeThread(threadId);
        if (nativeThread) this.policy.observeTitle?.("turn/start", { ...native, threadId: nativeThread }, result);
      } else if (method === "turn/steer") {
        if (!identity.evidence)
          throw Object.assign(
            Error("This client cannot represent native input admission; use a client with per-input evidence support"),
            { code: -32601 },
          );
        if (!requestKey) throw Error("Stable client input identity required");
        const steerInput = await prepare(p.input, String(requestKey)),
          expectedTurnId = this.gateway.nativeTurn(threadId, p.expectedTurnId);
        result = await this.withUsage(
          threadId,
          String(requestKey),
          "steer",
          context,
          () =>
            command("turn/steer", {
              inputId: requestKey,
              clientRequestId: requestKey,
              expectedTurnId,
              input: steerInput,
            }),
          () => p.expectedTurnId,
        );
        // Existing consumers cannot represent admission-only injection as success.
        result = { ...object(result), disposition: "steered" };
      } else if (method === "turn/interrupt")
        result = await command("turn/stop", { expectedTurnId: this.gateway.nativeTurn(threadId, p.turnId) });
      else if (method === "thread/resume")
        result = await command(
          "session/resume",
          { excludeTurns: p.excludeTurns, native: {
            model: p.model, modelProvider: p.modelProvider, serviceTier: p.serviceTier,
            approvalPolicy: p.approvalPolicy, approvalsReviewer: p.approvalsReviewer,
            permissions: p.permissions, sandbox: p.sandbox,
          } },
        );
      else if (method === "thread/read" || method === "thread/turns/list" || method === "thread/items/list")
        result = await observeCodexBridgeHistory(this.gateway, threadId, method, p, watchedRead ? archived => {
          if (!watching || subscribers.get(client) !== watching || this.clients.get(client) !== identity || this.closed) return;
          if (archived) this.archiveSubscriptions(threadId);
          else if (watching.mode === "observing") watching.mode = "live";
        } : undefined);
      else if (method === "thread/searchOccurrences") {
        result = await this.gateway.observe(threadId, { view: "occurrences",
          searchTerm: p.searchTerm, limit: p.limit, cursor: p.cursor });
      } else if (method === "thread/fork") {
        const { threadId: _, agentBridge: _agentBridge, workspaceFork: _workspaceFork, ...declared } = p;
        const owned = this.policy.creationTools?.() ?? [];
        const names = new Set(owned.map((tool) => String(tool.name)));
        const native = owned.length
          ? {
              ...declared,
              dynamicTools: [
                ...(Array.isArray(declared.dynamicTools)
                  ? declared.dynamicTools.filter((tool: unknown) => !names.has(String(object(tool).name)))
                  : []),
                ...owned,
              ],
            }
          : declared;
        if (this.policy.executionGit && native.historyMode == null && native.ephemeral !== true)
          Object.assign(native, { historyMode: "paginated" });
        result = await this.gateway.command(forkedId!, commandId, "session/fork", { sourceThreadId: threadId, native });
      } else if (method === "thread/name/set") {
        result = await command("session/rename", { name: p.name });
        this.notify(threadId, "thread/name/updated", { threadId, threadName: p.name });
      } else if (method === "thread/archive") {
        result = await command("session/archive", {});
        this.notify(threadId, "thread/archived", { threadId });
      } else if (method === "thread/unarchive") {
        result = await command("session/unarchive", {});
        this.notify(threadId, "thread/unarchived", { threadId });
      } else if (method === "thread/delete") {
        result = await command("session/delete", {});
        this.notify(threadId, "thread/deleted", { threadId });
      } else if (method === "thread/goal/get") result = await command("goal/get", { native: {} });
      else if (method === "thread/goal/set") {
        const { threadId: _, ...native } = p;
        result = await command("goal/set", { native });
        const goal = object(result).goal;
        if (goal !== undefined) this.notify(threadId, "thread/goal/updated", { threadId, goal });
      } else if (method === "thread/goal/clear") {
        result = await command("goal/clear", { native: {} });
        this.notify(threadId, "thread/goal/cleared", { threadId });
      } else if (method === "thread/settings/update") {
        const { threadId: _, ...native } = p;
        result = await command("session/settings", { native });
      }
      // Bridge history reads have no cancellable in-flight work in this Host.
      else if (method === "thread/history/cancel") result = { cancelled: false };
      else if (method.startsWith("thread/queue/")) {
        const { threadId: _, ...params } = p;
        const guarded = this.policy.queueGuard
          ? await this.policy
              .queueGuard(
                threadId, method, params, context,
                async (by) => {
                  const found = object(
                    this.publicTurns(threadId, await this.gateway.queue(threadId, "thread/queue/find", by)),
                  ).queuedSubmission;
                  return found ? (found as BridgeQueueRow) : null;
                },
                (row) => readQueuedInputCompletion(row, (turnId, cursor) =>
                  this.gateway.observe(threadId, { turnId, cursor, limit: 100 }),
                ),
              )
              .catch((error: Error & { code?: number }) => {
                throw Object.assign(error, { kind: "explicit-reject" });
              })
          : null;
        // Clients name public turns; the Host queue records native ones.
        if (typeof params.expectedTurnId === "string" && params.expectedTurnId !== "unknown")
          params.expectedTurnId = this.gateway.nativeTurn(threadId, params.expectedTurnId);
        // The Host sends queued input on its own later, so attachments are staged now.
        if (params.input !== undefined) {
          const editing = method === "thread/queue/update";
          // An edit changes the existing item. The queue owns its message ID and author.
          params.input = await prepare(
            params.input,
            !editing && typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : undefined,
            editing ? "queue-edit" : undefined,
          );
        }
        if (guarded) result = guarded.result;
        else {
          const queued = await this.gateway.queue(threadId, method, params);
          result = method === "thread/queue/list" ? queued : this.publicTurns(threadId, queued);
        }
      } else if (method === "thread/unsubscribe") {
        this.revokeClient(client, threadId);
        result = {};
      } else if (method === "opencraft/steer/status") {
        const { inputIds } = p;
        if (inputIds !== undefined && (!Array.isArray(inputIds) || !inputIds.every((id) => typeof id === "string")))
          throw Object.assign(Error("Invalid input IDs"), { code: -32602 });
        result = await this.gateway.status(threadId, inputIds);
      } else throw Object.assign(Error("Method unavailable for this bridge thread"), { code: -32601 });
      const rawVisible = historyRead ? result : this.gateway.history(forkedId ?? threadId, result);
      const visible = this.policy.topology
        ? projectThreadTopologyResult(method, rawVisible, this.policy.topology)
        : rawVisible;
      // An accepted operation still belongs to the Thread after its sending client disconnects.
      this.catalog.observeResult(method, { ...p, threadId }, visible);
      this.policy.observeIdentityResult?.(method, { ...p, threadId }, visible, context.sender);
      if (this.clients.get(client) === identity) {
        this.emit(
          {
            id: frame.id,
            ...(acceptedReplay && p.opencraftExecutionAdmission !== undefined ? { [BRIDGE_ACCEPTED_REPLAY]: true } : {}),
            result:
              this.policy.projectHistory && ["thread/read", "thread/resume", "thread/turns/list", "thread/items/list"].includes(method)
                ? this.policy.projectHistory(method, { ...p, threadId }, visible)
                : visible,
          },
          client,
        );
        // The history reply owns its own result. Approval recovery and
        // subscription retirement are independent of that read.
        const ownsWatch = watchedRead && subscribers.get(client) === watching;
        if (this.isLiveSubscriber(threadId, client) && (method === "thread/resume" || ownsWatch))
          void this.restorePendingInteractions(threadId, client, identity, context).catch(() => {});
      }
    };
    if (admission) this.admissionsInFlight++;
    const task = execute().finally(() => {
      if (admission) this.admissionsInFlight--;
    });
    if (optIn || forkedId) this.creations.add(task);
    try {
      await task;
    } catch (cause) {
      const error = cause as Error & { code?: number; kind?: string; commandId?: string; data?: unknown };
      const size = object(error.data);
      const oversizedHistory = error.kind === "frame-too-large" && historyRead;
      if (watchedRead && error.code === -32071 && subscribers.get(client) === watching) this.archiveSubscriptions(threadId);
      const rejected = cause instanceof InteractionResponseNotDispatched ||
        ["explicit-reject", "stale-target", "invalid", "unsupported"].includes(error.kind ?? "") ||
        [-32002, -32601, -32602].includes(error.code ?? 0);
      if (this.clients.get(client) === identity)
        this.emit(
          {
            id: frame.id,
            error: {
              code: cause instanceof InteractionFault ? cause.rpcCode : oversizedHistory ? -32072 : error.code ?? -32005,
              message: error.message,
              data: {
                ...(oversizedHistory ? { code: "HISTORY_RESPONSE_TOO_LARGE" } : {}),
                ...(historyRead && size.code === "THREAD_ARCHIVED" ? { code: size.code } : {}),
                ...(size.code === "BRIDGE_REQUEST_TOO_LARGE" && typeof size.maxBytes === "number"
                  ? { code: size.code, maxBytes: size.maxBytes } : {}),
                ...(error.message === "cliUnavailable" && typeof size.cliStage === "string"
                  && ["source", "previous-lease", "issue", "reservation", "cancelled", "provider", "native-configuration"].includes(size.cliStage)
                  ? { cliStage: size.cliStage } : {}),
                ...(cause instanceof InteractionFault ? cause.domainData : {}),
                submissionOutcome: oversizedHistory || rejected ? "rejected" : "unknown",
                retryable: false,
                bridgeErrorKind: error.kind ?? (rejected ? "explicit-reject" : "unknown-outcome"),
                bridgeCommandId: error.commandId,
              },
            },
          },
          client,
        );
    } finally {
      if (watching?.mode === "observing" && subscribers.get(client) === watching) this.revokeClient(client, threadId);
      this.creations.delete(task);
    }
  }
  async close() {
    for (const abort of this.hostTools.values()) abort.abort();
    this.hostTools.clear();
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    await this.legacy.close();
    await this.gateway.close();
  }
}
