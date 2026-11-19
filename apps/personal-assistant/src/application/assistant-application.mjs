import { GoalService } from "./goal-service.mjs";
import { MessageService } from "./messages/message-service.mjs";
import { digest } from "../domain/values.mjs";
import { Conversation } from "../domain/conversation.mjs";
import { ConversationContextService } from "./conversation-context/context-service.mjs";
import { MemoryProjectService } from "./memory/memory-project-service.mjs";
import { UsageService } from "./usage/usage-service.mjs";
import { AttentionService } from "./automations/attention-service.mjs";
import { EventTriggerService } from "./automations/event-trigger-service.mjs";
import { NotificationService } from "./notification-service.mjs";
import { MemoryLearningService } from "./memory/memory-learning-service.mjs";
import { SkillService } from "./skills/skill-service.mjs";
import { InputInbox } from "./input-inbox.mjs";
import { WorkService } from "./work-service.mjs";
import { MemoryService } from "./memory-service.mjs";
import { RoutineService } from "./routine-service.mjs";
import { ExecutionService } from "./execution-service.mjs";
import { OutcomeService } from "./outcome-service.mjs";
import { ConversationHistory } from "./conversation-history.mjs";
import { ReceptionService } from "./reception-service.mjs";
import { ExecutionLedger } from "./execution-ledger.mjs";
import { OutcomeLedger } from "./outcome-ledger.mjs";
import { InteractionLedger } from "./interaction-ledger.mjs";
import { InteractionService } from "./interaction-service.mjs";
import { CompletionLedger } from "./completion-ledger.mjs";
import { CompletionService } from "./completion-service.mjs";
import { CompletionContract } from "../domain/completion-contract.mjs";
import { ReceptionQueries } from "./reception/query-service.mjs";
import { ReceptionContextBuilder } from "./reception/context-builder.mjs";
import { epochTime } from "../domain/values.mjs";

