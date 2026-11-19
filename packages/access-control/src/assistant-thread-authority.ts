import type { ActorContext } from "@opencraft/identity-core/actors";
import { encodeConversationRef, parseConversationRef } from "@opencraft/appserver-protocol/collaboration";
import { Collaboration, CollaborationError } from "./collaboration.js";
import { threadText as text, type AssistantThreadStore } from "./assistant-thread-store.js";
import type { OrchestrationMessageOrigin } from "./orchestration-authority.js";
import type { ThreadAccessStore } from "./thread-access.js";
const ref = (v: unknown) => {
  const r = parseConversationRef(text(v, 2048));
  if (!r) throw new CollaborationError(400, "invalid_reference");
  return r;
};
type AssistantGrant = NonNullable<OrchestrationMessageOrigin["assistantGrant"]>;
/** Profile guard as returned by the `assistant-thread/guard` storage command. */
type AssistantThreadGuard = ReturnType<AssistantThreadStore["guard"]> & { takenOver: boolean };
/** Minimal source projection shared by profile guards and `source-authority`. */
interface AssistantSourceAuthority {
  context: ActorContext;
  profile: { source?: unknown };
  sourceOwner?: string | null;
}
/** Durable `assistant_thread_operations` row as returned by the storage commands. */
type AssistantThreadOperationRow = Record<string, unknown>;
/** Bot claim/profile admission adapter for the shared Thread command owner.
 * No native execution port, command lifecycle, allocation or queue is owned here. */
export class AssistantThreadAuthority {
  private closed = false;
  private admissions = new Map<string, { grant: AssistantGrant; authority: AssistantThreadGuard; threadId: string }>();
  private refreshes = new Set<{
    threadId: string;
    invalidated: boolean;
    owners: Set<string>;
    bots: Set<string>;
  }>();
  sourceAllowed(g: AssistantSourceAuthority) {
    const source = ref(g.profile.source);
    return (
      this.service.actors.isCurrent(g.context) &&
      this.service.admittedActor(g.context.actorId) &&
      this.access.allows(source.serverId, source.threadId, g.context) &&
      (!g.sourceOwner ||
        g.sourceOwner === g.context.actorId ||
        this.service.actors.can(g.context, encodeConversationRef(source), "execution.delegate"))
    );
  }
  private prune() {
    for (const [key, row] of this.admissions)
      if (row.authority.expiresAt <= this.service.now()) this.admissions.delete(key);
  }
  private inputKey(grant: AssistantGrant, threadId: string) {
    return JSON.stringify([grant.actor, grant.profile, grant.revision, grant.epoch, threadId]);
  }
  invalidate(threadId?: string, ownerActorId?: string, botId?: string) {
    for (const pending of this.refreshes) {
      if (botId) pending.bots.add(botId);
      else if (ownerActorId) pending.owners.add(ownerActorId);
      else if (!threadId || pending.threadId === threadId) pending.invalidated = true;
    }
    for (const [key, row] of this.admissions) {
      if (
        botId
          ? row.authority.binding.botId === botId
          : ownerActorId
            ? row.authority.context.actorId === ownerActorId
            : !threadId || row.threadId === threadId
      )
        this.admissions.delete(key);
    }
  }
  async initialize() {
    for (const row of await this.service.assistantAdmissions())
      if (!row.takenOver) this.admissions.set(this.inputKey(row.grant, row.threadId), row);
  }
  async refreshInput(grant: AssistantGrant, threadId: string) {
    this.prune();
    const pending = { threadId, invalidated: false, owners: new Set<string>(), bots: new Set<string>() };
    this.refreshes.add(pending);
    const key = this.inputKey(grant, threadId);
    try {
      const authority = await this.store(grant.actor, "guard", {
        ...grant,
        threadId,
      });
      if (
        !this.closed &&
        !pending.invalidated &&
        !pending.owners.has(authority.context.actorId) &&
        !pending.bots.has(authority.binding.botId)
      ) {
        if (!authority.takenOver && (this.admissions.has(key) || this.admissions.size < 10000))
          this.admissions.set(key, { grant, authority, threadId });
        else this.admissions.delete(key);
      }
    } catch (error) {
      if ([401, 403, 409].includes(Number((error as { status?: unknown }).status))) this.admissions.delete(key);
      else
        throw Object.assign(Error("assistant_authority_unavailable"), {
          cause: error,
          code: "assistant_authority_unavailable",
        });
    } finally {
      this.refreshes.delete(pending);
    }
  }
  allowsInput(grant: AssistantGrant, threadId: string) {
    const row = this.admissions.get(this.inputKey(grant, threadId));
    return (
      !!row &&
      !this.closed &&
      row.authority.expiresAt > this.service.now() &&
      this.service.actors.isCurrent(grant.actor) &&
      this.service.admittedActor(grant.actor.actorId) &&
      this.sourceAllowed(row.authority)
    );
  }
  constructor(
    private service: Collaboration,
    private access: ThreadAccessStore,
  ) {}
  async close() {
    this.closed = true;
    this.admissions.clear();
  }
  acceptCreated(value: Parameters<ThreadAccessStore["acceptCreated"]>[0]) {
    return this.access.acceptCreated(value);
  }
  store(c: ActorContext, op: string, p: Record<string, unknown> = {}) {
    return this.service.communicate(c, "assistant-thread/" + op, p);
  }
  async check(c: ActorContext, id: string, revision?: number, epoch?: string) {
    if (this.closed) throw new CollaborationError(503, "assistant_threads_unavailable");
    const g = await this.store(c, "guard", { profile: id, revision, epoch });
    if (!this.sourceAllowed(g)) throw new CollaborationError(403, "assistant_thread_source_unavailable");
    return g;
  }
  current(c: ActorContext, r: AssistantThreadOperationRow, threadId?: string) {
    if (!threadId) return this.check(c, String(r.profile_id), Number(r.profile_revision), String(r.epoch));
    return this.store(c, "guard", {
      profile: r.profile_id,
      revision: r.profile_revision,
      epoch: r.epoch,
      threadId,
    }).then((g) => {
      if (this.closed || !this.sourceAllowed(g))
        throw new CollaborationError(403, "assistant_thread_source_unavailable");
      if (g.takenOver) throw new CollaborationError(403, "assistant_thread_user_control");
      const target = parseConversationRef(String(r.reference ?? JSON.parse(String(r.args)).reference));
      if (!target || !this.service.conversationAllowed(g.context, target, "conversation.read"))
        throw new CollaborationError(403, "conversation_action_denied");
      return g;
    });
  }
  receipt(r: AssistantThreadOperationRow) {
    return {
      operationId: r.id,
      state: r.state,
      reference: r.reference,
      workId: r.work_id,
      ...(r.result ? JSON.parse(String(r.result)) : {}),
    };
  }
}
