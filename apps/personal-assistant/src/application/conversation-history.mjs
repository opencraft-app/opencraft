import { recallOptions } from "../domain/memory-recall.mjs";
import { requireText, digest } from "../domain/values.mjs";
import { Conversation } from "../domain/conversation.mjs";

/** Canonical history owner. Pi transcripts are execution evidence, not a second writable copy. */
export class ConversationHistory {
  memoryEvidence(ids) {
    if (!Array.isArray(ids) || ids.length > 8 || ids.some((id) => typeof id !== "string" || id.length > 160))
      throw Error("Invalid memory evidence");
    return ids.map((id) => {
      const m = this.repository.memoryEvidence(this.main.assistant_id, id);
      return m
        ? { id: m.id, text: m.text.slice(0, 4000), at: m.at, truncated: m.text.length > 4000 }
        : { id, unavailable: true };
    });
  }
  link(conversationId, workId) {
    this.repository.link(conversationId, workId);
  }
  constructor(assistant, repository, now = Date.now, { uow = null, messages = null } = {}) {
    Object.assign(this, { uow, messages });
    this.repository = repository;
    this.now = now;
    this.main = Conversation.main(assistant);
    repository.ensure(this.main);
  }
  require(id = this.main.id) {
    requireText(id, "conversationId", 160);
    const row = this.repository.get(id);
    if (!row || row.assistant_id !== this.main.assistant_id) throw new Error("Conversation is outside this assistant");
    return row.id;
  }
  create(inputId, params, inbox) {
    if (Object.keys(params).length) throw new Error("New conversation accepts no fields");
    return inbox.accept(inputId, "conversation.create", params, () => {
      const id = `conversation_${digest([this.main.assistant_id, inputId]).slice(0, 32)}`;
      this.repository.ensure({ id, assistant_id: this.main.assistant_id });
      this.require(id);
      return { conversationId: id };
    });
  }
  list({ after = "", limit = 20 } = {}) {
    if (typeof after !== "string" || after.length > 160 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new Error("Invalid conversation page");
    const rows = this.repository.list(this.main.assistant_id, after, limit + 1);
    return {
      items: rows.slice(0, limit).map((r) => ({ conversationId: r.id })),
      next: rows.length > limit ? rows[limit - 1].id : null,
    };
  }
  append(conversationId, identity, role, text, data = {}) {
    this.require(conversationId);
    const message = Conversation.message(conversationId, identity, role, text, this.now(), data);
    const body =
      role === "assistant" && this.messages
        ? this.messages.inConversation(conversationId).resolve(data.message ?? { type: "text", content: text }, true)
        : null;
    if (body) {
      message.data = { ...data, messageId: message.id };
      delete message.data.message;
    }
    const write = () => {
      this.repository.append(message);
      if (body) this.messages.inConversation(conversationId).record(message, body);
    };
    if (this.uow) this.uow.transaction(write);
    else write();
    return message.id;
  }
  prepareMessage(raw, conversationId = this.main.id) {
    return this.messages.inConversation(this.require(conversationId)).resolve(raw);
  }
  send(conversationId, identity, raw, data = {}) {
    const body = this.prepareMessage(raw, conversationId);
    const text = body.type === "text" ? body.content : `附件：${body.files[0].name}`;
    return this.append(conversationId, identity, "assistant", text, {
      ...data,
      message: raw,
    });
  }

  destinations(workId) {
    return this.repository.destinations(workId);
  }
  batch(notices) {
    const groups = [];
    let group = [],
      count = 0;
    const attachments = (n) => {
      const m = n.user_message_json ? JSON.parse(n.user_message_json) : null;
      return m?.type === "attachment"
        ? [{ attachmentId: m.attachmentId, ...(m.alt ? { alt: m.alt } : {}) }]
        : (m?.attachments ?? []);
    };
    for (const n of notices) {
      const size = attachments(n).length;
      if (group.length && count + size > 8) {
        groups.push(group);
        group = [];
        count = 0;
      }
      group.push(n);
      count += size;
    }
    if (group.length) groups.push(group);
    for (const batch of groups) {
      const text = batch
        .map(
          (n) =>
            `${n.text.slice(0, 6000)}${n.text.length > 6000 ? "\n（通知已截断，完整结果在工作详情和mailbox）" : ""}`,
        )
        .join("\n\n");
      const files = batch.flatMap(attachments);
      this.append(batch[0].conversation_id, `notification:${digest(batch.map((n) => n.id))}`, "assistant", text, {
        kind: "notification",
        deliveryIds: batch.map((n) => n.delivery_id),
        workIds: batch.map((n) => n.work_id),
        ...(files.length ? { message: { type: "text", content: text, attachments: files } } : {}),
      });
    }
  }

  result(delivery) {
    for (const id of this.repository.destinations(delivery.work_id))
      this.append(id, delivery.id, "assistant", delivery.text, {
        ...(delivery.user_message_json ? { message: JSON.parse(delivery.user_message_json) } : {}),
        kind: "result",
        revision: delivery.revision,
        workId: delivery.work_id,
        deliveryId: delivery.id,
      });
  }
  workNotice(work, kind) {
    // Routine outputs remain in their mailbox; no unsolicited main-chat messages.
    if (work.source === "routine") return;
    const text =
      kind === "progress"
        ? `这项工作仍在处理中：${work.id}。尚未产生可交付结果。`
        : `这项工作暂时无法继续：${work.id}。可查看工作详情并修改目标后继续。`;
    for (const id of this.repository.destinations(work.id))
      this.append(id, `${work.id}:r${work.revision}:${kind}`, "assistant", text, {
        kind,
        workId: work.id,
        revision: work.revision,
      });
  }
  completionBlocked(work, assessment) {
    for (const id of this.repository.destinations(work.id))
      this.append(
        id,
        `${work.id}:r${work.revision}:completion-blocked`,
        "assistant",
        `这项工作尚未通过完成检查：${
          assessment.checks
            .filter((c) => !c.passed)
            .map((c) => c.id)
            .join(", ") || "结果为空"
        }。可查看工作详情并修改目标或条件后继续。`,
        {
          kind: "completion-blocked",
          workId: work.id,
          revision: work.revision,
        },
      );
  }
  question(request) {
    const options = JSON.parse(request.metadata_json ?? "{}").choices;
    const prompt =
      request.question + (options ? "\n可选项：" + options.map((c) => `${c.label}（${c.value}）`).join("、") : "");
    for (const id of this.repository.destinations(request.work_id))
      this.append(
        id,
        request.id,
        "assistant",
        ["secret", "authorization"].includes(request.kind)
          ? `${request.question}\n请使用 ${request.kind === "secret" ? "provide-secret" : "authorize"} --secret-file 专用通路，不要在聊天中发送秘密。`
          : prompt,
        {
          message: {
            type: {
              question: "question",
              secret: "secret-request",
              authorization: "authorization-request",
              handoff: "handoff",
            }[request.kind ?? "question"],
            interactionId: request.id,
          },
          kind: "question",
          interactionId: request.id,
          interventionKind: request.kind ?? "question",
          expiresAt: request.expires_at ?? null,
          workId: request.work_id,
          revision: request.revision,
        },
      );
  }
  search(options = {}, workId) {
    const conversationId = this.require(
      options.conversationId ?? (workId ? this.destinations(workId)[0] : this.main.id),
    );
    const p = recallOptions(options);
    if (!p.query) throw new Error("History search needs literal query text");
    if (workId && !this.repository.destinations(workId).includes(conversationId))
      throw new Error("Work has no conversation history grant");
    const rows = this.repository.search(conversationId, {
      ...p,
      limit: p.limit + 1,
    });
    return {
      items: rows.slice(0, p.limit).map((m) => ({
        ...m,
        text: m.text.slice(0, 2000),
        truncated: m.text.length > 2000,
      })),
      next: rows.length > p.limit ? String(rows[p.limit - 1].seq) : null,
      semanticSearch: false,
    };
  }
  view({ conversationId = this.main.id, limit = 100 } = {}) {
    this.require(conversationId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid history limit");
    const messages = this.messages?.inConversation(conversationId);
    return {
      conversationId,
      messages: this.repository.messages(conversationId, limit).map((m) => ({
        ...m,
        ...(messages && m.role === "assistant" && messages.has(m.id) ? { message: messages.get(m.id) } : {}),
      })),
      works: this.repository.works(conversationId),
    };
  }
}
