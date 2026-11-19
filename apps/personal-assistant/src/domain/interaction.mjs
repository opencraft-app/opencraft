import { questionChoices } from "./user-message.mjs";
import { digest, requireText, requireRevision } from "./values.mjs";

/** One durable request for information, bound to an exact work revision and native call. */
export class Interaction {
  static create(work, executionId, callId, question, owner, now, options = {}) {
    requireText(callId, "callId", 1000);
    requireText(question, "question", 10000);
    const kind = options.kind ?? "question";
    if (!["question", "secret", "authorization", "handoff"].includes(kind)) throw new Error("Invalid interaction kind");
    const provider = options.provider ?? "local";
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider)) throw new Error("Invalid intervention provider");
    const ttl = options.expiresInMs ?? (kind === "question" ? null : 1800000);
    if (ttl !== null && (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 86400000))
      throw new Error("Intervention deadline must be 1s..24h");
    return {
      kind,
      expires_at: ttl === null ? null : now + ttl,
      metadata_json: JSON.stringify({
        provider,
        ...(kind === "question" ? questionChoices(options) : {}),
      }),
      id: `interaction_${digest([executionId, callId])}`,
      work_id: work.id,
      revision: work.revision,
      execution_id: executionId,
      call_id: callId,
      question,
      owner,
      state: "pending",
      answer: null,
      answer_input_id: null,
      created_at: now,
      answered_at: null,
    };
  }
  constructor(record) {
    if (!record) throw new Error("Unknown interaction");
    this.record = { ...record };
  }
  assertPending(work, expectedRevision, owner, now = Date.now()) {
    if (this.record.expires_at !== null && this.record.expires_at !== undefined && this.record.expires_at <= now)
      throw new Error("Interaction has expired");
    requireRevision(expectedRevision, this.record.revision, "interaction");
    if (this.record.owner !== owner) throw new Error("Interaction belongs to another owner");
    if (this.record.state !== "pending") throw new Error(`Interaction is ${this.record.state}`);
    if (work.revision !== this.record.revision || work.status !== "waiting_input")
      throw new Error("Interaction no longer belongs to the current work direction");
  }
  answer(work, expectedRevision, owner, text, inputId, now) {
    this.assertPending(work, expectedRevision, owner, now);
    if ((this.record.kind ?? "question") !== "question") throw new Error("Use the typed intervention completion path");
    requireText(text, "answer");
    const meta = JSON.parse(this.record.metadata_json ?? "{}");
    if (meta.choices) {
      const exact = meta.choices.find((c) => c.value === text);
      const labels = meta.choices.filter((c) => c.label === text);
      if (exact) text = exact.value;
      else if (labels.length === 1) text = labels[0].value;
      else if (!meta.allowCustom) throw new Error("Answer is not an offered choice");
    }
    return {
      ...this.record,
      state: "answered",
      answer: text,
      answer_input_id: inputId,
      answered_at: now,
    };
  }
}
