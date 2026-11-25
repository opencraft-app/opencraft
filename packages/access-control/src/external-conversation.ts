import {
  encodeConversationRef,
  type ConversationRef,
  type ConversationReceipt,
} from "@opencraft/appserver-protocol/collaboration";
import type { ServerDatabaseSource } from "@opencraft/storage-node/server-repository";
import { ActorStore } from "./actors.js";
import { Collaboration, CollaborationError } from "./collaboration.js";
import { ThreadAccessStore } from "./thread-access.js";

/** Trusted channel configuration selects the Actor, resource and idempotency namespace. */
export interface ExternalConversationRequest {
  actorId: string;
  bearer: string;
  ref: ConversationRef;
  hostId: string;
  namespace: string;
  operation: { kind: "send"; key: string; content: string } | { kind: "status"; id: string };
}
export type ExternalConversationResult =
  | { kind: "authentication" | "denied" | "missing" | "conflict" }
  | { kind: "task"; receipt: ConversationReceipt; binding: ReturnType<Collaboration["conversationDeliveryBinding"]> };

/** Runs only on the storage owner. No native execution or network I/O occurs here. */
export async function externalConversation(
  source: Exclude<ServerDatabaseSource, string>,
  input: ExternalConversationRequest,
): Promise<ExternalConversationResult> {
  if (!/^[a-z][a-z0-9.-]{0,47}$/u.test(input.namespace)) throw new Error("Invalid external channel namespace");
  const db = source.database;
  const actors = new ActorStore(source, Date.now, { permissionProjection: false });
  const spaceMember = db.prepare(`SELECT 1 FROM collaboration_space_threads t
    JOIN collaboration_space_members m ON m.space_id=t.space_id
    WHERE t.engine_server_id=? AND t.thread_id=? AND m.actor_id=?`);
  const access = new ThreadAccessStore(source, actors, {
    projection: false,
    spaces: {
      allows: (actorId, serverId, threadId) => !!actorId && !!spaceMember.get(serverId, threadId, actorId),
    },
  });
  const unsupported = async () => {
    throw new Error("Storage cannot call an engine");
  };
  const service = new Collaboration(
    source,
    actors,
    {
      serverId: input.ref.serverId,
      hostId: input.hostId,
      serverForThread: () => input.ref.serverId,
      hostForServer: () => input.hostId,
      validate: unsupported,
      receipt: unsupported,
      add: unsupported,
      steer: unsupported,
      cancel: unsupported,
    },
    Date.now,
    (actorId) => db.prepare("SELECT enabled FROM actor_members WHERE actor_id=?").get(actorId)?.enabled !== 0,
    undefined,
    (context, ref) => access.allows(ref.serverId, ref.threadId, context),
  );
  try {
    return db.transaction((): ExternalConversationResult => {
      const context = actors.authenticateSession(input.bearer);
      if (!context || context.actorId !== input.actorId) return { kind: "authentication" };
      const reference = encodeConversationRef(input.ref);
      if (
        !["conversation.read", "message.send", "execution.queue"].every(
          (action) => actors.can(context, reference, action) && service.conversationAllowed(context, input.ref, action),
        )
      )
        return { kind: "denied" };
      try {
        const prefix = input.namespace + ":";
        const id =
          input.operation.kind === "send"
            ? service.sendConversation(context, {
                reference,
                content: input.operation.content,
                idempotencyKey: prefix + input.operation.key,
              }).requestId!
            : input.operation.id;
        const receipt = service.conversationDelivery(context, input.ref, id);
        if (!receipt.operationKey.startsWith(prefix)) return { kind: "missing" };
        return { kind: "task", receipt, binding: service.conversationDeliveryBinding(context, receipt) };
      } catch (error) {
        if (error instanceof CollaborationError) {
          if (error.status === 404) return { kind: "missing" };
          if (error.status === 409) return { kind: "conflict" };
        }
        throw error;
      }
    });
  } finally {
    try {
      await service.close();
    } finally {
      access.close();
      actors.close();
    }
  }
}
