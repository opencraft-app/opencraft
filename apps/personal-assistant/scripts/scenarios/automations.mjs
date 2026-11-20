export async function automationsScenario({
  say,
  call,
  check,
  wait,
  done,
  evidence,
}) {
  const routine = await call(
    "routine.add",
    {
      text: "整理 project.md 中项目进展，标注来源并发布笔记。",
      intervalMs: 60000,
      startAt: Date.now() + 100,
      maxRuns: 1,
    },
    "routine",
  );
  const occurrence = await wait(async () =>
    (await call("status")).works.find(
      (w) => w.routine_id === routine.routineId,
    ),
  );
  await done(occurrence.id);
  check("finiteRoutineProducesResult", true);
  await say("每隔3600秒提醒我检查项目", "natural-interval");
  check(
    "explicitIntervalCreatesRoutine",
    (await call("status")).routines.some((r) => r.interval_ms === 3600000),
  );

  await call(
    "trigger.add",
    {
      eventType: "project.review",
      goal: "整理 project.md 的已确认进展，标注来源并发布笔记。",
      notify: "always",
    },
    "review-rule",
  );
  const event = await call(
    "event.emit",
    { eventType: "project.review", data: { project: "青松" } },
    "review-event",
  );
  check("localEventCreatesOneWork", event.workIds.length === 1);
  await done(event.workIds[0]);
  await wait(async () =>
    (await call("conversation")).messages.some(
      (m) =>
        m.data.kind === "notification" &&
        m.data.workIds.includes(event.workIds[0]),
    ),
  );
  check("backgroundNotificationReturnsToConversation", true);
  const replay = await call(
    "event.emit",
    { eventType: "project.review", data: { project: "青松" } },
    "review-event",
  );
  check(
    "duplicateEventKeepsOriginalWork",
    replay.workIds[0] === event.workIds[0],
  );
  evidence.automation = {
    event,
    replay,
    eventInput: "explicit local protocol; not natural-language rule authoring",
  };
}
