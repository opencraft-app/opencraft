import assert from "node:assert/strict";
import test from "node:test";
import { summarizeHookRuns, formatHookSource, formatHookEventName } from "../../packages/chat-core/src/hook-stats";

const run = (extra: Record<string, unknown> = {}) => ({
  id: "run", eventName: "userPromptSubmit", source: "project", status: "completed", entries: [], ...extra,
});

test("untrusted observations are validated without coercion or input mutation", () => {
  for (const input of [null, {}, [], [null, {}, run({ status: "unknown" })],
    [run({ status: { toString() { throw new Error("must not coerce"); } } })]]) {
    assert.equal(summarizeHookRuns(input), null);
  }
  const input = Object.freeze([Object.freeze(run({ statusMessage: "  done  ",
    entries: Object.freeze([Object.freeze({ kind: "context", text: "private" })]) }))]);
  const stats = summarizeHookRuns(input)!;
  assert.equal(stats.count, 1);
  assert.equal(stats.runs[0].statusMessage, "done");
  assert.deepEqual(stats.runs[0].entries, []);
});

test("execution status and displayed output have separate counts and visibility", () => {
  const stats = summarizeHookRuns([
    run({ status: "blocked", entries: [
      { kind: "context", text: "private context" }, { kind: "warning", text: "Warning" },
      { kind: "feedback", text: "  Add tests.  " }, { kind: "invalid", text: "hidden" },
    ] }),
    run({ id: "failed", eventName: "postToolUse", status: "failed", entries: [{ kind: "error", text: "Process failed." }] }),
    run({ id: "feedback", eventName: "stop", entries: [{ kind: "feedback", text: "  Note.  " }, { kind: "feedback", text: " " }] }),
  ])!;
  assert.equal(stats.count, 3);
  assert.equal(stats.blockedCount, 1);
  assert.equal(stats.errorCount, 1);
  assert.deepEqual(stats.blockedSources, ["project"]);
  assert.deepEqual(stats.blockedMessages, ["Add tests."]);
  assert.deepEqual(stats.feedbackMessages, [{ source: "project", text: "Note." }]);
  assert.deepEqual(stats.entries, [
    { kind: "feedback", text: "  Add tests.  " }, { kind: "error", text: "Process failed." },
    { kind: "feedback", text: "  Note.  " }, { kind: "feedback", text: " " },
  ]);
  assert.deepEqual(stats.runs[0].entries, [
    { tone: "warning", text: "Warning" }, { tone: "error", text: "  Add tests.  " },
  ]);
});

test("only adjacent identical displays coalesce and first observation identity survives", () => {
  const stats = summarizeHookRuns([
    { id: "observation-one", run: run({ status: "running", entries: [{ kind: "context", text: "one" }] }) },
    { id: "observation-two", run: run({ status: "failed", entries: [{ kind: "context", text: "two" }] }) },
    run({ eventName: "stop" }), run(),
  ])!;
  assert.equal(stats.count, 4);
  assert.equal(stats.errorCount, 1);
  assert.deepEqual(stats.runs.map(item => [item.id, item.count]), [["observation-one", 2], ["run", 1], ["run", 1]]);
  for (const extra of [{ source: "user" }, { statusMessage: "changed" },
    { entries: [{ kind: "warning", text: "visible" }] }]) {
    assert.equal(summarizeHookRuns([run(), run(extra)])?.runs.length, 2);
  }
});

test("blocked prompt delivery retains sources even when feedback is empty", () => {
  const stats = summarizeHookRuns([run({ status: "blocked" }), run({ eventName: "stop", status: "blocked" })])!;
  assert.equal(stats.blockedCount, 2);
  assert.deepEqual(stats.blockedSources, ["project"]);
  assert.deepEqual(stats.blockedMessages, []);
});

test("source and event labels preserve protocol compatibility and unknown values", () => {
  for (const source of ["mdm", "cloudRequirements", "cloudManagedConfig", "legacyManagedConfigFile", "legacyManagedConfigMdm"]) {
    const stats = summarizeHookRuns([run({ source })])!;
    assert.equal(stats.runs[0].source, source, "preserve the protocol source");
    assert.equal(formatHookSource(stats.runs[0].source), "Admin", source);
  }
  for (const [source, expected] of [["system", "Admin"], ["sessionFlags", "Session"],
    ["project", "Project"], ["plugin", "Plugin"], ["user", "User"], ["admin", "Unknown"]]) {
    assert.equal(formatHookSource(source), expected);
  }
  assert.equal(formatHookEventName("userPromptSubmit"), "UserPromptSubmit");
  assert.equal(formatHookEventName("interrupt"), "Interrupt");
  assert.equal(formatHookEventName("futureEvent"), "futureEvent");
});

test("only stop-event feedback enters general delivery, other hook feedback stays in display stats", () => {
  for (const eventName of ["userPromptSubmit", "preToolUse", "postToolUse", "sessionStart", "futureEvent"]) {
    const stats = summarizeHookRuns([run({ eventName, entries: [{ kind: "feedback", text: "note" }] })])!;
    assert.deepEqual(stats.feedbackMessages, []);
    assert.deepEqual(stats.entries, [{ kind: "feedback", text: "note" }]);
  }
});
