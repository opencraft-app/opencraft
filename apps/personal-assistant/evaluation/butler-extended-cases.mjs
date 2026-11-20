/** Evaluator-only expectations. Commands go through the public socket owner. */
export const extendedCases = [
  {
    id: "amend-waiting",
    title: "等待期间换需求，旧回答不得污染新版本",
    inputMode: "natural-language-intent",
    coverage: ["amend", "revision", "late-answer", "restart"],
    review: "实际改的是指定工作；新产物是否遵循替换后的要求。",
  },
  {
    id: "paused-instructions",
    title: "暂停期间追加两条指令，重启后按序交给原执行线程",
    inputMode: "typed-lifecycle-real-execution",
    coverage: ["pause", "ordered-instructions", "restart", "native-continuity"],
    review: "submitted 仅表示已交给执行器；必须另检查新笔记确实采用两条补充。",
  },
  {
    id: "continue-completed",
    title: "已交付工作继续补充，要求版本不变且不重复执行重放请求",
    inputMode: "typed-lifecycle-real-execution",
    coverage: [
      "continuation",
      "idempotency",
      "immutable-evidence",
      "native-continuity",
    ],
    review:
      "续办产物是否保留原上下文并满足补充要求；不把两次合法交付当成重复交付。",
  },
  {
    id: "cancel-goal-isolation",
    title: "取消一个长期目标，不影响另一个目标的待答任务",
    inputMode: "typed-lifecycle-real-execution",
    coverage: ["multi-goal", "cancel", "isolation", "late-answer", "restart"],
    review: "目标取消范围是否准确；另一目标是否实际继续完成。",
  },
  {
    id: "dependency-rebase",
    title: "上游日期更正，已消费旧结果的下游必须显式改版",
    inputMode: "typed-lifecycle-real-execution",
    coverage: [
      "dependency-invalidation",
      "rebase",
      "immutable-snapshot",
      "revision",
    ],
    review: "新流程必须采用新日期；旧输入快照须保留，不能悄悄重写成新证据。",
  },
  {
    id: "batch-target-amend",
    title: "一句话交代两件事，只改其中一件",
    inputMode: "natural-language-intent",
    coverage: ["batch", "target-ownership", "amend", "parallelism"],
    review: "两项委托是否独立且完整；定向修改不得误改另一件事。",
  },
].map((c) => ({ ...c, modelOnly: true }));

const question = (d) => d.interactions.find((q) => q.state === "pending");
const target = (work) => ({ workId: work.id, expectedRevision: work.revision });
const answer = (q, text = "2026年12月18日") => ({
  interactionId: q.id,
  expectedRevision: q.revision,
  text,
});
const goalDefinition = (objective, tasks) => ({
  objective,
  criteria: ["完成计划内的本地笔记，按真实用户回答执行"],
  priority: 1,
  maxParallel: 2,
  tasks,
});
const active = (d) =>
  d.executions.find((e) => e.id === d.work.active_execution_id);
const hasAll = (text, markers) => markers.every((s) => text.includes(s));

