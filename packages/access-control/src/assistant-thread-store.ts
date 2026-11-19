import { parseConversationRef } from "@opencraft/appserver-protocol/collaboration";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ActorContext } from "@opencraft/identity-core/actors";
import { PersonalAssistants } from "./personal-assistants.js";
import type { Collaboration } from "./collaboration.js";
import { canonical } from "./orchestration-ledger.js";

function fail(code = "assistant_thread_denied", status = 403): never {
  throw Object.assign(Error(code), { code, status });
}
export const threadText = (v: unknown, max = 256): string => {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(v)
  )
    fail("invalid_thread_argument", 400);
  return v;
};
export interface AssistantThreadAllocation {
  id: string;
  actor: ActorContext;
  owner: ActorContext;
  reference: string;
  relation: Parameters<Collaboration["orchestration"]["createThread"]>[0];
}
/** Storage facet under the existing communication transaction. No engine calls. */
export class AssistantThreadStore {
  constructor(
    private service: Collaboration,
    private db: DatabaseSync,
  ) {}
  private assistants() {
    return new PersonalAssistants(this.service, this.db);
  }
  authority(c: ActorContext) {
    return this.assistants().readAuthority(c);
  }
  human(c: ActorContext,botId?:unknown) {
    return this.assistants().modelAuthority(c,botId);
  }
  private profile(botId: string, id: string) {
    const r = this.db
      .prepare(
        "SELECT * FROM assistant_thread_profiles WHERE bot_id=? AND id=?",
      )
      .get(botId, id);
    if (!r) fail("assistant_thread_profile_required", 409);
    return r;
  }
  guard(c: ActorContext, id: string, revision?: number, epoch?: string) {
    const a = this.authority(c),
      p = this.profile(a.binding.botId, id);
    if (
      !p.enabled ||
      p.epoch !== a.epoch ||
      (epoch !== undefined && a.epoch !== epoch) ||
      (revision !== undefined && p.revision !== revision)
    )
      fail("assistant_thread_grant_revoked");
    const source = parseConversationRef(String(p.source))!;
    return {
      ...a,
      profile: p,
      sourceOwner:
        this.service.orchestration.relation(source.threadId)?.ownerActorId ??
        null,
    };
  }
  private own(c: ActorContext, id: string) {
    const a = this.authority(c),
      r = this.db
        .prepare(
          "SELECT * FROM assistant_thread_operations WHERE id=? AND bot_id=? AND epoch=?",
        )
        .get(id, a.binding.botId, a.epoch);
    if (!r) fail();
    return r;
  }
  private audit(c: ActorContext, action: string, id: string) {
    this.db
      .prepare("INSERT INTO actor_collaboration_audit VALUES(?,?,?,?,?,?)")
      .run(
        randomUUID(),
        "assistant-thread." + action,
        c.actorId,
        id,
        "{}",
        this.service.now(),
      );
  }
  /** Trusted Host completion only; never exposed as a Bot wire operation.
   * Revocation cancels execution authority, not custody of an already allocated
   * native identity. The durable operation and its original owner must match. */
  recordAllocation(p: AssistantThreadAllocation) {
    const r = this.db
      .prepare(
        "SELECT o.*,a.actor_id,a.owner_human_id FROM assistant_thread_operations o JOIN personal_assistants a ON a.bot_id=o.bot_id WHERE o.id=? AND o.command='start'",
      )
      .get(threadText(p.id));
    const target = parseConversationRef(p.reference);
    if (
      !r ||
      r.actor_id !== p.actor.actorId ||
      r.owner_human_id !== p.owner.actorId ||
      !target ||
      p.relation.threadId !== target.threadId ||
      p.relation.serverId !== target.serverId
    )
      fail();
    if (r.reference && r.reference !== p.reference)
      fail("assistant_thread_identity_changed", 409);
    const policy = this.db
      .prepare(
        "SELECT creator_actor_id,access_mode FROM thread_access WHERE server_id=? AND thread_id=?",
      )
      .get(target.serverId, target.threadId);
    const existing = this.service.orchestration.relation(target.threadId);
    if (
      (policy &&
        (policy.creator_actor_id !== p.owner.actorId ||
          policy.access_mode !== "private")) ||
      (existing &&
        (existing.ownerActorId !== p.owner.actorId ||
          existing.parentThreadId !== null))
    )
      fail("assistant_thread_identity_conflict", 409);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO thread_access VALUES(?,?,?,'private',1,?)",
      )
      .run(
        target.serverId,
        target.threadId,
        p.owner.actorId,
        this.service.now(),
      );
    if (!existing)
      this.service.orchestration.createThread({
        ...p.relation,
        ownerActorId: p.owner.actorId,
        parentThreadId: null,
        lifecycleOwnerThreadId: null,
        visibility: "visible",
      });
    this.db
      .prepare("UPDATE assistant_thread_operations SET reference=? WHERE id=?")
      .run(p.reference, r.id);
    return this.db
      .prepare("SELECT * FROM assistant_thread_operations WHERE id=?")
      .get(r.id)!;
  }
  command(c: ActorContext, op: string, p: Record<string, any>): any {
    if (op === "profile-save" || op === "profile-revoke") {
      const a = this.human(c,p.botId),
        id = threadText(p.id, 80);
      const old = this.db
        .prepare(
          "SELECT * FROM assistant_thread_profiles WHERE bot_id=? AND id=?",
        )
        .get(a.assistant.binding.botId, id);
      if (
        !Number.isSafeInteger(p.expectedRevision) ||
        (old?.revision ?? 0) !== p.expectedRevision
      )
        fail("assistant_thread_profile_conflict", 409);
      if (p.epoch !== a.epoch) fail();
      if (op === "profile-revoke") {
        if (!old) fail();
        this.db
          .prepare(
            "UPDATE assistant_thread_profiles SET enabled=0,revision=revision+1 WHERE bot_id=? AND id=?",
          )
          .run(a.assistant.binding.botId, id);
      } else {
        const source = parseConversationRef(String(p.reference));
        if (
          !source ||
          !this.service.conversationAllowed(c, source, "execution.delegate")
        )
          fail("assistant_thread_source_unavailable");
        this.db
          .prepare(
            "INSERT INTO assistant_thread_profiles VALUES(?,?,?,?,?,?,1) ON CONFLICT(bot_id,id) DO UPDATE SET epoch=excluded.epoch,revision=excluded.revision,source=excluded.source,settings=excluded.settings,enabled=1",
          )
          .run(
            a.assistant.binding.botId,
            id,
            a.epoch,
            p.expectedRevision + 1,
            p.reference,
            JSON.stringify(p.settings),
          );
      }
      this.audit(c, op, id);
      return {
        id,
        revision: p.expectedRevision + 1,
        enabled: op === "profile-save",
      };
    }
    if (op === "source-authority") {
      const source = parseConversationRef(threadText(p.reference, 2048));
      if (
        !source ||
        !this.service.conversationAllowed(c, source, "execution.delegate")
      )
        fail("assistant_thread_source_unavailable");
      return {
        context: c,
        profile: { source: p.reference },
        sourceOwner:
          this.service.orchestration.relation(source.threadId)?.ownerActorId ??
          null,
      };
    }
    if (op === "human-profiles") {
      const a = this.human(c,p.botId);
      return {
        profiles: this.db
          .prepare(
            "SELECT id,revision,source,enabled,epoch FROM assistant_thread_profiles WHERE bot_id=? ORDER BY id LIMIT 100",
          )
          .all(a.assistant.binding.botId)
          .map(({ epoch, ...r }) => ({
            ...r,
            enabled: !!r.enabled && epoch === a.epoch,
          })),
      };
    }
    if (op === "profiles") {
      const a = this.authority(c);
      return {
        profiles: this.db
          .prepare(
            "SELECT id,revision,source FROM assistant_thread_profiles WHERE bot_id=? AND epoch=? AND enabled=1 ORDER BY id LIMIT 100",
          )
          .all(a.binding.botId, a.epoch),
      };
    }
    if (op === "guard")
      return {
        ...this.guard(c, p.profile, p.revision, p.epoch),
        takenOver: p.threadId
          ? (this.service.orchestration.relation(p.threadId)
              ?.hasDirectUserInput ?? false)
          : false,
      };
    if (op === "send") {
      const r = this.own(c, threadText(p.id)),
        args = JSON.parse(String(r.args));
      const reference =
        typeof p.reference === "object" && p.reference ? p.reference : null;
      const frozen = parseConversationRef(
        String(r.reference ?? args.reference),
      );
      if (
        p.profile !== r.profile_id ||
        p.revision !== r.profile_revision ||
        p.epoch !== r.epoch ||
        !reference ||
        !frozen ||
        reference.serverId !== frozen.serverId ||
        reference.threadId !== frozen.threadId ||
        p.content !== (args.prompt ?? args.message)
      )
        fail("assistant_thread_operation_changed", 409);
      // Execution intent comes only from this admitted, fingerprinted operation,
      // never from a caller-supplied send-mode override.
      const execution =
        args.delivery === "steer"
          ? {
              mode: "steer" as const,
              expectedTurnId: threadText(args.expectedTurnId, 256),
            }
          : { mode: "queue" as const };
      return this.service.sendAssistantThread(c, { ...p, execution } as any);
    }
    if (op === "accept") {
      const a = this.authority(c),
        key = threadText(p.key, 128),
        fingerprint = createHash("sha256")
          .update(
            JSON.stringify(canonical([p.command, p.args, p.workId ?? null])),
          )
          .digest("hex");
      const prior = this.db
        .prepare(
          "SELECT * FROM assistant_thread_operations WHERE bot_id=? AND epoch=? AND request_key=?",
        )
        .get(a.binding.botId, a.epoch, key);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          fail("assistant_thread_key_reused", 409);
        return prior;
      }
      let profileId = p.args.profile;
      if (p.command === "tell") {
        const origin = this.db
          .prepare(
            "SELECT * FROM assistant_thread_operations WHERE bot_id=? AND epoch=? AND reference=? AND command='start' AND state='submitted'",
          )
          .get(a.binding.botId, a.epoch, p.args.reference);
        if (!origin) fail();
        profileId = origin.profile_id;
        this.guard(c, profileId, Number(origin.profile_revision));
      }
      const g = this.guard(c, threadText(profileId, 80));
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO assistant_thread_operations VALUES(?,?,?,?,?,?,?,?,?,?,'accepted',NULL,NULL,?)",
        )
        .run(
          id,
          a.binding.botId,
          a.epoch,
          key,
          fingerprint,
          p.command,
          JSON.stringify(p.args),
          p.workId ?? null,
          profileId,
          g.profile.revision,
          this.service.now(),
        );
      this.audit(c, p.command, id);
      return this.own(c, id);
    }
    if (op === "delivery") {
      const r = this.own(c, threadText(p.id)),
        a = this.authority(c),
        args = JSON.parse(String(r.args));
      const reference = r.reference ?? args.reference;
      const delivery = reference
        ? this.service.lookupConversation(a.context, reference, "assistant:" + r.id)
        : { found: false as const };
      return p.native === true && delivery.found
        ? { ...delivery, nativeBinding: this.service.conversationDeliveryBinding(a.context, delivery.receipt) }
        : delivery;
    }
    if (op === "operation") return this.own(c, threadText(p.id));
    if (op === "list") {
      const a = this.authority(c);
      const after = typeof p.after === "string" ? p.after : "";
      return this.db
        .prepare(
          "SELECT id,reference,work_id,state,result FROM assistant_thread_operations WHERE bot_id=? AND epoch=? AND command='start' AND id>? ORDER BY id LIMIT ?",
        )
        .all(a.binding.botId, a.epoch, after, p.limit + 1);
    }
    if (op === "target") {
      const a = this.authority(c),
        r = this.db
          .prepare(
            "SELECT * FROM assistant_thread_operations WHERE bot_id=? AND epoch=? AND reference=? AND command='start'",
          )
          .get(a.binding.botId, a.epoch, p.reference);
      if (!r) fail();
      return r;
    }
    if (op === "finish") {
      const r = this.own(c, threadText(p.id));
      if (r.state === "submitted" || r.state === "rejected") return r;
      this.db
        .prepare(
          "UPDATE assistant_thread_operations SET state=?,reference=COALESCE(?,reference),result=? WHERE id=?",
        )
        .run(p.state, p.reference ?? null, JSON.stringify(p.result), r.id);
      return this.own(c, String(r.id));
    }
    fail("unknown_assistant_thread_storage_operation", 400);
  }
}