/** Command/query boundary. It owns no database driver, model client or process. */
export class AssistantApplication {
  constructor({
    assistant,
    attachments,
    scope,
    uow,
    repositories,
    mode,
    executionHarness = "pi",
    platformReads = null,
    receptionReads,
    receptionMaterials = null,
    credentials = null,
    timeZone = "UTC",
    memoryPolicy,
    memoryFiles,
    memoryDefaultScope = "user",
    now = Date.now,
  }) {
    this.assistant = assistant;
    this.scope = scope;
    this.uow = uow;
    this.r = repositories;
    this.mode = mode;
    this.now = now;
    const persisted = this.r.meta.identity();
    if (persisted) assistant.verifyPersisted(persisted);
    this.r.meta.bind(assistant.identity());
    const deps = { uow, repositories, now, scope };
    this.inbox = new InputInbox(uow, repositories.inputs, repositories.events, now);
    this.executionLedger = new ExecutionLedger(repositories.executions, executionHarness);
    this.outcomeLedger = new OutcomeLedger(repositories.outcomes, now);
    this.interactionLedger = new InteractionLedger(repositories.interactions);
    this.works = new WorkService({
      ...deps,
      assertEditable: (id) => this.goals.assertEditable(id),
      inbox: this.inbox,
      ledger: this.executionLedger,
      outcomes: this.outcomeLedger,
      interactions: this.interactionLedger,
    });
    this.usage = new UsageService({
      repository: repositories.usage,
      uow,
      readExecutions: (id) => repositories.executions.list(id),
      readWork: (id) => this.works.require(id).record,
      now,
    });
    this.skills = new SkillService({
      repository: repositories.skills,
      inbox: this.inbox,
      uow,
      now,
      assertCurrent: (work) => this.works.assertCurrent(work),
    });
    this.memory = new MemoryService({
      ...deps,
      inbox: this.inbox,
      files:
        memoryFiles &&
        Object.freeze(
          Object.fromEntries(
            ["synchronize", "projects", "locations", "read", "browserFiles"].map((k) => [k, memoryFiles[k]]),
          ),
        ),
      agentId: assistant.id,
      defaultScope: memoryDefaultScope,
    });
    this.memoryProjects = new MemoryProjectService({
      files:
        memoryFiles &&
        Object.freeze({
          project: memoryFiles.project,
          projects: memoryFiles.projects,
        }),
      inbox: this.inbox,
      invalidate: () => this.memory.filesChanged(),
    });
    this.memoryLearning = new MemoryLearningService({
      repository: repositories.memoryLearning,
      policy: memoryPolicy,
      memory: Object.freeze({
        learningSnapshot: (...args) => this.memory.learningSnapshot(...args),
        rebaseSnapshot: (snapshot) => this.memory.rebaseSnapshot(snapshot),
        captureSnapshot: (turn) =>
          this.memory.learningSnapshot(
            this.memory.projectFor(scope.queryScope(turn, this.history.require(turn.conversation_id)).resources),
            scope.queryScope(turn, this.history.require(turn.conversation_id)).resources,
          ),
        snapshotCurrent: (...args) => this.memory.snapshotCurrent(...args),
        reviewDue: (...args) => this.memory.reviewDue(...args),
        reviewed: (...args) => this.memory.reviewed(...args),
        applySynthesis: (...args) => this.memory.applySynthesis(...args),
        epoch: () => this.memory.epoch(),
        applyLearned: (...args) => this.memory.applyLearned(...args),
      }),
      uow,
      now,
    });
    this.attachments = attachments;
    this.messages = new MessageService({
      repository: repositories.messages,
      uow,
      conversationId: Conversation.main(assistant).id,
      requireConversation: (id) => this.history.require(id),
      attachments,
      readMessage: (id, conversationId) => repositories.conversations.message(this.history.require(conversationId), id),
      readWork: (id) => this.works.require(id).record,
      readInteraction: (id, conversationId) =>
        this.interactions.assertInConversation(id, this.history.require(conversationId)),
      now,
    });
    this.history = new ConversationHistory(assistant, repositories.conversations, now, {
      uow,
      messages: this.messages,
    });
    this.conversationContext = new ConversationContextService({
      repository: repositories.conversationContext,
      uow,
      conversationId: this.history.main.id,
      requireConversation: (id) => this.history.require(id),
      now,
    });
    this.attention = new AttentionService({
      inbox: this.inbox,
      repository: repositories.attention,
      uow,
      now,
      notice: (identity, text, data) => this.history.append(this.history.main.id, identity, "assistant", text, data),
    });
    this.notifications = new NotificationService({
      attention: Object.freeze({ notified: () => this.attention.notified() }),
      repository: repositories.notifications,
      uow,
      readWork: (id) => this.works.require(id).record,
      history: Object.freeze({
        result: (d) => this.history.result(d),
        destinations: (id) => this.history.destinations(id),
        batch: (ns) => this.history.batch(ns),
      }),
      now,
    });
    this.triggers = new EventTriggerService({
      repository: repositories.triggers,
      inbox: this.inbox,
      uow,
      workPort: Object.freeze({
        create: (...args) => this.works.create(...args),
      }),
      history: Object.freeze({
        mainId: this.history.main.id,
        link: (...args) => this.history.link(...args),
      }),
      captureResources: (inputId) => scope.delegate(inputId).resources,
      canObserve: (resources) => scope.canObserve(resources),
      now,
    });
    this.routines = new RoutineService({
      ...deps,
      attention: Object.freeze({
        active: () => this.attention.active(),
        assess: () => this.attention.assess(),
        fired: () => this.attention.fired(),
      }),
      history: this.history,
      inbox: this.inbox,
      works: this.works,
    });
    this.executions = new ExecutionService({
      ...deps,
      ready: (work) => !this.goals.reasons(work).length,
      goalInputs: (work) => this.goals.capture(work),
      confirmedInputs: (work) => this.interactions.confirmedInputs(work),
      history: this.history,
      skills: Object.freeze({ snapshot: () => this.skills.snapshot() }),
      works: this.works,
      memory: Object.freeze({
        list: () => this.memory.list(),
        recall: (...args) => this.memory.recall(...args),
        prompt: (...args) => this.memory.prompt(...args),
        epoch: () => this.memory.epoch(),
        guardEpoch: () => this.memory.guardEpoch(),
      }),
      ledger: this.executionLedger,
      inbox: this.inbox,
      reportReceiver: (report, work) => this.reception.acceptReport(report, work),
    });
    this.completion = new CompletionService({
      ...deps,
      works: this.works,
      executions: this.executionLedger,
      ledger: new CompletionLedger(repositories.completion),
    });
    this.outcomes = new OutcomeService({
      ...deps,
      ready: (work) => !this.goals.reasons(work).length,
      inputsValid: (work) => !this.goals.reasons(work, false).length,
      notifications: Object.freeze({
        accepted: (delivery) => this.notifications.accepted(delivery),
      }),
      works: this.works,
      history: this.history,
      ledger: this.outcomeLedger,
      executions: this.executionLedger,
      completion: this.completion,
    });
    this.interactions = new InteractionService({
      credentials,
      ...deps,
      inbox: this.inbox,
      works: this.works,
      executions: this.executionLedger,
      executionService: this.executions,
      ledger: this.interactionLedger,
      history: this.history,
      assistant,
    });
    this.goals = new GoalService({
      repository: repositories.goals,
      inbox: this.inbox,
      uow,
      now,
      workPort: Object.freeze({
        create: (...args) => this.works.create(...args),
        read: (id) => this.works.require(id).record,
        amend: (...args) => this.works.amend(...args),
        cancel: (...args) => this.works.cancelWork(...args),
      }),
      history: Object.freeze({
        link: (id, conversationId) => this.history.link(this.history.require(conversationId), id),
        origin: (workId) => this.history.destinations(workId)[0],
      }),
      resources: (id) => scope.delegate(id).resources,
    });
    this.receptionQueries = new ReceptionQueries({
      authority: Object.freeze({
        forTurn: (turn) => scope.queryScope(turn, this.history.require(turn.conversation_id)),
        permits: (grant, resource) => scope.querySourceAllowed(grant, resource),
        memoryView: (grant) => this.memory.view(grant.resources),
        memoryDefaultScope: this.memory.defaultScope,
        readMemoryFile: (grant, params) => this.memory.readFile(params, grant.resources),
      }),
      reads: receptionReads,
      platformReads,
      attachments,
      materials: receptionMaterials,
      timeZone,
      now,
    });
    this.reception = new ReceptionService({
      ...deps,
      attachments,
      inbox: this.inbox,
      works: this.works,
      history: this.history,
      interactions: this.interactions,
      memory: this.memory,
      memoryProjects: this.memoryProjects,
      routines: this.routines,
      goals: this.goals,
      reports: Object.freeze({
        get: (work) => this.executionLedger.report(work),
        directives: (work) => this.executionLedger.contextDirectives(work),
        request: (work) => {
          const json = this.executionLedger.get(work).request_json;
          return json ? JSON.parse(json) : null;
        },
      }),
      completion: Object.freeze({
        assess: (...args) => this.completion.assess(...args),
        platformReadEvidence: (id) => this.completion.platformReadEvidence(id),
      }),
      outcomes: Object.freeze({
        record: (...args) => this.outcomes.record(...args),
      }),
      attention: Object.freeze({ active: () => this.attention.active() }),
      memoryLearning: Object.freeze({
        capture: (...args) => this.memoryLearning.capture(...args),
      }),
      contextBuilder: new ReceptionContextBuilder(
        receptionReads,
        this.receptionQueries,
        Object.freeze({ view: (turn) => this.conversationContext.view(turn) }),
      ),
    });
  }
  status() {
    return {
      ...this.assistant.identity(),
      mode: this.mode,
      reception: this.reception.activity(),
      works: this.r.works.list(),
      routines: this.r.routines.list(),
      memoryEpoch: this.memory.epoch(),
      pendingInteractions: this.interactions.list().filter((i) => i.state === "pending"),
    };
  }
  detail(id) {
    return {
      work: this.works.require(id).record,
      executions: this.r.executions.list(id),
      results: this.r.outcomes.results(id),
      deliveries: this.r.outcomes.deliveriesFor(id),
      reports: this.r.executions
        .list(id)
        .map((e) =>
          this.executionLedger.report({
            id,
            revision: e.revision,
            active_execution_id: e.id,
          }),
        )
        .filter(Boolean),
      inputs: this.r.inputs.forWork(id),
      directives: this.r.executions.directives(id),
      interactions: this.interactions.list().filter((i) => i.work_id === id),
      skills: this.skills.loads(id),
      completion: {
        contract: CompletionContract.forWork(this.works.require(id).record),
        executions: this.completion.detail(id),
      },
    };
  }
  event(kind, workId, data = {}) {
    this.r.events.append(kind, workId, data, this.now());
  }
  pendingWorks(active = new Set()) {
    return this.goals.schedule(this.r.works.pending(), active);
  }
  workRecord(id) {
    return this.works.require(id).record;
  }
  events(after = 0) {
    epochTime(after, "after");
    return this.r.events.list(after);
  }
  dispatch({ op, id, params: p }) {
    this.memory.synchronize();
    const conversationId = this.history.require(p.conversationId);
    const messages = this.messages.inConversation(conversationId);
    switch (op) {
      case "conversation.create":
        return this.history.create(id, p, this.inbox);
      case "conversation.list":
        return this.history.list(p);
      case "goal.create":
        return this.goals.create(id, p, undefined, p.conversationId);
      case "goal.rebase":
        return this.goals.rebase(id, p);
      case "goal.extend":
        return this.goals.extend(id, p);
      case "goal.list":
        return this.goals.list();
      case "goal.get":
        return this.goals.detail(p.goalId);
      case "goal.confirm":
        return this.goals.confirm(id, p);
      case "goal.reopen":
      case "goal.update":
      case "goal.pause":
      case "goal.resume":
      case "goal.cancel":
        return this.goals.change(id, op, p);
      case "messages.list":
        return messages.list(p);
      case "message.get":
        return messages.get(p.messageId);
      case "message.retry":
        return this.inbox.accept(id, op, p, () => messages.retry(p.messageId));
      case "message.send":
        if (Object.keys(p).some((k) => !["message", "conversationId"].includes(k)))
          throw new Error("Only a message envelope is accepted");
        return this.inbox.accept(id, op, p, () => ({
          messageId: this.history.send(conversationId, id, p.message),
        }));
      case "message.respond":
        if (
          Object.keys(p).some(
            (k) => !["messageId", "expectedRevision", "value", "reject", "conversationId"].includes(k),
          ) ||
          (p.reject === true && p.value !== undefined)
        )
          throw new Error("Invalid message response fields");
        return this.inbox.accept(id, op, p, () => {
          const interactionId = messages.replyTarget(p.messageId);
          const child = `message-response:${digest(id)}`;
          if (p.reject !== undefined && typeof p.reject !== "boolean") throw new Error("Invalid rejection");
          const receipt = p.reject
            ? this.interactions.reject(child, {
                interactionId,
                expectedRevision: p.expectedRevision,
              })
            : this.interactions.answer(child, {
                interactionId,
                expectedRevision: p.expectedRevision,
                text: p.value,
              });
          this.history.append(conversationId, id, "user", p.reject ? "已拒绝这项请求" : p.value, {
            kind: "interaction-response",
            interactionId,
            replyTo: p.messageId,
          });
          return receipt;
        });
      case "attachments.list":
        return this.attachments.list(p);
      case "usage":
        return this.usage.read(p);
      case "attention.status":
        return this.attention.status();
      case "attention.snooze":
        return this.attention.snooze(id, p);
      case "routine.update":
        return this.routines.update(id, p);
      case "routine.resume":
        return this.routines.resume(id, p);
      case "trigger.add":
        return this.triggers.add(id, p);
      case "trigger.list":
        return this.triggers.list();
      case "trigger.enable":
        return this.triggers.enable(id, p);
      case "event.emit":
        return this.triggers.emit(id, p);
      case "skill.install":
        return this.skills.install(id, p);
      case "skill.enable":
        return this.skills.enable(id, p);
      case "skill.list":
        return this.skills.catalog();
      case "status":
        return this.status();
      case "work.overview":
        return this.receptionQueries.overview(this.scope.queryGrant("local-overview", conversationId));
      case "work":
        return this.detail(p.workId);
      case "events":
        return this.events(p.after ?? 0);
      case "history.search":
        return this.history.search(p);
      case "memory.project.list":
        return this.memoryProjects.list();
      case "memory.project.create":
        return this.memoryProjects.change(id, "create", p);
      case "memory.project.join":
        return this.memoryProjects.change(id, "join", p);
      case "memory.project.leave":
        return this.memoryProjects.change(id, "leave", p);
      case "memory.locations":
        return this.memory.files.locations();
      case "memory.file.read":
        return this.memory.readFile(p);
      case "memory.search":
        return this.memory.recall(p);
      case "memory.list":
        return this.memory.list();
      case "submit":
        return this.works.submit(id, p);
      case "work.continue":
        return this.works.continue(id, p);
      case "work.instruct":
        return this.works.instruct(id, p);
      case "amend":
        return this.works.amend(id, p);
      case "cancel":
        return this.works.cancel(id, p);
      case "memory.set":
      case "memory.forget":
        return this.memory.change(id, op, p);
      case "routine.add":
        return this.routines.add(id, p);
      case "routine.pause":
        return this.routines.pause(id, p);
      case "say":
        return this.reception.accept(id, p);
      case "conversation.context":
        return this.conversationContext.forConversation(conversationId).status();
      case "conversation.context.retry":
        return this.inbox.accept(id, op, p, () => this.conversationContext.forConversation(conversationId).retry());
      case "conversation":
        this.attention.active(true);
        return this.history.view({ conversationId });
      case "turn":
        return this.reception.turn(p.inputId);
      case "interaction.list":
        return this.interactions.list();
      case "interaction.resolve":
        return this.interactions.resolve(id, p);
      case "interaction.answer":
        return this.interactions.answer(id, p);
      case "interaction.reject":
        return this.interactions.reject(id, p);
      default:
        throw new Error("Unknown operation");
    }
  }
}
