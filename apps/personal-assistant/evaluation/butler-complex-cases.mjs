import { basename } from "node:path";
import { createHash } from "node:crypto";

/** Scenarios and grading stay in the evaluator; only user requests reach the bot. */
export const complexCases = [
  [
    "natural-plan-join",
    "自然语言计划、两项待答、汇合后再交接",
    "natural-language-plan-and-answers",
    ["plan-projection", "fan-in", "restart", "answer-routing"],
    "自然语言给出业务约束而非 JSON；不等于完全自主制定目标。检查汇合产物使用两份真实答案。",
  ],
  [
    "interrupt-replan",
    "暂停旧目标、插入急事、修改并恢复原计划",
    "mixed-natural-intent-typed-rebase",
    ["multi-goal", "interrupt", "amend", "pause", "rebase"],
    "急事完成时旧目标仍暂停；恢复必须采用新要求。不评估运行中抢占或自主优先级。",
  ],
  [
    "revision-storm",
    "连续换两次要求、旧回答迟到、重启",
    "natural-language-intent",
    ["multiple-revisions", "late-answer", "immutable-snapshot", "restart"],
    "最后交付与契约只对应最后要求，不接受中间产物冒充最终成功。",
  ],
  [
    "crossed-answers",
    "相似任务反序回答、分别补充、重放和重启",
    "mixed-targeted-answers-typed-instructions",
    ["answer-isolation", "ordered-instructions", "idempotency", "restart"],
    "两份当前交付分别采用自己的日期和补充；检查完整产物而非目录中任意旧文件。",
  ],
  [
    "diamond-rebase",
    "一源两分支、上游更正、分批重做再汇合",
    "typed-lifecycle-real-execution",
    ["transitive-invalidation", "fan-in", "partial-rebase", "restart"],
    "只重做一条分支不能放行最终汇合；旧快照不可改写。",
  ],
  [
    "reopen-review",
    "已验收目标重开、续办、旧验收依据失效",
    "typed-lifecycle-real-execution",
    ["goal-review", "reopen", "continuation", "stale-evidence"],
    "旧结果保留但不能用作新验收；模型复核不冒充用户确认。",
  ],
].map(([id, title, inputMode, coverage, review]) => ({
  id,
  title,
  inputMode,
  coverage,
  review,
  modelOnly: true,
}));

const q = (d) => d.interactions.find((x) => x.state === "pending");
const active = (d) => d.executions.find((e) => e.id === d.work.active_execution_id);
const target = (w) => ({ workId: w.id, expectedRevision: w.revision });
const reply = (question, text) => ({
  interactionId: question.id,
  expectedRevision: question.revision,
  text,
});
const definition = (objective, tasks) => ({
  objective,
  criteria: ["所有本地交付符合最新要求并引用有效依据"],
  priority: 1,
  maxParallel: 2,
  tasks,
});
const task = (key, text, dependsOn = []) => ({ key, text, dependsOn });
const dateNote = (marker) =>
  `整理 ${marker} 本地笔记。调用 ask_user 询问日期并等待我的实际回答，不得猜测。之后 publish_note 发布，包含 ${marker}，并单独一行写 date: YYYY-MM-DD（使用实际回答的日期）。不要执行外部操作。`;
const consumer = (marker, wait = true) =>
  `编写 ${marker} 本地笔记，读取所有依赖结果的当前 date 字段。${wait ? "先 ask_user 询问是否发布，等待我实际确认；" : "无需提问；"}publish_note 发布，包含 ${marker}，并单独一行写 date: YYYY-MM-DD，使用依赖中的当前日期。不要执行外部操作。`;

