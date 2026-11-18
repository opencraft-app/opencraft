import { Conversation } from "../../domain/conversation.mjs";
import {
  CONTEXT_POLICY,
  contextHash,
  parseContext,
} from "../../domain/conversation-context.mjs";

/** Owns derived main-chat checkpoints and their cursor. Never owns Work, Memory or native Pi state. */
export class ConversationContextService {
  constructor({
    repository,
    uow,
    conversationId,
    requireConversation = (id) => {
      if (id !== conversationId)
        throw new Error("Context is outside this conversation");
      return id;
    },
    now = Date.now,
    policy = CONTEXT_POLICY,
  }) {
    Object.assign(this, {
      repository,
      uow,
      conversationId,
      requireConversation,
      now,
      policy,
    });
  }
  forConversation(id = this.conversationId) {
    this.requireConversation(id);
    return id === this.conversationId
      ? this
      : new ConversationContextService({ ...this, conversationId: id });
  }
  boundary(turn) {
    if (turn.conversation_id !== this.conversationId)
      throw new Error("Context is outside this conversation");
    const source = turn.source_json ? JSON.parse(turn.source_json) : null;
    const id = source
      ? source.historyAnchor
      : Conversation.messageId(this.conversationId, turn.id, "user");
    if (!id) return null;
    const anchor = this.repository.anchor(this.conversationId, id);
    if (!anchor || (!source && anchor.role !== "user"))
      throw new Error("Context history anchor is unavailable");
    const tail = this.repository.tail(
      this.conversationId,
      anchor.seq,
      this.policy.keepRecent,
    );
    return { anchor, tail, beforeSeq: tail[0].seq };
  }
  capture(turn) {
    if (turn.conversation_id !== this.conversationId)
      return this.forConversation(turn.conversation_id).capture(turn);
    const boundary = this.boundary(turn);
    if (!boundary) return null;
    return this.uow.transaction(() => {
      const parent = this.repository.latest(
        this.conversationId,
        boundary.beforeSeq,
      );
      // An old queued input must never pull in a checkpoint from its future or create a competing branch.
      if (this.repository.latest(this.conversationId)?.id !== parent?.id)
        return null;
      const start = {
        seq: parent?.end_seq ?? 0,
        offset: parent?.end_offset ?? 0,
      };
      const count = this.repository.count(
        this.conversationId,
        start,
        boundary.beforeSeq,
      );
      if (!count) return null;
      const messages = [];
      let cursor = { ...start },
        remaining = this.policy.batchCharacters;
      while (messages.length < this.policy.batchMessages && remaining > 0) {
        const row = this.repository.next(
          this.conversationId,
          cursor,
          boundary.beforeSeq,
          Math.min(remaining, this.policy.segmentCharacters),
        );
        if (!row) break;
        const offset = row.seq === cursor.seq ? cursor.offset : 0;
        // The adapter's substring offset only applies when resuming the same partially read message.
        if (row.seq !== cursor.seq && cursor.offset)
          throw new Error("Context cursor lost its source message");
        messages.push({ ...row, offset });
        remaining -= row.text.length;
        cursor =
          offset + row.text.length < row.length
            ? { seq: row.seq, offset: offset + row.text.length }
            : { seq: row.seq + 1, offset: 0 };
      }
      if (count < this.policy.minMessages && remaining > 0 && !start.offset)
        return null;
      const input = {
        previous: parent ? JSON.parse(parent.summary_json) : null,
        messages,
      };
      const id = `context:${contextHash([this.conversationId, parent?.id ?? null, start, cursor, input])}`;
      if (!this.repository.get(id))
        this.repository.add({
          id,
          conversationId: this.conversationId,
          parentId: parent?.id ?? null,
          start,
          end: cursor,
          input,
          at: this.now(),
        });
      const job = this.repository.get(id);
      if (job.state === "pending" && job.attempts >= this.policy.maxAttempts) {
        this.repository.failed(
          job.id,
          "Context attempts exhausted (possibly interrupted); use context-retry",
          0,
          true,
        );
        return null;
      }
      return job.state === "pending" && job.next_at <= this.now() ? job : null;
    });
  }
  begin(job) {
    if (job.conversation_id !== this.conversationId)
      return this.forConversation(job.conversation_id).begin(job);
    return this.uow.transaction(() => {
      const current = this.repository.get(job.id);
      if (current && current.conversation_id !== this.conversationId)
        throw new Error("Context job is outside this conversation");
      if (
        current?.state !== "pending" ||
        current.attempts >= this.policy.maxAttempts
      ) {
        if (current?.state === "pending")
          this.repository.failed(
            job.id,
            "Context attempts exhausted (possibly interrupted); use context-retry",
            0,
            true,
          );
        return false;
      }
      this.repository.attempted(job.id);
      return true;
    });
  }
  commit(job, raw) {
    if (job.conversation_id !== this.conversationId)
      return this.forConversation(job.conversation_id).commit(job, raw);
    return this.uow.transaction(() => {
      const current = this.repository.get(job.id);
      if (current && current.conversation_id !== this.conversationId)
        throw new Error("Context job is outside this conversation");
      if (current?.state === "ready") return { duplicate: true };
      if (current?.state !== "pending") return { accepted: false };
      if (
        (this.repository.latest(this.conversationId)?.id ?? null) !==
        current.parent_id
      ) {
        this.repository.superseded(job.id);
        return { accepted: false };
      }
      const input = JSON.parse(current.source_json);
      for (const m of input.messages) {
        const actual = this.repository.source(this.conversationId, m);
        if (
          !actual ||
          actual.text !== m.text ||
          actual.role !== m.role ||
          actual.length !== m.length
        )
          throw new Error("Context source changed before commit");
      }
      const summary = parseContext(raw, input);
      this.repository.ready(job.id, summary, this.now());
      return { accepted: true };
    });
  }
  failed(job, error) {
    if (job.conversation_id !== this.conversationId)
      return this.forConversation(job.conversation_id).failed(job, error);
    this.uow.transaction(() => {
      const current = this.repository.get(job.id);
      if (current && current.conversation_id !== this.conversationId)
        throw new Error("Context job is outside this conversation");
      if (current?.state !== "pending") return;
      this.repository.failed(
        job.id,
        error,
        this.now() + 1000 * 2 ** current.attempts,
        current.attempts >= this.policy.maxAttempts,
      );
    });
  }
  view(turn) {
    if (turn.conversation_id !== this.conversationId)
      return this.forConversation(turn.conversation_id).view(turn);
    const b = this.boundary(turn);
    if (!b) return null;
    const row = this.repository.latest(this.conversationId, b.beforeSeq);
    const cursor = { seq: row?.end_seq ?? 0, offset: row?.end_offset ?? 0 };
    const count = this.repository.count(
      this.conversationId,
      cursor,
      b.beforeSeq,
    );
    const excerpts = [];
    let position = { ...cursor };
    for (let i = 0; i < 3; i++) {
      const m = this.repository.next(
        this.conversationId,
        position,
        b.beforeSeq,
        600,
      );
      if (!m) break;
      excerpts.push({
        id: m.id,
        role: m.role,
        text: m.text,
        offset: m.seq === position.seq ? position.offset : 0,
        truncated: true,
      });
      position = { seq: m.seq + 1, offset: 0 };
    }
    return {
      checkpointId: row?.id ?? null,
      summary: row ? JSON.parse(row.summary_json) : null,
      coveredBefore: cursor,
      recentFromSeq: b.beforeSeq,
      anchorId: b.anchor.id,
      gap: { messages: count, excerpts, incomplete: count > 0 },
      semanticReview: "unverified",
    };
  }
  status() {
    const row = this.repository.latest(this.conversationId);
    return {
      conversationId: this.conversationId,
      checkpointId: row?.id ?? null,
      summary: row ? JSON.parse(row.summary_json) : null,
      cursor: { seq: row?.end_seq ?? 0, offset: row?.end_offset ?? 0 },
      pending: this.repository.pending(this.conversationId),
      semanticReview: "unverified",
    };
  }
  retry() {
    return this.uow.transaction(() => ({
      reset: this.repository.retry(this.conversationId),
    }));
  }
}
