import { readFileSync } from "node:fs";

export async function workScenario({
  say,
  call,
  check,
  wait,
  pending,
  done,
  restart,
  executionSessions,
  evidence,
  mode,
}) {
  const work = await say(
    "整理项目资料，先问我需要哪个时间范围，必须用 ask_user 等我回答后再读取 project.md，发布包含来源、已确认进展和待跟进项的笔记。",
    "project",
  );
  check("delegatedWorkCreated", !!work.work_id);
  const q = await pending(work.work_id);
  await wait(async () => (await call("status")).active === 0);
  check("waitingReleasesSlot", executionSessions() === 0);
  await restart();
  check(
    "questionSurvivesRestart",
    (await call("interaction.list")).some(
      (i) => i.id === q.id && i.state === "pending",
    ),
  );
  const answer = await say("回答：只整理本周", "answer");
  check("answerTargetsOriginalWork", answer.work_id === work.work_id);
  const result = await done(work.work_id);
  check(
    "sameExecutionResumed",
    result.work.revision === 1 && result.executions.length === 1,
  );
  check(
    "oneAcceptedDelivery",
    result.deliveries.length === 1 &&
      result.deliveries[0].status === "accepted",
  );
  const usage = await call("usage", { workId: work.work_id });
  check(
    "executionLimitsAndUsageVisible",
    usage.executions.some((e) => e.control?.steps > 0) &&
      usage.items.some((i) => i.source === "pi.usage") &&
      usage.totalsByMode.some((g) => g.mode === mode),
  );
  evidence.projectUsage = usage;
  const notes = result.completion.executions
    .flatMap((e) => e.evidence)
    .filter((e) => e.kind === "note.published")
    .map((e) => readFileSync(e.data.path, "utf8"));
  check(
    "artifactContainsSourceAndConfirmedFact",
    notes.some((s) => s.includes("project.md") && s.includes("导入接口")),
  );
  const stopped = await say(
    "整理另一个问题，先问我范围，必须用 ask_user 等我回答。",
    "cancel-work",
  );
  await pending(stopped.work_id);
  await say(`取消 ${stopped.work_id}`, "cancel");
  check(
    "cancelledWorkStaysStopped",
    (await call("work", { workId: stopped.work_id })).work.status ===
      "cancelled",
  );
  const revised = await say(
    "整理项目资料，先问我范围，必须用 ask_user 等我回答。",
    "amend-work",
  );
  await pending(revised.work_id);
  await say(
    `改成整理 project.md 中本周已确认进展，标注来源，直接发布笔记，无需再提问。工作 ID：${revised.work_id}`,
    "amend",
  );
  check(
    "amendPreservesWorkIdentity",
    (await done(revised.work_id)).work.revision === 2,
  );
  const history = await call("conversation");
  check(
    "resultReturnsToOriginalConversation",
    history.messages.some(
      (m) => m.data.kind === "result" && m.data.workId === work.work_id,
    ),
  );
  check(
    "backgroundReportReviewedByMainAssistant",
    (await call("events")).some(
      (e) =>
        e.kind === "reception.report-settled" && e.work_id === work.work_id,
    ),
  );
}