export async function runExtendedCase(id, c, { note, pending, done, create }) {
  if (id === "amend-waiting") {
    const a = await create(c, note("TRIP-OLD", true), "TRIP-OLD");
    const before = await pending(c, a.id);
    await c.say(
      "修改本工作的完整要求：不再安排出差，也不再需要日期。改为整理 BOOK-NEW 的本地读书准备笔记，调用 publish_note 写三条准备事项后报告。请替换原工作要求，不要另建工作，也不要等待旧问题。",
      "change",
      a,
    );
    const changed = await c.call("work", { workId: a.id });
    c.check(
      "replacement-retires-obsolete-completion-contract",
      !JSON.stringify(changed.completion.contract).includes("TRIP-OLD"),
      { contract: changed.completion.contract },
    );
    const after = await done(c, a.id);
    c.check(
      "same-work-new-revision",
      after.work.revision === 2 &&
        (await c.call("status")).works.length === 1 &&
        after.work.active_execution_id !== before.work.active_execution_id,
    );
    c.check(
      "old-question-retired",
      after.interactions.find((q) => q.id === question(before).id)?.state ===
        "superseded",
    );
    await c.reject(
      "old-answer-rejected",
      "interaction.answer",
      answer(question(before)),
    );
    await c.reject("stale-change-rejected", "amend", {
      ...target(a),
      text: "stale requirement",
    });
    c.check(
      "current-result-only",
      after.results.length === 1 && after.results[0].revision === 2,
    );
    c.check(
      "replacement-in-artifact",
      (await c.notes()).some((n) => n.text.includes("BOOK-NEW")),
    );
    await c.restart();
    const restored = await c.call("work", { workId: a.id });
    c.check(
      "new-version-survives-restart",
      restored.work.revision === 2 &&
        restored.work.status === "completed" &&
        restored.results.length === 1,
    );
  } else if (id === "paused-instructions") {
    let g = await c.call("goal.create", {
      definition: goalDefinition("准备 PACK 笔记", [
        { key: "pack", text: note("PACK", true), dependsOn: [] },
      ]),
    });
    const a = g.works[0],
      before = await pending(c, a.id);
    g = await c.call("goal.pause", {
      goalId: g.id,
      expectedRevision: g.revision,
    });
    const first = {
      ...target(a),
      text: "补充要求：最终笔记须含原文标记 EXTRA-ONE，说明需要准备雨具。",
    };
    const receipt = await c.call("work.instruct", first, "instruction-one");
    await c.call(
      "work.instruct",
      {
        ...target(a),
        text: "再补充：最终笔记也须含原文标记 EXTRA-TWO，说明需要准备充电器；保留前一条补充。",
      },
      "instruction-two",
    );
    await c.restart();
    c.check(
      "directive-replay-stable",
      (await c.call("work.instruct", first, "instruction-one")).directiveId ===
        receipt.directiveId,
    );
    let current = await c.call("work", { workId: a.id });
    c.check(
      "ordered-instructions-durable",
      current.directives.length === 2 &&
        current.directives.every((d) => d.state === "accepted") &&
        current.directives[0].text.includes("EXTRA-ONE") &&
        current.directives[1].text.includes("EXTRA-TWO"),
    );
    await c.call("interaction.answer", answer(question(before)));
    await c.observe();
    current = await c.call("work", { workId: a.id });
    c.check(
      "paused-no-new-execution-or-result",
      current.executions.length === before.executions.length &&
        current.results.length === 0 &&
        current.directives.every((d) => d.state === "accepted"),
    );
    await c.call("goal.resume", { goalId: g.id, expectedRevision: g.revision });
    current = await done(c, a.id);
    c.check(
      "instructions-admitted-without-requirement-change",
      current.work.revision === 1 &&
        current.directives.every((d) => d.state === "submitted"),
    );
    c.check(
      "native-thread-retained",
      current.executions.length >= 2 &&
        current.executions.every(
          (e) => e.conversation_id === active(before).conversation_id,
        ),
    );
    const directives = JSON.parse(active(current).context_json).directives;
    c.check(
      "successor-keeps-instruction-order",
      directives.length === 2 &&
        directives[0].id === current.directives[0].id &&
        directives[1].id === current.directives[1].id,
    );
    c.check(
      "both-supplements-in-real-artifact",
      (await c.notes()).some((n) =>
        hasAll(n.text, ["PACK", "EXTRA-ONE", "EXTRA-TWO"]),
      ),
    );
    c.check(
      "one-final-result-after-instructions",
      current.results.length === 1 && current.deliveries.length === 1,
    );
  } else if (id === "continue-completed") {
    const r = await c.call("submit", { text: note("BRIEF-BASE") });
    const before = await done(c, r.workId);
    const params = {
      ...target(before.work),
      expectedExecutionId: before.work.active_execution_id,
      text: "继续本工作的补充整理：用 publish_note 发布一份包含 BRIEF-BASE 和 EXTRA-FOLLOWUP 的更新笔记；保留原三条准备事项，再增加一条会后复盘事项。无需提问。",
    };
    const receipt = await c.call("work.continue", params, "continue");
    const after = await done(c, r.workId);
    await c.restart();
    const replay = await c.call("work.continue", params, "continue");
    c.check(
      "continuation-replay-does-not-create-third-execution",
      replay.executionId === receipt.executionId &&
        (await c.call("work", { workId: r.workId })).executions.length === 2,
    );
    c.check(
      "requirements-and-native-thread-retained",
      after.work.revision === before.work.revision &&
        after.work.text === before.work.text &&
        active(after).predecessor_id === active(before).id &&
        active(after).conversation_id === active(before).conversation_id,
    );
    c.check(
      "old-result-immutable",
      JSON.stringify(
        after.results.find((r) => r.id === before.results[0].id),
      ) === JSON.stringify(before.results[0]),
    );
    c.check(
      "one-result-per-authorized-execution",
      after.results.length === 2 &&
        after.deliveries.length === 2 &&
        new Set(after.results.map((r) => r.execution_id)).size === 2,
    );
    c.check(
      "followup-in-artifact",
      (await c.notes()).some((n) =>
        hasAll(n.text, ["BRIEF-BASE", "EXTRA-FOLLOWUP"]),
      ),
    );
    await c.reject(
      "stale-execution-cannot-continue",
      "work.continue",
      params,
      "stale-continue",
    );
  } else if (id === "cancel-goal-isolation") {
    const goals = [];
    for (const marker of ["GOAL-A", "GOAL-B"])
      goals.push(
        await c.call("goal.create", {
          definition: goalDefinition(marker, [
            { key: "confirm", text: note(marker, true), dependsOn: [] },
          ]),
        }),
      );
    const [a, b] = await Promise.all(
      goals.map((g) => pending(c, g.works[0].id)),
    );
    await c.call("goal.cancel", {
      goalId: goals[0].id,
      expectedRevision: goals[0].revision,
    });
    await c.reject(
      "cancelled-goal-answer-rejected",
      "interaction.answer",
      answer(question(a)),
    );
    await c.restart();
    const ga = await c.call("goal.get", { goalId: goals[0].id });
    const gb = await c.call("goal.get", { goalId: goals[1].id });
    c.check(
      "goal-cancel-isolated",
      ga.state === "cancelled" &&
        ga.works.every((w) => w.status === "cancelled") &&
        gb.state === "active" &&
        gb.revision === goals[1].revision,
    );
    c.check(
      "other-goal-question-preserved",
      (await c.call("interaction.list")).some(
        (q) => q.id === question(b).id && q.state === "pending",
      ),
    );
    await c.call("interaction.answer", answer(question(b)));
    const final = await done(c, b.work.id);
    c.check(
      "other-goal-finishes",
      final.results.length === 1 &&
        (await c.call("goal.get", { goalId: gb.id })).readyForReview,
    );
    c.check(
      "cancelled-goal-never-delivered",
      (await c.call("work", { workId: a.work.id })).results.length === 0 &&
        !(await c.notes()).some((n) => n.text.includes("GOAL-A")),
    );
  } else if (id === "dependency-rebase") {
    let g = await c.call("goal.create", {
      definition: goalDefinition("按确认日期编写活动流程", [
        { key: "date", text: note("DATE-SOURCE", true), dependsOn: [] },
        {
          key: "agenda",
          text: "整理 FLOW-RESULT 本地活动流程。先从依赖结果读取活动日期，然后调用 ask_user 问是否发布，必须等我实际确认。确认后 publish_note 发布包含 FLOW-RESULT 和依赖日期的流程，不要猜测日期。",
          dependsOn: ["date"],
        },
      ]),
    });
    const a = g.works.find((w) => w.key === "date"),
      b = g.works.find((w) => w.key === "agenda");
    const first = await pending(c, a.id);
    await c.call("interaction.answer", answer(question(first)));
    await done(c, a.id);
    const downstream = await pending(c, b.id);
    const oldSnapshot = active(downstream).context_json;
    g = await c.call("goal.get", { goalId: g.id });
    g = await c.call("goal.pause", {
      goalId: g.id,
      expectedRevision: g.revision,
    });
    await c.call("amend", {
      ...target(a),
      text: "更新 DATE-SOURCE 本地笔记：活动日期现已明确更正为2026年12月19日（2026-12-19）。无需再提问，publish_note 发布此日期后报告。",
    });
    g = await c.call("goal.resume", {
      goalId: g.id,
      expectedRevision: g.revision,
    });
    const newSource = await done(c, a.id);
    const stale = (await c.call("goal.get", { goalId: g.id })).works.find(
      (w) => w.id === b.id,
    );
    c.check(
      "old-dependency-blocks-consumer",
      stale.waitingOn.length > 0 && !stale.resultId,
    );
    await c.reject("old-dependency-version-rebase-rejected", "goal.rebase", {
      goalId: g.id,
      expectedRevision: g.revision,
      workId: b.id,
      expectedWorkRevision: 1,
      dependencies: [{ workId: a.id, revision: 1 }],
    });
    g = await c.call("goal.rebase", {
      goalId: g.id,
      expectedRevision: g.revision,
      workId: b.id,
      expectedWorkRevision: 1,
      dependencies: [{ workId: a.id, revision: 2 }],
    });
    await c.reject(
      "old-consumer-answer-rejected",
      "interaction.answer",
      answer(question(downstream), "确认发布"),
    );
    const fresh = await pending(c, b.id);
    c.check(
      "old-snapshot-preserved",
      fresh.executions.find((e) => e.id === active(downstream).id)
        .context_json === oldSnapshot,
    );
    const dependency = JSON.parse(active(fresh).context_json)
      .dependencyResults[0];
    c.check(
      "consumer-pins-new-result",
      fresh.work.revision === 2 &&
        dependency.revision === 2 &&
        dependency.resultId ===
          newSource.results.find((r) => r.revision === 2).id,
    );
    await c.call("interaction.answer", answer(question(fresh), "确认发布"));
    await done(c, b.id);
    c.check(
      "new-date-in-consumer-artifact",
      (await c.notes()).some(
        (n) =>
          n.text.includes("FLOW-RESULT") &&
          /2026.{0,3}12.{0,3}19/.test(n.text) &&
          !/2026.{0,3}12.{0,3}18/.test(n.text),
      ),
    );
  } else if (id === "batch-target-amend") {
    await c.say(
      `请同时建立两项独立工作，不需要长期目标。第一项：${note("BATCH-A", true)}第二项：${note("BATCH-B", true)}`,
      "two-works",
    );
    let works = (await c.call("status")).works;
    c.check(
      "one-request-two-distinct-works",
      works.length === 2 && (await c.call("goal.list")).length === 0,
    );
    const a = works.find(
      (w) => w.text.includes("BATCH-A") && !w.text.includes("BATCH-B"),
    );
    const b = works.find(
      (w) => w.text.includes("BATCH-B") && !w.text.includes("BATCH-A"),
    );
    c.check("separate-requirements", !!a && !!b);
    const [da, db] = await Promise.all([pending(c, a.id), pending(c, b.id)]);
    await c.say(
      "只替换当前这项工作的要求：改成 BATCH-REVISED 准备清单，publish_note 发布三条准备事项。取消这项的日期要求，不再提问，不要修改其他工作，不要新增工作。",
      "change-one",
      a,
    );
    const changed = await c.call("work", { workId: a.id });
    c.check(
      "batch-replacement-retires-obsolete-completion-contract",
      !JSON.stringify(changed.completion.contract).includes("BATCH-A"),
      { contract: changed.completion.contract },
    );
    await done(c, a.id);
    const unchanged = await c.call("work", { workId: b.id });
    c.check(
      "other-batch-member-untouched",
      unchanged.work.revision === db.work.revision &&
        unchanged.work.text === db.work.text &&
        unchanged.work.active_execution_id === db.work.active_execution_id &&
        question(unchanged)?.id === question(db).id,
    );
    await c.reject(
      "old-batch-question-rejected",
      "interaction.answer",
      answer(question(da)),
    );
    await c.say(
      "回答本工作：日期为2026年12月18日，继续原要求。",
      "answer-other",
      b,
    );
    await done(c, b.id);
    works = (await c.call("status")).works;
    c.check(
      "both-finish-without-extra-work",
      works.length === 2 &&
        works.every((w) => w.status === "completed") &&
        works.find((w) => w.id === a.id).revision === 2,
    );
    const notes = await c.notes();
    c.check(
      "distinct-artifacts-have-correct-directions",
      notes.some((n) => n.text.includes("BATCH-REVISED")) &&
        notes.some(
          (n) =>
            n.text.includes("BATCH-B") && /2026.{0,3}12.{0,3}18/.test(n.text),
        ),
    );
  } else throw new Error("Unknown scenario");
}