// Bind grading to the active successful execution's actual host publication receipt.
// A historical or unrelated artifact containing the expected words cannot pass.
export function currentPublishedNote(detail, notes) {
  const id = detail.work.active_execution_id;
  if (!detail.results.some((r) => r.execution_id === id)) throw new Error("No current result for artifact grading");
  const evidence = detail.completion.executions.find((e) => e.executionId === id)?.evidence ?? [];
  const receipt = evidence.find((e) => e.kind === "note.published")?.data;
  const note = receipt && notes.find((n) => n.name === basename(receipt.path));
  if (!note || createHash("sha256").update(note.text).digest("hex") !== receipt.sha256)
    throw new Error("Current published artifact missing or hash mismatch");
  return note.text;
}
// A declared current-value field can coexist with an explanation of obsolete values.
export function fieldEquals(text, field, value) {
  if (!/^[a-z_]+$/.test(field)) throw new Error("Invalid grading field");
  const lines = text.split(/\r?\n/).map((s) => s.replace(/[*`]/g, "").trim());
  const values = lines
    .map((s) => s.match(new RegExp(`^(?:[-+]\\s+)?${field}\\s*[:：]\\s*(.*?)\\s*$`, "i"))?.[1])
    .filter((s) => s !== undefined);
  return values.length === 1 && values[0] === value;
}
const published = async (c, detail) => currentPublishedNote(detail, await c.notes());
const getGoal = (c, g) => c.call("goal.get", { goalId: g.id });
const changeGoal = async (c, g, op) => {
  const current = await getGoal(c, g);
  return c.call(op, { goalId: g.id, expectedRevision: current.revision });
};
const rebase = async (c, g, work, upstream) => {
  const current = await getGoal(c, g);
  const d = await c.call("work", { workId: work.id });
  return c.call("goal.rebase", {
    goalId: g.id,
    expectedRevision: current.revision,
    workId: work.id,
    expectedWorkRevision: d.work.revision,
    dependencies: upstream.map((w) => ({ workId: w.id, revision: w.revision })),
  });
};
const unstarted = (d) => !d.executions.some((e) => e.conversation_id) && !d.results.length;

export async function runComplexCase(id, c, { note, pending, done, create }) {
  if (id === "natural-plan-join") {
    await c.say(
      "把读书会准备组织成一个长期目标，自行转换成计划，不要建成无关联的工作。只有四项本地笔记交付，节点代号分别用 date、audience、runbook、brief。date 先问我日期并等回答；audience 独立问我参与人数并等回答，这两项可以并行。runbook 必须等前两份笔记都完成，汇合日期和人数形成活动流程。brief 必须等 runbook 完成，沿用其日期和人数写一份简明摘要。每份笔记都用 publish_note 发布，已获答案不要再问，不允许外部操作。含日期的笔记单独一行 date: YYYY-MM-DD；含人数的笔记单独一行 audience: 整数。",
      "plan",
    );
    const goals = await c.call("goal.list");
    c.check(
      "one-goal-four-distinct-deliverables",
      goals.length === 1 && goals[0].works.length === 4 && (await c.call("status")).works.length === 4,
    );
    const g = goals[0],
      byKey = Object.fromEntries(g.works.map((w) => [w.key, w]));
    c.check(
      "business-node-identities-preserved",
      ["date", "audience", "runbook", "brief"].every((k) => byKey[k]),
    );
    const [date, audience] = await Promise.all([pending(c, byKey.date.id), pending(c, byKey.audience.id)]);
    c.check(
      "join-and-successor-not-started",
      unstarted(await c.call("work", { workId: byKey.runbook.id })) &&
        unstarted(await c.call("work", { workId: byKey.brief.id })),
    );
    await c.say("回答本工作：参与人数是17人。", "audience-answer", audience.work);
    await done(c, audience.work.id);
    c.check("one-parent-insufficient-for-join", unstarted(await c.call("work", { workId: byKey.runbook.id })));
    await c.restart();
    c.check(
      "other-question-survives-first-answer-and-restart",
      q(await c.call("work", { workId: date.work.id }))?.id === q(date).id,
    );
    await c.say("回答本工作：日期是2027年1月12日。", "date-answer", date.work);
    const dateFinal = await done(c, date.work.id);
    const runbook = await done(c, byKey.runbook.id),
      brief = await done(c, byKey.brief.id);
    const inputs = JSON.parse(active(runbook).context_json).dependencyResults;
    c.check(
      "join-pins-both-real-parent-results",
      inputs.length === 2 &&
        inputs.some((x) => x.resultId === dateFinal.results[0].id) &&
        inputs.some((x) => x.workId === audience.work.id),
    );
    c.check(
      "successor-pins-join-result",
      JSON.parse(active(brief).context_json).dependencyResults.some(
        (x) => x.resultId === runbook.results.find((r) => r.execution_id === active(runbook).id).id,
      ),
    );
    for (const [label, detail] of [
      ["runbook", runbook],
      ["brief", brief],
    ]) {
      const text = await published(c, detail);
      c.check(
        `${label}-uses-both-confirmed-values`,
        fieldEquals(text, "date", "2027-01-12") && fieldEquals(text, "audience", "17"),
      );
    }
    c.check(
      "ready-without-invented-owner-attestation",
      (await getGoal(c, g)).readyForReview && (await getGoal(c, g)).semanticReview.kind !== "owner-attested",
    );
  } else if (id === "interrupt-replan") {
    const g = await c.call("goal.create", {
      definition: definition("周末读书会", [
        task("source", dateNote("WEEKEND")),
        task("flow", consumer("WEEKEND-FLOW", false), ["source"]),
      ]),
    });
    const source = g.works.find((w) => w.key === "source"),
      flow = g.works.find((w) => w.key === "flow");
    const old = await pending(c, source.id);
    await c.say("先暂停整个周末读书会目标，保留所有工作，稍后再恢复。", "pause");
    c.check("natural-language-pauses-goal", (await getGoal(c, g)).state === "paused");
    const urgent = await create(c, note("URGENT-BRIEF"), "URGENT-BRIEF");
    await done(c, urgent.id);
    await c.say(
      "完整替换当前工作要求：WEEKEND 日期已经确定为2027年1月13日，不要再提问，发布本地笔记，单独一行 date: 2027-01-13。继续保持所属目标暂停，稍后才开始执行。",
      "change-source",
      source,
    );
    const changed = await c.call("work", { workId: source.id });
    c.check(
      "amend-keeps-goal-paused-and-urgent-complete",
      changed.work.revision === 2 &&
        changed.results.length === 0 &&
        (await getGoal(c, g)).state === "paused" &&
        (await c.call("work", { workId: urgent.id })).work.status === "completed",
    );
    await c.reject("late-old-date-rejected", "interaction.answer", reply(q(old), "2027-01-11"));
    await c.restart();
    await rebase(c, g, flow, [changed.work]);
    await c.say("恢复周末读书会这个暂停目标，按修改后的要求继续，不要新建目标或工作。", "resume");
    await done(c, source.id);
    const final = await done(c, flow.id);
    c.check("resumed-flow-uses-new-date", fieldEquals(await published(c, final), "date", "2027-01-13"));
    c.check(
      "no-duplicate-goal-or-urgent-work",
      (await c.call("goal.list")).length === 1 &&
        (await c.call("status")).works.length === 3 &&
        (await c.call("work", { workId: urgent.id })).results.length === 1,
    );
  } else if (id === "revision-storm") {
    const w = await create(c, dateNote("TRAVEL-ONE"), "TRAVEL-ONE"),
      first = await pending(c, w.id);
    await c.say(
      "完整替换本工作：不再需要日期。改为 ROOM-TWO 本地场地笔记，先用 ask_user 问我房间名并等待真实回答，再发布包含 ROOM-TWO 与房间名的笔记。取消旧要求和旧验收条件。",
      "second",
      w,
    );
    const second = await pending(c, w.id);
    c.check("second-revision-new-question", second.work.revision === 2 && q(second).id !== q(first).id);
    await c.restart();
    await c.say(
      "再次完整替换本工作：撤销原来的房间提问，改为 BOOK-THREE 阅读准备笔记，无需提问，publish_note 发布三条准备事项。只保留新要求，不另建工作。",
      "third",
      second.work,
    );
    const final = await done(c, w.id);
    for (const [label, d] of [
      ["first", first],
      ["second", second],
    ]) {
      await c.reject(
        `${label}-late-answer-rejected`,
        "interaction.answer",
        reply(q(d), label === "first" ? "2027-01-10" : "北厅"),
      );
      c.check(
        `${label}-snapshot-immutable`,
        final.executions.find((e) => e.id === active(d).id).context_json === active(d).context_json,
      );
    }
    await c.reject("stale-second-amend-rejected", "amend", {
      ...target(second.work),
      text: "过期的 ROOM-TWO 要求",
    });
    const text = await published(c, final),
      checks = final.completion.contract.checks;
    c.check(
      "only-third-contract-and-current-artifact",
      final.work.revision === 3 &&
        final.results.length === 1 &&
        final.deliveries.length === 1 &&
        text.includes("BOOK-THREE") &&
        !checks.some((check) => check.kind === "note_contains" && /ROOM-TWO|TRAVEL-ONE/.test(check.text)),
    );
    await c.restart();
    c.check(
      "final-version-persists-with-no-extra-work",
      (await c.call("work", { workId: w.id })).work.revision === 3 && (await c.call("status")).works.length === 1,
    );
  } else if (id === "crossed-answers") {
    await c.say(
      `创建两项独立工作，不需要长期目标。第一项：${dateNote("TRAINING-ALPHA")}第二项：${dateNote("TRAINING-BETA")}`,
      "pair",
    );
    const works = (await c.call("status")).works;
    c.check("two-unrelated-works-created", works.length === 2 && (await c.call("goal.list")).length === 0);
    const a = works.find((w) => w.text.includes("TRAINING-ALPHA") && !w.text.includes("TRAINING-BETA")),
      b = works.find((w) => w.text.includes("TRAINING-BETA") && !w.text.includes("TRAINING-ALPHA"));
    c.check("pair-requirements-separated", !!a && !!b);
    const [da, db] = await Promise.all([pending(c, a.id), pending(c, b.id)]);
    const instruction = {
      ...target(a),
      text: "追加：最终笔记单独一行 equipment: 雨具。保留实际确认的日期。",
    };
    const receipt = await c.call("work.instruct", instruction, "alpha-extra");
    await c.call(
      "work.instruct",
      {
        ...target(b),
        text: "追加：最终笔记单独一行 equipment: 投影线。保留实际确认的日期。",
      },
      "beta-extra",
    );
    await c.say("回答本工作：日期为2027年2月22日。", "beta-date", b);
    const finalB = await done(c, b.id);
    c.check("beta-answer-does-not-answer-alpha", q(await c.call("work", { workId: a.id }))?.id === q(da).id);
    await c.restart();
    c.check(
      "instruction-replay-is-same-receipt",
      (await c.call("work.instruct", instruction, "alpha-extra")).directiveId === receipt.directiveId,
    );
    await c.reject(
      "conflicting-instruction-replay-rejected",
      "work.instruct",
      { ...instruction, text: "改成另一种设备" },
      "alpha-extra",
    );
    await c.say("回答本工作：日期为2027年2月21日。", "alpha-date", a);
    const finalA = await done(c, a.id);
    for (const [label, d, date, equipment] of [
      ["alpha", finalA, "2027-02-21", "雨具"],
      ["beta", finalB, "2027-02-22", "投影线"],
    ]) {
      const text = await published(c, d);
      c.check(
        `${label}-current-artifact-owns-date-and-supplement`,
        fieldEquals(text, "date", date) && fieldEquals(text, "equipment", equipment),
      );
      c.check(
        `${label}-one-final-delivery`,
        d.results.length === 1 && d.deliveries.length === 1 && d.directives.length === 1,
      );
    }
    c.check("native-threads-separate", active(da).conversation_id !== active(db).conversation_id);
  } else if (id === "diamond-rebase") {
    const g = await c.call("goal.create", {
      definition: definition("活动双分支汇合", [
        task("source", dateNote("DATE-ROOT")),
        task("left", consumer("ROOM-BRANCH"), ["source"]),
        task("right", consumer("STAFF-BRANCH"), ["source"]),
        task("join", consumer("FINAL-JOIN", false), ["left", "right"]),
      ]),
    });
    const by = Object.fromEntries(g.works.map((w) => [w.key, w]));
    const root = await pending(c, by.source.id);
    await c.call("interaction.answer", reply(q(root), "2027年3月8日"));
    await done(c, by.source.id);
    const [left, right] = await Promise.all([pending(c, by.left.id), pending(c, by.right.id)]);
    await changeGoal(c, g, "goal.pause");
    await c.call("amend", {
      ...target(by.source),
      text: "日期已更正。publish_note 发布 DATE-ROOT 本地笔记，单独一行 date: 2027-03-09。无需提问，不执行外部操作。",
    });
    await changeGoal(c, g, "goal.resume");
    const newRoot = await done(c, by.source.id);
    const stale = await getGoal(c, g);
    c.check(
      "both-branches-invalidated-and-join-unstarted",
      [by.left, by.right].every((w) => stale.works.find((x) => x.id === w.id).waitingOn.length > 0) &&
        unstarted(await c.call("work", { workId: by.join.id })),
    );
    await rebase(c, g, by.left, [newRoot.work]);
    const freshLeft = await pending(c, by.left.id);
    await c.reject("old-left-answer-rejected", "interaction.answer", reply(q(left), "确认发布"));
    await c.call("interaction.answer", reply(q(freshLeft), "确认发布"));
    const leftDone = await done(c, by.left.id);
    c.check("one-rebased-branch-cannot-release-join", unstarted(await c.call("work", { workId: by.join.id })));
    await c.restart();
    await rebase(c, g, by.right, [newRoot.work]);
    const freshRight = await pending(c, by.right.id);
    await c.reject("old-right-answer-rejected", "interaction.answer", reply(q(right), "确认发布"));
    await c.call("interaction.answer", reply(q(freshRight), "确认发布"));
    const rightDone = await done(c, by.right.id);
    // Both upstream work revisions changed; the join's declared edges still need explicit rebase.
    c.check("join-requires-explicit-new-edge-versions", unstarted(await c.call("work", { workId: by.join.id })));
    await rebase(c, g, by.join, [leftDone.work, rightDone.work]);
    const final = await done(c, by.join.id);
    for (const [label, old, current] of [
      ["left", left, leftDone],
      ["right", right, rightDone],
    ]) {
      c.check(
        `${label}-old-snapshot-unchanged`,
        current.executions.find((e) => e.id === active(old).id).context_json === active(old).context_json,
      );
      c.check(
        `${label}-new-source-pinned`,
        JSON.parse(active(current).context_json).dependencyResults[0].resultId ===
          newRoot.results.find((r) => r.execution_id === active(newRoot).id).id,
      );
    }
    const inputs = JSON.parse(active(final).context_json).dependencyResults;
    c.check(
      "join-pins-both-new-branch-results",
      inputs.length === 2 &&
        [leftDone, rightDone].every((d) =>
          inputs.some((x) => x.resultId === d.results.find((r) => r.execution_id === active(d).id).id),
        ),
    );
    c.check("final-artifact-uses-new-date", fieldEquals(await published(c, final), "date", "2027-03-09"));
    c.check("all-current-results-ready", (await getGoal(c, g)).readyForReview);
  } else if (id === "reopen-review") {
    let g = await c.call("goal.create", {
      definition: definition("整理培训交付", [task("guide", note("GUIDE")), task("checklist", note("CHECKLIST"))]),
    });
    const a = g.works[0],
      b = g.works[1];
    const [oldA, oldB] = await Promise.all([done(c, a.id), done(c, b.id)]);
    g = await getGoal(c, g);
    const evidence = g.criteria.map((criterion) => ({
      criterionId: criterion.id,
      statement: "本地操作者确认初版两项笔记",
      resultIds: g.works.map((w) => w.resultId),
    }));
    // An optional model review can already close the goal. Explicitly reopen for owner attestation.
    if (g.state === "achieved") g = await changeGoal(c, g, "goal.reopen");
    g = await c.call("goal.confirm", {
      goalId: g.id,
      expectedRevision: g.revision,
      evidence,
    });
    c.check("owner-attestation-explicit", g.semanticReview.kind === "owner-attested");
    const followup = {
      ...target(oldA.work),
      expectedExecutionId: active(oldA).id,
      text: "续办 GUIDE：先 ask_user 问我培训负责人并等待实际回答。保留原三条准备事项，发布更新 GUIDE 笔记并单独一行 owner: 用户实际回答的负责人。",
    };
    await c.reject("closed-goal-rejects-continuation", "work.continue", followup);
    g = await changeGoal(c, g, "goal.reopen");
    c.check("reopen-clears-attestation", g.semanticReview.kind === "unverified");
    const continuation = await c.call("work.continue", followup, "owner-followup");
    const waiting = await pending(c, a.id);
    await c.restart();
    c.check(
      "continuation-replay-stable",
      (await c.call("work.continue", followup, "owner-followup")).executionId === continuation.executionId,
    );
    g = await getGoal(c, g);
    await c.reject("old-review-cannot-complete-waiting-successor", "goal.confirm", {
      goalId: g.id,
      expectedRevision: g.revision,
      evidence,
    });
    await c.call("interaction.answer", reply(q(waiting), "林岚"));
    const final = await done(c, a.id),
      unchanged = await c.call("work", { workId: b.id });
    c.check(
      "sibling-result-and-execution-unchanged",
      JSON.stringify(unchanged.results) === JSON.stringify(oldB.results) &&
        unchanged.work.active_execution_id === oldB.work.active_execution_id,
    );
    c.check(
      "old-result-preserved-with-distinct-successor",
      final.results.length === 2 &&
        JSON.stringify(final.results.find((r) => r.id === oldA.results[0].id)) === JSON.stringify(oldA.results[0]) &&
        active(final).conversation_id === active(oldA).conversation_id,
    );
    c.check("new-owner-in-current-artifact", fieldEquals(await published(c, final), "owner", "林岚"));
    g = await getGoal(c, g);
    c.check("model-cannot-reuse-owner-attestation", g.semanticReview.kind !== "owner-attested");
    if (g.state === "achieved") g = await changeGoal(c, g, "goal.reopen");
    await c.reject("old-result-ids-rejected-even-after-success", "goal.confirm", {
      goalId: g.id,
      expectedRevision: g.revision,
      evidence,
    });
    const finalEvidence = g.criteria.map((criterion) => ({
      criterionId: criterion.id,
      statement: "操作者确认含负责人新版 GUIDE 和未变 CHECKLIST",
      resultIds: g.works.map((w) => w.resultId),
    }));
    g = await c.call("goal.confirm", {
      goalId: g.id,
      expectedRevision: g.revision,
      evidence: finalEvidence,
    });
    c.check(
      "new-explicit-review-binds-current-results",
      g.state === "achieved" && g.semanticReview.kind === "owner-attested",
    );
  } else throw new Error("Unknown complex scenario");
}
