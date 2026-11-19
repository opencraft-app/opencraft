import { userMessage } from "./user-message.mjs";
import { memoryProjectSlug } from "./memory-spaces.mjs";
import { digest, requireText } from "./values.mjs";
import { CompletionContract } from "./completion-contract.mjs";
import { Routine } from "./routine.mjs";
import { notificationPolicy } from "./notification-policy.mjs";

export class Conversation {
  static messageId(conversationId, identity, role) {
    return `message_${digest([conversationId, identity, role])}`;
  }
  static main(assistant) {
    return {
      id: `conversation_${digest(assistant.id).slice(0, 24)}`,
      assistant_id: assistant.id,
    };
  }
  static message(conversationId, identity, role, text, now, data = {}) {
    if (!["user", "assistant"].includes(role)) throw new Error("Unsupported conversation role");
    requireText(text, "message", 1000000);
    return {
      id: this.messageId(conversationId, identity, role),
      conversation_id: conversationId,
      role,
      text,
      at: now,
      data,
    };
  }
}

/** Model proposals are data. Application services resolve identity, permissions and revisions. */
export class ReceptionDecision {
  static parse(proposal) {
    if (proposal?.kind === "batch") {
      if (
        !Array.isArray(proposal.commands) ||
        proposal.commands.length < 1 ||
        proposal.commands.length > 4 ||
        proposal.commands.some((c) => !c || c.kind === "batch")
      )
        throw new Error("A reception batch requires 1..4 non-nested commands");
      return {
        kind: "batch",
        commands: proposal.commands.map((c) => this.parse(c)),
      };
    }
    if (
      !proposal ||
      ![
        "reply",
        "send",
        "delegate",
        "amend",
        "instruct",
        "resume",
        "goal.create",
        "goal.extend",
        "goal.rebase",
        "goal.reopen",
        "goal.review",
        "goal.pause",
        "goal.resume",
        "goal.cancel",
        "goal.update",
        "cancel",
        "clarify",
        "answer",
        "reject",
        "project.create",
        "project.join",
        "project.leave",
        "remember",
        "forget",
        "routine.create",
        "routine.update",
        "routine.pause",
        "routine.resume",
      ].includes(proposal.kind)
    )
      throw new Error("Unsupported reception decision");
    const value = { kind: proposal.kind };
    if (value.kind.startsWith("goal.")) {
      if (value.kind === "goal.create") return { kind: value.kind, definition: proposal.definition };
      const goalId = requireText(proposal.goalId, "goalId", 160);
      if (!Number.isSafeInteger(proposal.expectedRevision) || proposal.expectedRevision < 1)
        throw new Error("Goal revision is required");
      return {
        kind: value.kind,
        goalId,
        expectedRevision: proposal.expectedRevision,
        ...(value.kind === "goal.rebase"
          ? {
              workId: proposal.workId,
              expectedWorkRevision: proposal.expectedWorkRevision,
              dependencies: proposal.dependencies,
            }
          : {}),
        ...(value.kind === "goal.extend" ? { tasks: proposal.tasks } : {}),
        ...(value.kind === "goal.review" ? { evidence: proposal.evidence } : {}),
        ...(value.kind === "goal.update" ? { priority: proposal.priority, maxParallel: proposal.maxParallel } : {}),
      };
    }
    if (["instruct", "resume"].includes(value.kind)) value.text = requireText(proposal.text, "instruction", 10000);
    if (value.kind === "send") value.message = userMessage(proposal.message);
    if (["routine.create", "routine.update"].includes(value.kind)) {
      const raw = (value.kind === "routine.update" ? proposal.definition : proposal.params) ?? {};
      const params = {
        text: raw.text,
        startAt: raw.startAt,
        intervalMs: raw.intervalMs,
        // User-created chat arrangements notify by default; the automation API stays quiet.
        notify: notificationPolicy(raw.notify === undefined && value.kind === "routine.create" ? "always" : raw.notify),
      };
      if (raw.schedule !== undefined) params.schedule = raw.schedule;
      for (const key of ["expiresAt", "maxRuns", "stopWhen"]) if (raw[key] !== undefined) params[key] = raw[key];
      Routine.validate(params);
      if (value.kind === "routine.update") value.definition = params;
      else value.params = params;
    }
    if (["routine.pause", "routine.resume", "routine.update"].includes(value.kind)) {
      value.routineId = requireText(proposal.routineId, "routineId", 160);
      if (!Number.isSafeInteger(proposal.expectedRevision) || proposal.expectedRevision < 1)
        throw new Error("A routine revision is required");
      value.expectedRevision = proposal.expectedRevision;
    }
    if (["reply", "clarify"].includes(value.kind)) value.text = requireText(proposal.text, "reply", 10000);
    if (["delegate", "amend"].includes(value.kind)) value.goal = requireText(proposal.goal, "goal");
    if (value.kind === "amend") value.completion = CompletionContract.replacement(value.goal, proposal.completion);
    if (value.kind === "delegate" && proposal.completion !== undefined)
      value.completion = CompletionContract.create(value.goal, proposal.completion);
    if (["amend", "cancel", "instruct", "resume"].includes(value.kind)) {
      value.workId = requireText(proposal.workId, "workId", 160);
      if (!Number.isSafeInteger(proposal.expectedRevision) || proposal.expectedRevision < 1)
        throw new Error("An existing work revision is required");
      value.expectedRevision = proposal.expectedRevision;
    }
    if (["answer", "reject"].includes(value.kind)) {
      value.interactionId = requireText(proposal.interactionId, "interactionId", 160);
      if (!Number.isSafeInteger(proposal.expectedRevision) || proposal.expectedRevision < 1)
        throw new Error("An interaction revision is required");
      value.expectedRevision = proposal.expectedRevision;
      if (value.kind === "answer") value.text = requireText(proposal.text, "answer");
    }
    if (["project.create", "project.join", "project.leave"].includes(value.kind)) {
      value.params = { slug: memoryProjectSlug(proposal.project) };
      if (value.kind === "project.create") {
        value.params.name = requireText(proposal.name, "project name", 120);
        value.params.description =
          proposal.description === undefined ? "" : requireText(proposal.description, "description", 2000);
      }
    }
    if (["remember", "forget"].includes(value.kind)) {
      if (proposal.scope !== undefined && !["agent", "user", "project"].includes(proposal.scope))
        throw new Error("Invalid memory scope");
      if (proposal.memoryKind !== undefined && !["profile", "log"].includes(proposal.memoryKind))
        throw new Error("Invalid memory kind");
      value.key = requireText(proposal.key, "key", 160);
      if (proposal.scope !== undefined) value.scope = proposal.scope;
      if (proposal.project !== undefined) value.project = memoryProjectSlug(proposal.project);
      if (proposal.memoryKind !== undefined) value.kindHint = proposal.memoryKind;
      if (!Number.isSafeInteger(proposal.expectedRevision) || proposal.expectedRevision < 0)
        throw new Error("An explicit memory revision is required");
      value.expectedRevision = proposal.expectedRevision;
      if (value.kind === "remember") value.value = requireText(proposal.value, "value");
    }
    // Never forward a model-supplied actor, grant, path, tools or arbitrary command.
    return value;
  }
}
