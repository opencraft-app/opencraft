import type { TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import type { CodexProviderBridge } from "./codex-provider-bridge.js";

type BridgePolicy = NonNullable<ConstructorParameters<typeof CodexProviderBridge>[2]>;
type Value = Record<string, unknown>;

/**
 * The OpenCraft duties a provider bridge Thread needs from whoever owns the
 * Host's durable records: attachments and senders on its input and history,
 * titles, token usage, collaboration checks on its queue, and adoption of a
 * Thread the owner still holds. While the local Codex Host runs beside the
 * bridge it is that owner, because it holds these stores; a deployment that
 * runs no local Host provides them from standalone services instead.
 */
export interface CodexBridgeOwners {
  readonly prepareInput: NonNullable<BridgePolicy["prepareInput"]>;
  readonly projectHistory: NonNullable<BridgePolicy["projectHistory"]>;
  readonly projectNotification: NonNullable<BridgePolicy["projectNotification"]>;
  readonly observeTitle: NonNullable<BridgePolicy["observeTitle"]>;
  readonly observeIdentityResult: NonNullable<BridgePolicy["observeIdentityResult"]>;
  /** Whether prepareInput records verified senders now (the owner opens its sender store on connect). */
  readonly senderAttribution: () => boolean;
  readonly usage: NonNullable<BridgePolicy["usage"]>;
  readonly queueGuard: NonNullable<BridgePolicy["queueGuard"]>;
  readonly releaseForAdoption: NonNullable<BridgePolicy["releaseForAdoption"]>;
  /** The bridge's public↔native Thread identities, for duties the owner performs by native session. */
  bindThreadIdentities(identities: ReturnType<CodexProviderBridge["threadIdentities"]>): void;
}

/** Something that provides bridge owners (the local Codex Host does). */
export interface CodexBridgeOwnerProvider {
  bridgeOwners(): CodexBridgeOwners;
}

export function bridgeOwnersOf(value: unknown): CodexBridgeOwners | undefined {
  return value && typeof (value as Partial<CodexBridgeOwnerProvider>).bridgeOwners === "function"
    ? (value as CodexBridgeOwnerProvider).bridgeOwners()
    : undefined;
}

/** The bridge policy fields bridge owners supply. */
export function bridgeOwnerPolicy(owners: CodexBridgeOwners): Partial<BridgePolicy> {
  const { bindThreadIdentities: _, ...policy } = owners;
  return policy;
}

/** A refused queue request; `code` is its JSON-RPC error code. */
export class CollaborationQueueRefusal extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type ActorContext = NonNullable<TransportSubmissionContext["actorContext"]>;
export interface CollaborationQueueOwners {
  readonly collaboration?: {
    command(context: ActorContext, body: Value): Promise<unknown>;
    authorize(context: ActorContext, threadId: string, inputId: string, input?: readonly unknown[]): void;
  };
  readonly collaborationInput?: {
    mode(clientUserMessageId: string): "queue" | "steer" | null;
    authorize(threadId: string, clientUserMessageId: string, mode: "queue" | "steer", expectedTurnId?: string): boolean;
  };
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const ACTOR_INPUT = "actor-input:";

/**
 * Collaboration checks of a bridge Thread's queue request, the same the local
 * Host applies to its own queue: Actor input only through its trusted admission
 * and immutable, a person's delete of Actor input becomes a collaboration
 * cancel, ordinary input is authorized for its sender before it is queued, and
 * collaboration receipts are answered from the queue's rows. Returns a reply to
 * answer here, or null to forward the request. The Engine Host dispatches
 * queued input on its own, so authorization is checked when input is queued or
 * steered rather than again at dispatch.
 */
export function collaborationQueueGuard(owners: CollaborationQueueOwners): CodexBridgeOwners["queueGuard"] {
  return async (threadId, method, params, context, find, readCompletion) => {
    const actorRequest = context.collaborationRequestId;
    const selected = text(params.queuedSubmissionId)
      ? await find({ queuedSubmissionId: text(params.queuedSubmissionId) })
      : null;
    const clientId = selected?.clientUserMessageId ?? text(params.clientUserMessageId);
    const actorInput = clientId.startsWith(ACTOR_INPUT);
    if (
      selected &&
      actorInput &&
      method === "thread/queue/delete" &&
      !actorRequest &&
      context.actorContext &&
      owners.collaboration
    ) {
      await owners.collaboration.command(context.actorContext, {
        action: "cancel",
        requestId: clientId.slice(ACTOR_INPUT.length),
      });
      return { result: { deleted: true } };
    }
    if (actorInput && clientId !== `${ACTOR_INPUT}${actorRequest}`)
      throw new CollaborationQueueRefusal(-32600, "Actor input requires its trusted admission");
    if (actorInput && method === "thread/queue/update")
      throw new CollaborationQueueRefusal(-32600, "Actor messages are immutable");
    if (method === "thread/queue/collaborationReceipt") {
      if (!actorRequest) throw new CollaborationQueueRefusal(-32600, "Trusted Actor admission required");
      const row = await find({ clientUserMessageId: `${ACTOR_INPUT}${actorRequest}` });
      const completion = row && params.includeCompletion === true && readCompletion ? await readCompletion(row) : undefined;
      return { result: { receipt: row ? { id: row.id, state: row.state, targetTurnId: row.targetTurnId,
        ...(completion ? { completion } : {}) } : null } };
    }
    if (method === "thread/queue/add") {
      if (actorInput) {
        const mode = owners.collaborationInput?.mode(clientId);
        if (!mode) throw new CollaborationQueueRefusal(-32600, "Actor request unavailable");
        if (mode === "queue" && !owners.collaborationInput?.authorize(threadId, clientId, mode))
          throw new CollaborationQueueRefusal(-32600, "Actor execution authorization changed");
      } else if (context.actorContext && owners.collaboration) {
        context.resourceOwner?.assertCurrent();
        owners.collaboration.authorize(
          context.actorContext,
          threadId,
          clientId,
          Array.isArray(params.input) ? params.input : [],
        );
      }
    }
    if (
      method === "thread/queue/steer" &&
      actorInput &&
      !owners.collaborationInput?.authorize(threadId, clientId, "steer", text(params.expectedTurnId) || undefined)
    )
      throw new CollaborationQueueRefusal(-32600, "Actor execution authorization changed");
    return null;
  };
}
