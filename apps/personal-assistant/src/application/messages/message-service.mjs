import { userMessage } from "../../domain/user-message.mjs";
import { stable } from "../../domain/values.mjs";

/** Owns user-visible envelopes/outbox/transport receipts, not canonical history, Work or questions. */
export class MessageService {
  constructor({
    repository,
    uow,
    conversationId,
    requireConversation = (id) => {
      if (id !== conversationId) throw new Error("Conversation is outside this assistant");
      return id;
    },
    attachments,
    readMessage,
    readInteraction,
    readWork,
    now = Date.now,
  }) {
    Object.assign(this, {
      repository,
      uow,
      conversationId,
      requireConversation,
      attachments,
      readMessage,
      readInteraction,
      readWork,
      now,
    });
  }
  inConversation(id) {
    this.requireConversation(id);
    return id === this.conversationId ? this : new MessageService({ ...this, conversationId: id });
  }
  resolve(raw, interactive = false) {
    const body = userMessage(raw, interactive);
    if (body.replyTo && !this.readMessage(body.replyTo, this.conversationId))
      throw new Error("Reply target is outside this conversation");
    const refs =
      body.type === "attachment"
        ? [
            {
              attachmentId: body.attachmentId,
              ...(body.alt ? { alt: body.alt } : {}),
            },
          ]
        : body.attachments;
    if (refs)
      body.files = refs.map((a) => ({
        ...this.attachments.describe(a.attachmentId),
        ...(a.alt ? { alt: a.alt } : {}),
      }));
    if (body.interactionId) {
      const i = this.readInteraction(body.interactionId, this.conversationId);
      const type = {
        question: "question",
        secret: "secret-request",
        authorization: "authorization-request",
        handoff: "handoff",
      }[i.kind ?? "question"];
      if (body.type !== type) throw new Error("Message does not match its interaction kind");
      const meta = JSON.parse(i.metadata_json);
      body.question = {
        prompt: i.question,
        revision: i.revision,
        kind: i.kind ?? "question",
        expiresAt: i.expires_at,
        ...(meta.choices ? { choices: meta.choices, allowCustom: meta.allowCustom } : {}),
        ...(["secret", "authorization"].includes(i.kind) ? { provider: meta.provider, secureInput: true } : {}),
      };
    }
    return body;
  }
  record(message, body) {
    if (message.role !== "assistant" || message.conversation_id !== this.conversationId)
      throw new Error("Message is outside the assistant conversation");
    const old = this.repository.get(message.id);
    if (old) {
      if (old.body_json !== stable(body)) throw new Error("Message identity reused with different payload");
      return;
    }
    this.repository.add(message, body);
  }
  view(row) {
    const body = JSON.parse(row.body_json);
    const action = body.interactionId ? this.readInteraction(body.interactionId, row.conversation_id) : null;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      body,
      state: row.state,
      attempts: row.attempts,
      receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
      readStatus: "unknown",
      error: row.error,
      ...(action
        ? {
            interactionState: action.state,
            interactionRevision: action.revision,
          }
        : {}),
      ...(row.cursor === undefined ? {} : { cursor: row.cursor }),
    };
  }
  has(id) {
    const row = this.repository.get(id);
    return !!row && row.conversation_id === this.conversationId;
  }
  get(id) {
    const row = this.repository.get(id);
    if (!row || row.conversation_id !== this.conversationId) throw new Error("Unknown user message");
    return this.view(row);
  }
  list({ after = 0, limit = 20 } = {}) {
    if (
      !Number.isSafeInteger(Number(after)) ||
      Number(after) < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new Error("Invalid message page");
    const rows = this.repository.list(this.conversationId, Number(after), limit + 1);
    return {
      items: rows.slice(0, limit).map((r) => this.view(r)),
      next: rows.length > limit ? String(rows[limit - 1].cursor) : null,
    };
  }
  pending() {
    const rows = this.repository.pending(this.now()),
      result = [];
    for (const row of rows) {
      const body = JSON.parse(row.body_json);
      const canonical = this.readMessage(row.id, row.conversation_id),
        meta = canonical ? JSON.parse(canonical.data) : {};
      if (meta.workId && meta.revision !== undefined && this.readWork) {
        const work = this.readWork(meta.workId);
        if (
          work.revision !== meta.revision ||
          work.status === "cancelled" ||
          (meta.kind === "progress" && work.status === "completed")
        ) {
          this.uow.transaction(() => this.repository.withdrawn(row.id));
          continue;
        }
      }
      if (body.interactionId) {
        const i = this.readInteraction(body.interactionId, row.conversation_id);
        if (i.state !== "pending" || (i.expires_at !== null && i.expires_at <= this.now())) {
          this.uow.transaction(() => this.repository.withdrawn(row.id));
          continue;
        }
      }
      result.push({
        ...row,
        body,
        ...(meta.receptionPresentation?.origin === "reception" && typeof meta.receptionPresentation.text === "string"
          ? { presentation: meta.receptionPresentation }
          : {}),
      });
    }
    return result;
  }
  accepted(message, receipt) {
    if (
      !receipt ||
      receipt.messageId !== message.id ||
      receipt.channel !== message.body.channel ||
      receipt.level !== "accepted" ||
      typeof receipt.remoteId !== "string" ||
      !receipt.remoteId ||
      receipt.remoteId.length > 300
    )
      throw new Error("Invalid user delivery receipt");
    this.uow.transaction(() =>
      this.repository.accepted(
        message.id,
        {
          messageId: message.id,
          channel: receipt.channel,
          level: receipt.level,
          remoteId: receipt.remoteId,
        },
        this.now(),
      ),
    );
  }
  failed(message, error) {
    this.uow.transaction(() =>
      this.repository.failed(message.id, error, this.now() + Math.min(30000, 250 * 2 ** Math.min(message.attempts, 7))),
    );
  }
  retry(id) {
    this.get(id);
    return this.uow.transaction(() => ({ reset: this.repository.retry(id) }));
  }
  replyTarget(id) {
    const m = this.get(id);
    if (!m.body.interactionId) throw new Error("Message has no pending interaction");
    return m.body.interactionId;
  }
}
