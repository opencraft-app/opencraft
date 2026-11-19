import { ReceptionDecision } from "../domain/conversation.mjs";
import { digest, requireText, requireRevision } from "../domain/values.mjs";
import { ContinuationDecision } from "../domain/continuation.mjs";
import { workOrigin } from "../domain/notification-policy.mjs";

/** Owns admission/settlement of assistant turns. Model calls happen outside its transactions. */
export class ReceptionService {
  constructor({
    uow,
    repositories: r,
    inbox,
    works,
    history,
    scope,
    interactions,
    memory,
    memoryProjects,
    attention,
    memoryLearning,
    contextBuilder,
    reports,
    goals,
    completion,
    outcomes,
    routines,
    attachments,
    now = Date.now,
  }) {
    Object.assign(this, {
      uow,
      r,
      inbox,
      works,
      history,
      scope,
      interactions,
      memory,
      memoryProjects,
      attention,
      memoryLearning,
      contextBuilder,
      reports,
      goals,
      completion,
      outcomes,
      routines,
      now,
      attachments,
    });
  }
  accept(inputId, params) {
    requireText(params.text, "text");
    const conversationId = this.history.require(params.conversationId);
    return this.inbox.accept(inputId, "say", params, () => {
      const queryScope = this.scope.queryGrant(inputId, conversationId);
      if (params.attachments !== undefined) {
        if (!Array.isArray(params.attachments) || params.attachments.length > 8 || !this.attachments)
          throw Error("Invalid attachments");
        queryScope.attachments = params.attachments.map((id) => this.attachments.describe(id));
      }
      if (params.workId !== undefined) {
        const workId = requireText(params.workId, "workId", 160);
        if (!this.r.conversations.linked(conversationId, workId))
          throw new Error("Target work is outside this conversation");
        const work = this.works.require(workId).record;
        if (params.expectedRevision !== undefined) requireRevision(params.expectedRevision, work.revision, "work");
        queryScope.targetWork = { workId, expectedRevision: work.revision };
      } else if (params.expectedRevision !== undefined) throw new Error("A work target is required for its revision");
      this.attention.active();
      this.history.append(conversationId, inputId, "user", params.text, {
        inputId,
      });
      this.r.reception.add({
        id: inputId,
        conversationId,
        text: params.text,
        at: this.now(),
        queryScope,
      });
      return { inputId, conversationId, status: "queued" };
    });
  }
  context(turn) {
    return this.contextBuilder.build(turn);
  }
  pending() {
    return this.r.reception
      .pending(this.now())
      .filter((turn) => !turn.source_json || !this.goals.reasons(this.works.require(turn.work_id).record).length);
  }
  activity() {
    return this.r.reception.activity(this.history.main.id);
  }
  started(id) {
    const turn = this.turn(id);
    if (turn.source_json && this.retireStale(turn)) return false;
    this.r.reception.started(id);
    return true;
  }
  apply(turn, rawProposal, queries = []) {
    if (turn.source_json) return this.applyReport(turn, rawProposal, queries);
    return this.uow.transaction(() => {
      const current = this.r.reception.get(turn.id);
      if (!current) throw new Error("Unknown reception input");
      if (current.status === "settled") return current;
      const proposal = ReceptionDecision.parse(rawProposal);
      const commands = proposal.kind === "batch" ? proposal.commands : [proposal];
      this.assertIndependentCommands(current, commands);
      const applied = commands.map((command, index) =>
        this.applyObservedCommand(
          current,
          command,
          `reception:${digest(turn.id)}${proposal.kind === "batch" ? `:${index}` : ""}`,
          commands,
          index,
        ),
      );
      const text = applied.map((a) => a.text).join("\n\n");
      const messages = applied.map((a) => a.message).filter(Boolean);
      if (messages.length && applied.length !== 1)
        throw new Error("Typed user messages must be a single reception decision");
      const workIds = applied.map((a) => a.workId).filter(Boolean);
      const workId = workIds[0];
      this.history.append(turn.conversation_id, `${turn.id}:reply`, "assistant", text, {
        kind: proposal.kind,
        // Typed host provenance, not guessed words; model replies remain intact.
        ...(!commands.some((c) => ["instruct", "resume", "answer", "delegate", "amend"].includes(c.kind))
          ? {}
          : {
              receptionPresentation: {
                origin: "reception",
                text: applied
                  .filter((a, i) => !["instruct", "resume", "answer", "delegate", "amend"].includes(commands[i].kind))
                  .map((a) => a.text)
                  .join("\n\n"),
              },
            }),
        ...(messages[0] ? { message: messages[0] } : {}),
        ...(workId ? { workId } : {}),
      });
      this.memoryLearning.capture(turn, text);
      this.r.reception.settled(
        turn.id,
        {
          ...proposal,
          queries,
          ...(proposal.kind === "batch" ? { workIds } : {}),
        },
        text,
        workId,
      );
      this.r.events.append("reception.settled", workId, { inputId: turn.id, kind: proposal.kind }, this.now());
      return this.r.reception.get(turn.id);
    });
  }
  commandFailure(error, commands, index, code = "command_rejected") {
    // Keep a bounded host-owned description, never proposal text/answers/secrets.
    error.commandFailure = {
      code,
      index,
      commands: commands.map((c) => c.kind),
    };
    return error;
  }
  applyObservedCommand(turn, command, input, commands, index) {
    try {
      return this.applyUserCommand(turn, command, input);
    } catch (error) {
      throw this.commandFailure(error, commands, index);
    }
  }
  assertIndependentCommands(turn, commands) {
    if (commands.length < 2) return;
    const fail = (index) => {
      throw this.commandFailure(
        new Error(
          "Conflicting commands: use one complete change for a targeted work; changing requirements already retires its pending questions",
        ),
        commands,
        index,
        "conflicting_commands",
      );
    };
    if (this.scope.queryScope(turn, this.history.require(turn.conversation_id)).targetWork) fail(0);
    const workEffects = new Map(),
      interactions = new Set(),
      goals = new Set(),
      plannedGoals = new Set(commands.map((c) => c.goalId).filter(Boolean));
    for (const [index, command] of commands.entries()) {
      const { kind } = command;
      if (command.goalId) {
        if (goals.has(command.goalId)) fail(index);
        goals.add(command.goalId);
      }
      let id = command.workId;
      if (["answer", "reject"].includes(kind)) {
        if (interactions.has(command.interactionId)) fail(index);
        interactions.add(command.interactionId);
        id = this.interactions.assertInConversation(command.interactionId, turn.conversation_id).work_id;
      }
      if (!id) continue;
      // Goal changes and member-work commands are not independent effects.
      const goalId = this.goals.forWork(id);
      if (goalId && plannedGoals.has(goalId) && command.goalId !== goalId) fail(index);
      const prior = workEffects.get(id) ?? [];
      if (
        prior.length &&
        [kind, ...prior].some((k) => ["amend", "cancel", "resume", "reject", "goal.rebase"].includes(k))
      )
        fail(index);
      workEffects.set(id, [...prior, kind]);
    }
  }
  applyUserCommand(turn, proposal, childInput) {
    let text, workId;
    const target = this.scope.queryScope(turn, this.history.require(turn.conversation_id)).targetWork;
    if (target) {
      if (
        !["reply", "clarify", "send", "amend", "instruct", "resume", "cancel", "answer", "reject"].includes(
          proposal.kind,
        )
      )
        throw new Error("A targeted follow-up cannot create unrelated work or commands");
      if (
        ["amend", "cancel", "instruct", "resume"].includes(proposal.kind) &&
        (proposal.workId !== target.workId || proposal.expectedRevision !== target.expectedRevision)
      )
        throw new Error("Follow-up does not match its captured work and revision");
      if (["answer", "reject"].includes(proposal.kind)) {
        const interaction = this.interactions.assertInConversation(proposal.interactionId, turn.conversation_id);
        if (interaction.work_id !== target.workId || interaction.revision !== target.expectedRevision)
          throw new Error("Follow-up interaction is outside its target work");
      }
    }
    if (
      ["amend", "cancel", "instruct", "resume"].includes(proposal.kind) &&
      !this.r.conversations.linked(turn.conversation_id, proposal.workId)
    )
      throw new Error("Target work is outside this conversation");
    switch (proposal.kind) {
      case "goal.create": {
        const result = this.goals.create(
          childInput,
          { definition: proposal.definition },
          this.scope.queryScope(turn, turn.conversation_id).resources,
          turn.conversation_id,
        );
        return {
          text: `已记录目标 ${result.id}，计划包含 ${result.works.length} 项工作；依赖满足后依次推进。`,
        };
      }
      case "goal.rebase": {
        const result = this.goals.rebase(childInput, proposal);
        return {
          text: `目标 ${result.id} 的依赖版本已显式更新，原结果保留，工作将重新执行。`,
        };
      }
      case "goal.extend": {
        const result = this.goals.extend(
          childInput,
          proposal,
          this.scope.queryScope(turn, turn.conversation_id).resources,
        );
        return { text: `已更新目标 ${result.id} 的工作计划。` };
      }
      case "goal.review": {
        const result = this.goals.review(childInput, proposal);
        return {
          text: `目标 ${result.id} 已按所引用证据完成模型复核；这不代表用户确认。`,
        };
      }
      case "goal.reopen":
      case "goal.pause":
      case "goal.resume":
      case "goal.cancel":
      case "goal.update": {
        const result = this.goals.change(childInput, proposal.kind, proposal);
        return { text: `目标 ${result.id}：${result.state}。` };
      }
      case "instruct":
      case "resume": {
        const result = this.works[proposal.kind === "instruct" ? "instruct" : "continue"](childInput, {
          workId: proposal.workId,
          expectedRevision: proposal.expectedRevision,
          text: proposal.text,
        });
        return {
          workId: result.workId,
          text: proposal.kind === "instruct" ? "收到，我会按这个调整。" : "好，继续做。",
        };
      }
      case "send": {
        const body = this.history.prepareMessage(proposal.message, turn.conversation_id);
        return {
          text: body.type === "text" ? body.content : `附件：${body.files[0].name}`,
          message: proposal.message,
        };
      }
      case "answer":
      case "reject": {
        this.interactions.assertInConversation(proposal.interactionId, turn.conversation_id);
        const params = {
          interactionId: proposal.interactionId,
          expectedRevision: proposal.expectedRevision,
          ...(proposal.kind === "answer" ? { text: proposal.text } : {}),
        };
        const receipt = this.interactions[proposal.kind](childInput, params);
        workId = receipt.workId;
        text = proposal.kind === "answer" ? "收到，继续。" : "好，这项先不提供，这件事暂停；改了要求我再继续。";
        break;
      }
      case "project.create":
      case "project.join":
      case "project.leave": {
        const result = this.memoryProjects.change(childInput, proposal.kind.split(".")[1], proposal.params);
        text = `项目 ${result.slug}：${result.joined ? "已加入记忆共享" : "已退出记忆共享"}。`;
        break;
      }
      case "remember":
      case "forget": {
        const receipt = this.memory.change(
          childInput,
          proposal.kind === "remember" ? "memory.set" : "memory.forget",
          {
            key: proposal.key,
            scope: proposal.scope,
            project: proposal.project,
            kind: proposal.kindHint,
            expectedRevision: proposal.expectedRevision,
            ...(proposal.kind === "remember" ? { value: proposal.value } : {}),
          },
          this.scope.receptionResources(turn, this.history.require(turn.conversation_id)),
        );
        text = receipt.deleted ? `已忘记：${receipt.key}。` : `已记住：${receipt.key} = ${proposal.value}。`;
        break;
      }
      case "delegate": {
        const receipt = this.works.submit(
          childInput,
          {
            text: proposal.goal,
            ...(proposal.completion === undefined ? {} : { completion: proposal.completion }),
          },
          this.scope.receptionResources(turn, this.history.require(turn.conversation_id)),
          this.requestContext(turn),
        );
        workId = receipt.workId;
        this.history.link(turn.conversation_id, workId);
        text = "好，在弄了，弄完告诉你。";
        break;
      }
      case "amend": {
        const receipt = this.works.amend(
          childInput,
          {
            workId: proposal.workId,
            text: proposal.goal,
            expectedRevision: proposal.expectedRevision,
            ...(proposal.completion === undefined ? {} : { completion: proposal.completion }),
          },
          this.requestContext(turn),
        );
        workId = receipt.workId;
        text = "好，按新的要求来。";
        break;
      }
      case "cancel": {
        const receipt = this.works.cancel(childInput, {
          workId: proposal.workId,
          expectedRevision: proposal.expectedRevision,
        });
        workId = receipt.workId;
        text = receipt.alreadyCompleted ? "这件事已经做完了，结果还在。" : "好，停下了。";
        break;
      }
      case "routine.create": {
        const receipt = this.routines.add(
          childInput,
          proposal.params,
          this.scope.receptionResources(turn, this.history.require(turn.conversation_id)),
        );
        text = "好，安排上了。";
        break;
      }
      case "routine.update": {
        const receipt = this.routines.update(childInput, {
          routineId: proposal.routineId,
          expectedRevision: proposal.expectedRevision,
          definition: proposal.definition,
        });
        text = "好，安排改好了。";
        break;
      }
      case "routine.pause":
      case "routine.resume": {
        const method = proposal.kind === "routine.pause" ? "pause" : "resume";
        const receipt = this.routines[method](childInput, {
          routineId: proposal.routineId,
          expectedRevision: proposal.expectedRevision,
        });
        text = `安排 ${receipt.routineId}：${receipt.status}。`;
        break;
      }
      default:
        text = proposal.text;
    }
    return { text, workId };
  }
  failed(turn, error, queries = []) {
    this.uow.transaction(() => {
      const current = this.r.reception.get(turn.id);
      if (current?.status === "settled") return;
      if (turn.source_json) {
        if (this.retireStale(current)) return;
        this.r.reception.retry(turn.id, error, queries, this.now() + Math.min(30000, 250 * 2 ** current.attempts));
        this.r.events.append(
          "reception.report-failed",
          turn.work_id,
          {
            turnId: turn.id,
            attempt: current.attempts + 1,
            error: String(error),
          },
          this.now(),
        );
        if (current.attempts >= 2) {
          const { source, work } = this.reportSource(current);
          if (
            work.revision === source.revision &&
            this.works.blocked(work, "Main assistant could not process the saved execution report")
          )
            this.history.workNotice(work, "execution-blocked");
        }
        return;
      }
      this.r.reception.blocked(turn.id, error, queries, error.commandFailure);
      this.history.append(
        turn.conversation_id,
        `${turn.id}:error`,
        "assistant",
        error?.modelFailure?.kind === "rate_limit"
          ? "模型服务当前繁忙，本次等待已结束。请稍后重试。"
          : error?.modelFailure?.kind === "quota_exhausted"
            ? "模型服务配额不足，请检查模型服务配置或额度后重试。"
            : error?.proposalFailure
              ? "这次未能生成有效的执行方案，自动纠正后仍未通过校验，尚未开始执行。请重试。"
              : "这条消息未能处理成功，请重试。",
        { kind: "reception-error", inputId: turn.id },
      );
      this.r.events.append(
        "reception.blocked",
        null,
        {
          inputId: turn.id,
          error: String(error),
          ...(error.proposalFailure ? { proposalFailure: error.proposalFailure } : {}),
          ...(error.commandFailure ? { commandFailure: error.commandFailure } : {}),
        },
        this.now(),
      );
    });
  }
  requestContext(turn) {
    const context = this.context(turn);
    return {
      original: {
        inputId: turn.id,
        conversationId: turn.conversation_id,
        text: turn.text,
      },
      messages: context.messages,
      workingContext: context.workingContext,
    };
  }
  acceptReport(report, work) {
    const destinations = this.history.destinations(work.id);
    if (!destinations.length) return false;
    const conversationId = this.history.require(
      this.reports.request(work)?.original?.conversationId ?? destinations[0],
    );
    if (!destinations.includes(conversationId)) throw new Error("Report destination changed");
    const id = `wake_${digest(report.id).slice(0, 40)}`;
    const existing = this.r.reception.get(id);
    if (existing) {
      if (!existing.source_json || JSON.parse(existing.source_json).reportId !== report.id)
        throw new Error("Report turn identity collision");
      return true;
    }
    this.works.assertCurrent(work);
    const origin = workOrigin(work);
    const assessment = this.completion.assess(work, report.text);
    const lastMessage = this.history.view({ conversationId }).messages.at(-1);
    this.r.reception.add({
      id,
      conversationId,
      workId: work.id,
      text: `Execution report for ${work.id} revision ${work.revision}`,
      at: this.now(),
      queryScope: this.scope.reportGrant(id, conversationId, work),
      source: {
        kind: "execution-report",
        goalId: this.goals.forWork(work.id),
        reportId: report.id,
        executionId: report.execution_id,
        routine: work.routine_id
          ? {
              id: work.routine_id,
              revision: work.routine_revision,
              stopWhen: origin.stopWhen ?? null,
            }
          : null,
        workId: work.id,
        revision: work.revision,
        origin,
        waitingForResult: origin.kind === "direct",
        assessment,
        platformReadEvidence: this.completion.platformReadEvidence(report.execution_id),
        confirmedInputs: this.interactions.confirmedInputs(work),
        directives: this.reports.directives(work),
        request: this.reports.request(work),
        historyAnchor: lastMessage?.id ?? null,
      },
    });
    return true;
  }
  reportSource(turn) {
    const source = JSON.parse(turn.source_json);
    const report = this.reports.get({
      id: source.workId,
      revision: source.revision,
      active_execution_id: source.executionId,
    });
    if (
      source.kind !== "execution-report" ||
      !report ||
      report.id !== source.reportId ||
      report.execution_id !== source.executionId ||
      !this.history.require(turn.conversation_id) ||
      !this.history.destinations(source.workId).includes(turn.conversation_id)
    )
      throw new Error("Report source is outside this assistant or conversation");
    return { source, report, work: this.works.require(source.workId).record };
  }
  retireStale(turn) {
    const { source, work } = this.reportSource(turn);
    let stale =
      work.revision !== source.revision ||
      work.active_execution_id !== source.executionId ||
      ["cancelled", "completed", "awaiting_delivery"].includes(work.status);
    if (!stale) {
      try {
        this.works.assertCurrent(work);
      } catch {
        stale = true;
      }
    }
    if (!stale) return false;
    this.uow.transaction(() => this.r.reception.settled(turn.id, { kind: "retired" }, null, source.workId));
    return true;
  }
  applyReport(turn, raw, queries) {
    return this.uow.transaction(() => {
      const current = this.turn(turn.id);
      if (current.status === "settled") return current;
      if (this.retireStale(current)) return this.turn(turn.id);
      if (this.goals.reasons(this.works.require(current.work_id).record).length)
        throw new Error("Goal paused or dependency no longer valid");
      const proposal = ContinuationDecision.parse(raw);
      const { source, report, work } = this.reportSource(current);
      const request = this.reports.request(work);
      const childId = `continuation:${digest(turn.id)}`;
      if (proposal.kind === "continue") {
        if ((request?.continuations ?? 0) >= ContinuationDecision.maxContinuations)
          throw new Error("Automatic continuation limit reached; user direction is required");
        this.works.continue(
          childId,
          {
            workId: work.id,
            expectedRevision: work.revision,
            expectedExecutionId: source.executionId,
            text: proposal.goal,
          },
          {
            ...request,
            continuations: (request?.continuations ?? 0) + 1,
            previousReport: {
              reportId: report.id,
              text: report.text.slice(0, 6000),
              truncated: report.text.length > 6000,
              error: report.error,
            },
          },
        );
      } else if (proposal.kind === "deliver" || proposal.kind === "silent") {
        if (proposal.kind === "silent" && source.waitingForResult)
          throw new Error("A user-awaited result cannot be silently discarded");
        if (proposal.kind === "silent" && (report.status === "error" || !source.assessment.passed)) {
          this.works.blocked(work, "Background report did not satisfy the completion contract");
        } else {
          if (report.status !== "returned" || !source.assessment.passed)
            throw new Error("Execution report has not satisfied the completion contract");
          if (proposal.finishRoutine) this.routines.finishWatch(work);
          const receipt = this.outcomes.record(work, report.text, {
            deliveryText: proposal.text,
            userMessage: proposal.message,
            suppressNotification: proposal.kind === "silent",
          });
          if (!receipt.accepted) throw new Error("Result was not accepted");
          if (proposal.goalPlan) {
            this.goals.assertMember(proposal.goalPlan.goalId, work.id);
            this.goals.extend(childId + ":plan", proposal.goalPlan);
          }
          if (proposal.goalReview) {
            this.goals.assertMember(proposal.goalReview.goalId, work.id);
            this.goals.review(childId + ":review", proposal.goalReview);
          }
        }
      } else {
        if (!source.waitingForResult) throw new Error("Quiet blockers require silence or continued work");
        this.works.blocked(work, "Main assistant reported a blocker");
        this.history.append(turn.conversation_id, `${turn.id}:blocked`, "assistant", proposal.text, {
          kind: "continuation-blocked",
          workId: work.id,
          revision: work.revision,
        });
      }
      this.r.reception.settled(turn.id, { ...proposal, queries }, proposal.text ?? null, source.workId);
      this.r.events.append(
        "reception.report-settled",
        source.workId,
        { turnId: turn.id, reportId: report.id, kind: proposal.kind },
        this.now(),
      );
      return this.turn(turn.id);
    });
  }
  turn(id) {
    const value = this.r.reception.get(requireText(id, "inputId", 160));
    if (!value) throw new Error("Unknown reception input");
    return value;
  }
}
