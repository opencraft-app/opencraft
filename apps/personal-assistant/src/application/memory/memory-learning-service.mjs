import { memoryKey, memoryKind } from "../../domain/memory-recall.mjs";
import { MemorySynthesisPolicy, boundMemoryEvidence, normalizeMemory } from "../../domain/memory-synthesis.mjs";
import { Conversation } from "../../domain/conversation.mjs";
import { requireText, stable, digest } from "../../domain/values.mjs";

const captureContext = (snapshot) => digest([snapshot.projectId ?? null, snapshot.memoryResources ?? []]);

/** Owns durable synthesis jobs; memory values remain owned by MemoryService. */
export class MemoryLearningService {
  constructor({ repository, memory, uow, policy, now = Date.now }) {
    Object.assign(this, { repository, memory, uow, now });
    this.policy = MemorySynthesisPolicy.resolve(policy);
  }
  capture(turn, reply) {
    if (!this.policy.enabled) return;
    const id = `learning:${turn.id}`;
    if (this.repository.get(id)) return;
    const evidence = [
      {
        id: Conversation.messageId(turn.conversation_id, turn.id, "user"),
        role: "user",
        occurredAt: turn.created_at,
        text: boundMemoryEvidence(turn.text),
      },
      {
        id: Conversation.messageId(turn.conversation_id, `${turn.id}:reply`, "assistant"),
        role: "assistant",
        text: boundMemoryEvidence(reply),
      },
    ];
    const snapshot = this.memory.captureSnapshot ? this.memory.captureSnapshot(turn) : this.memory.learningSnapshot();
    const oversized = new TextEncoder().encode(stable({ evidence, snapshot })).length > 4000000;
    this.repository.add({
      id,
      evidence: oversized ? [] : evidence,
      snapshot: oversized ? { epoch: snapshot.epoch, memories: [] } : snapshot,
      state: oversized ? "skipped" : "queued",
      at: this.now(),
    });
    // Debounce only unfrozen evidence. A persisted proposal is immutable across restart.
    for (const job of this.repository.unbatched().slice(0, -64)) this.repository.finished(job.id, "dropped");
    const pending = this.repository.unbatched().filter((j) => captureContext(j.snapshot) === captureContext(snapshot));
    for (const job of pending) this.repository.defer(job.id, this.now() + this.policy.debounceMs);
    for (const job of pending.slice(0, -MemorySynthesisPolicy.limits.evidence))
      this.repository.finished(job.id, "dropped");
  }
  pending() {
    if (!this.policy.enabled) return [];
    // Observation only; batching below re-reads inside its unit of work.
    if (!this.repository.pending(this.now()).length) return [];
    return this.uow.transaction(() => {
      const jobs = this.repository.pending(this.now());
      const job = jobs[0];
      if (!job || job.state !== "queued" || job.batchIds) return jobs;
      const batch = this.repository
        .unbatched()
        .filter((j) => captureContext(j.snapshot) === captureContext(job.snapshot))
        .slice(-12);
      const evidence = batch.flatMap((j) => j.evidence);
      let snapshot;
      try {
        snapshot = this.memory.rebaseSnapshot(job.snapshot);
      } catch (error) {
        this.failed(job.id, error);
        return [];
      }
      this.repository.freeze(
        job.id,
        evidence,
        snapshot,
        batch.map((j) => j.id),
        new Date(this.now()).toISOString().slice(0, 10),
      );
      for (const other of batch) if (other.id !== job.id) this.repository.finished(other.id, "merged");
      return [this.get(job.id)];
    });
  }
  queueTemporal() {
    if (!this.policy.enabled || this.repository.control("next-poll") > this.now()) return;
    this.uow.transaction(() => {
      this.repository.setControl("next-poll", this.now() + this.policy.pollMs);
      const snapshot = this.memory.learningSnapshot();
      if (
        this.repository.activeTemporal(snapshot.projectId ?? null) ||
        !this.memory.reviewDue(snapshot.projectId ?? null, this.policy.refreshMs)
      )
        return;
      if (!snapshot.facts?.length) {
        this.memory.reviewed(snapshot.projectId ?? null, this.policy.refreshMs);
        return;
      }
      const id = `learning:clock:${this.now()}`;
      this.repository.add({
        id,
        evidence: [],
        snapshot,
        state: "queued",
        at: this.now(),
      });
      this.repository.freeze(id, [], snapshot, [], new Date(this.now()).toISOString().slice(0, 10), 1);
    });
  }
  settleReview(job) {
    if (job.temporal && !["queued", "proposed"].includes(job.state))
      this.memory.reviewed(job.snapshot.projectId ?? null, this.policy.refreshMs);
  }
  get(id) {
    return this.repository.get(id);
  }
  validate(job, raw) {
    if (!Array.isArray(raw?.changes) || raw.changes.length > 64)
      throw new Error("Memory proposal requires at most 64 changes");
    const seen = new Set();
    return {
      changes: raw.changes.map((change) => {
        if (change.action) return this.validateSynthesis(job, change, seen);
        const key = memoryKey(
          change.key,
          change.scope ?? job.snapshot.defaultScope ?? "user",
          change.project ?? job.snapshot.projectId ?? null,
        );
        const value = requireText(change.value, "memory value", 2000);
        if (seen.has(key)) throw new Error("Duplicate memory key");
        seen.add(key);
        if (
          !Array.isArray(change.evidenceIds) ||
          !change.evidenceIds.length ||
          change.evidenceIds.length > 4 ||
          change.evidenceIds.some((id) => !job.evidence.some((e) => e.id === id && e.role === "user"))
        )
          throw new Error("Memory changes must cite original user evidence");
        const previous = job.snapshot.memories.find((m) => m.key === key);
        if (previous && (previous.deleted || previous.origin !== "automatic"))
          throw new Error("Explicit or forgotten memory is protected");
        return {
          key,
          value,
          evidenceIds: [...new Set(change.evidenceIds)],
          expectedRevision: previous?.revision ?? 0,
          scope: change.scope ?? previous?.scope ?? job.snapshot.defaultScope ?? "user",
          projectId: change.scope === "project" ? (change.project ?? job.snapshot.projectId) : null,
          kind: memoryKind(change.kind ?? previous?.kind),
        };
      }),
    };
  }
  validateSynthesis(job, c, seen) {
    if (!["create", "update", "remove"].includes(c.action)) throw new Error("Invalid memory action");
    const ids = c.sourceEvidenceIds;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 32 ||
      ids.some((id) => !(id === "clock" && job.temporal) && !job.evidence.some((e) => e.id === id && e.role === "user"))
    )
      throw new Error("Memory changes must cite original user evidence or an authorized clock review");
    if (c.action === "create" && !ids.some((id) => id !== "clock"))
      throw new Error("Clock evidence cannot create facts");
    const previous = c.action === "create" ? null : job.snapshot.facts?.find((f) => f.id === c.id);
    if (c.action !== "create" && !previous) throw new Error("Unknown memory fact");
    if (previous?.origin === "explicit") throw new Error("Explicit memory is protected");
    const identity = c.action === "create" ? `${c.scope ?? "user"}:${normalizeMemory(c.content).toLowerCase()}` : c.id;
    if (seen.has(identity)) throw new Error("Duplicate memory change");
    seen.add(identity);
    const scope = previous?.scope ?? c.scope ?? job.snapshot.defaultScope ?? "user";
    const projectId = scope === "project" ? (previous?.projectId ?? c.project ?? job.snapshot.projectId) : null;
    if (
      !["agent", "user", "project"].includes(scope) ||
      (scope === "project" && !(job.snapshot.projectIds ?? [job.snapshot.projectId]).includes(projectId))
    )
      throw new Error("Memory project scope is unavailable");
    return {
      action: c.action,
      ...(previous ? { id: previous.id } : {}),
      scope,
      projectId,
      ...(c.action === "remove" ? {} : { content: normalizeMemory(c.content), kind: memoryKind(c.kind) }),
      sourceEvidenceIds: [...new Set(ids)],
    };
  }
  proposed(id, raw) {
    return this.uow.transaction(() => {
      const job = this.get(id);
      if (job.state !== "queued") return job;
      const proposal = this.validate(job, raw);
      if (proposal.changes.some((c) => c.action) && proposal.changes.some((c) => !c.action))
        throw new Error("Cannot mix memory proposal protocols");
      this.repository.proposed(id, proposal);
      return this.get(id);
    });
  }
  finish(id, verification) {
    return this.uow.transaction(() => {
      const job = this.get(id);
      if (job.state !== "proposed") return job;
      // Exact boolean required: truthy strings are never verification.
      if (verification?.approved !== true) {
        if (job.proposal.changes.some((c) => c.action) && job.attempts < 2) {
          this.repository.rebase(id, this.memory.rebaseSnapshot(job.snapshot));
          this.repository.defer(id, this.now() + Math.min(30000, 2000 * 2 ** job.attempts));
        } else this.repository.finished(id, "rejected");
      } else if (!job.proposal.changes.length) this.repository.finished(id, "no-change");
      else if (
        !(this.memory.snapshotCurrent
          ? this.memory.snapshotCurrent(job.snapshot)
          : job.snapshot.epoch === this.memory.epoch())
      ) {
        const snapshot = this.memory.rebaseSnapshot(job.snapshot);
        if (job.attempts >= 2) this.repository.finished(id, "stale");
        else if (new TextEncoder().encode(stable({ evidence: job.evidence, snapshot })).length > 4000000)
          this.repository.finished(id, "skipped");
        else this.repository.rebase(id, snapshot);
      } else {
        if (job.proposal.changes[0]?.action) this.memory.applySynthesis(job.id, job.snapshot, job.proposal.changes);
        else this.memory.applyLearned(job.id, job.snapshot, job.proposal.changes);
        this.repository.finished(id, "committed");
        this.memory.reviewed(job.snapshot.projectId ?? null, this.policy.refreshMs);
      }
      const settled = this.get(id);
      this.settleReview(settled);
      return settled;
    });
  }
  failed(id, error) {
    this.uow.transaction(() => {
      const job = this.get(id);
      if (!["queued", "proposed"].includes(job.state)) return;
      if (error?.modelFailure?.kind === "rate_limit" && Number.isSafeInteger(error.modelFailure.retryAt)) {
        this.repository.deferForCapacity(id, Math.max(this.now() + 1000, error.modelFailure.retryAt));
        return;
      }
      this.repository.failed(id, String(error).slice(0, 2000), this.now() + Math.min(30000, 2000 * 2 ** job.attempts));
      this.settleReview(this.get(id));
    });
  }
}
