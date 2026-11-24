import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Runner, request } from "../src/runner.mjs";
import {
  running,
  profileFor,
  until,
  completed,
  files,
  childRunner,
  nativeEntries,
} from "./helpers.mjs";

test("real Pi Harness executes a tool, persists input, produces result and local delivery", async (t) => {
  const { profile, call } = await running(t);
  await call("memory.set", { key: "city", value: "上海" }, "city");
  const w = await call("submit", { text: "整理本地笔记" }, "note");
  const done = await completed(profile, w.workId);
  assert.equal(done.executions.length, 1);
  assert.equal(done.executions[0].status, "succeeded");
  assert.ok(done.inputs[0].delivered_at);
  assert.equal(done.deliveries[0].status, "accepted");
  assert.match(
    readFileSync(
      join(profile.path, "artifacts", files(profile, "artifacts")[0]),
      "utf8",
    ),
    /上海/,
  );
  assert.equal(files(profile, "mailbox").length, 1);
  assert.equal(
    (await call("submit", { text: "整理本地笔记" }, "note")).duplicate,
    true,
  );
  assert.equal(files(profile, "artifacts").length, 1);
});

test("control requests remain responsive while bounded background work is running", async (t) => {
  const { profile, call } = await running(t, { fixtureDelayMs: 1000, concurrency: 2 });
  const items = await Promise.all(
    [1, 2, 3].map((n) => call("submit", { text: `work ${n}` })),
  );
  const began = Date.now(),
    status = await call("status");
  assert.ok(Date.now() - began < 700);
  assert.ok(status.active <= 2);
  assert.equal(status.works.length, 3);
  assert.ok(status.works.some((w) => w.status !== "completed"));
  for (const w of items) await completed(profile, w.workId);
});

test("amend continues the same work and fences the earlier active revision", async (t) => {
  const { profile, call } = await running(t, { fixtureDelayMs: 250 });
  const w = await call("submit", { text: "original scope" });
  await until(
    async () =>
      (await call("work", { workId: w.workId })).inputs[0].delivered_at,
  );
  const update = await call("amend", {
    workId: w.workId,
    text: "new scope",
    expectedRevision: 1,
  });
  assert.equal(update.workId, w.workId);
  const done = await completed(profile, w.workId);
  assert.equal(done.work.revision, 2);
  assert.equal(done.executions[0].status, "superseded");
  assert.equal(done.results.length, 1);
  assert.match(done.results[0].text, /new scope/);
  assert.equal(files(profile, "mailbox").length, 1);
});

test("cancel stops queued/active work without claiming a result", async (t) => {
  const { call } = await running(t, { fixtureDelayMs: 500 });
  const w = await call("submit", { text: "cancel me" });
  await until(
    async () =>
      (await call("work", { workId: w.workId })).inputs[0].delivered_at,
  );
  await call("cancel", { workId: w.workId });
  await until(async () => (await call("status")).active === 0);
  const stopped = await call("work", { workId: w.workId });
  assert.equal(stopped.work.status, "cancelled");
  assert.deepEqual(stopped.results, []);
});

test("a memory correction prevents a pending action from using an old snapshot", async (t) => {
  const { profile, call } = await running(t, { fixtureDelayMs: 350 });
  await call("memory.set", { key: "city", value: "上海" });
  const w = await call("submit", { text: "use city" });
  await until(
    async () =>
      (await call("work", { workId: w.workId })).inputs[0].delivered_at,
  );
  await call("memory.set", { key: "city", value: "北京" });
  const blocked = await until(async () => {
    const d = await call("work", { workId: w.workId });
    return d.work.status === "blocked" && d;
  });
  assert.match(blocked.work.error, /Memory changed/);
  assert.equal(files(profile, "artifacts").length, 0);
  await call("amend", { workId: w.workId, text: "use the corrected city" });
  await completed(profile, w.workId);
  assert.match(
    readFileSync(
      join(profile.path, "artifacts", files(profile, "artifacts")[0]),
      "utf8",
    ),
    /北京/,
  );
});

test("graceful shutdown suspends the original Pi submission and resumes it on reopen", async (t) => {
  const profile = profileFor(t, { fixtureDelayMs: 500 });
  let runner = await Runner.open(profile);
  t.after(() => runner.close());
  const w = await request(profile, {
    op: "submit",
    id: "resume",
    params: { text: "survive shutdown" },
  });
  await until(
    async () =>
      (await request(profile, { op: "work", params: { workId: w.workId } }))
        .inputs[0].delivered_at,
  );
  await runner.close();
  runner = await Runner.open(profile);
  const done = await completed(profile, w.workId);
  assert.equal(done.executions.length, 1);
  await runner.close();
  const entries = await nativeEntries(profile, w.workId);
  assert.equal(
    entries.filter((e) => e.kind === "superapp.work-input").length,
    1,
  );
});

test("delivery failure is retried after restart without rerunning completed Pi work", async (t) => {
  const profile = profileFor(t);
  const first = await childRunner(t, profile, { LAB_TEST_DELIVERY_FAIL: "1" });
  const w = await request(profile, {
    op: "submit",
    id: "delivery-retry",
    params: { text: "produce once" },
  });
  await until(
    async () =>
      (await request(profile, { op: "work", params: { workId: w.workId } }))
        .deliveries[0]?.attempts > 0,
  );
  const file = join(profile.path, "artifacts", files(profile, "artifacts")[0]),
    mtime = statSync(file).mtimeMs;
  await first.stop();
  const second = await childRunner(t, profile);
  const done = await completed(profile, w.workId);
  assert.equal(done.executions.length, 1);
  assert.equal(statSync(file).mtimeMs, mtime);
  assert.equal(files(profile, "mailbox").length, 1);
  await second.stop();
});

test("a finite routine executes headlessly and does not trigger again on reopen", async (t) => {
  const profile = profileFor(t);
  let runner = await Runner.open(profile);
  t.after(() => runner.close());
  const r = await request(profile, {
    op: "routine.add",
    id: "routine",
    params: {
      text: "check once",
      intervalMs: 250,
      startAt: Date.now(),
      maxRuns: 1,
    },
  });
  const w = await until(
    async () => (await request(profile, { op: "status", params: {} })).works[0],
  );
  await completed(profile, w.id);
  await runner.close();
  runner = await Runner.open(profile);
  await delay(350);
  const status = await request(profile, { op: "status", params: {} });
  assert.equal(status.works.length, 1);
  assert.equal(
    status.routines.find((x) => x.id === r.routineId).status,
    "exhausted",
  );
});

test(
  "a second runner cannot take over the same live profile or remove its socket",
  { timeout: 20000 },
  async (t) => {
    const { profile, call } = await running(t);
    await assert.rejects(Runner.open(profile), /already being held/);
    assert.equal((await call("status")).owner, "local:test-owner");
  },
);

// The profile lock was a proper-lockfile mtime lease: a second runner took over a runner
// whose refresh looked 10s late (a stalled event loop), which then closed itself from a timer.
test(
  "a second runner cannot take over a live profile whose lock looks unrefreshed",
  { timeout: 30000 },
  async (t) => {
    const { profile, call } = await running(t);
    const lock = `${realpathSync(profile.path)}.lock`;
    const expired = new Date(Date.now() - 120_000);
    utimesSync(lock, expired, expired);
    let contender;
    t.after(() => contender?.close());
    await assert.rejects(
      Runner.open(profile).then((runner) => {
        contender = runner;
      }),
      /already being held/,
    );
    assert.equal(statSync(lock).isFile(), true);
    assert.equal((await call("status")).owner, "local:test-owner");
  },
);

test("immediate shutdown during Pi opening leaves recoverable work", async (t) => {
  const profile = profileFor(t);
  let runner = await Runner.open(profile);
  t.after(() => runner.close());
  const w = runner.dispatch({
    op: "submit",
    id: "immediate",
    params: { text: "resume after immediate stop" },
  });
  await runner.close();
  runner = await Runner.open(profile);
  const done = await completed(profile, w.workId);
  assert.equal(done.executions.length, 1);
});

test("unknown commands and conflicting retries do not mutate accepted work", async (t) => {
  const { call } = await running(t);
  await assert.rejects(call("unknown", {}), /Unknown operation/);
  const w = await call("submit", { text: "preserve this" }, "stable");
  await assert.rejects(
    call("submit", { text: "replace this" }, "stable"),
    /different payload/,
  );
  assert.equal(
    (await call("work", { workId: w.workId })).work.text,
    "preserve this",
  );
});

test(
  "SIGKILL after an artifact effect replays safely and retains one native input",
  { timeout: 35000 },
  async (t) => {
    const profile = profileFor(t);
    const first = await childRunner(t, profile, {
      LAB_TEST_TOOL_PAUSE_MS: "60000",
    });
    const w = await request(profile, {
      op: "submit",
      id: "hard-crash",
      params: { text: "survive hard crash" },
    });
    await until(() => files(profile, "artifacts").length === 1);
    const file = join(
        profile.path,
        "artifacts",
        files(profile, "artifacts")[0],
      ),
      mtime = statSync(file).mtimeMs;
    const exit = await first.stop("SIGKILL");
    assert.equal(exit.signal, "SIGKILL");
    const second = await childRunner(t, profile);
    const done = await completed(profile, w.workId);
    assert.equal(done.executions.length, 1);
    assert.equal(files(profile, "artifacts").length, 1);
    assert.equal(statSync(file).mtimeMs, mtime);
    const events = await request(profile, { op: "events", params: {} });
    assert.ok(events.some((e) => e.kind === "artifact.saved" && e.data.reused));
    await second.stop();
    const entries = await nativeEntries(profile, w.workId);
    assert.equal(
      entries.filter((e) => e.kind === "superapp.work-input").length,
      1,
    );
  },
);

for (const point of [
  "pi-admitted-before-binding",
  "result-saved-before-delivery",
  "mailbox-written-before-receipt",
]) {
  test(`recovers crash window: ${point}`, { timeout: 35000 }, async (t) => {
    const profile = profileFor(t);
    const first = await childRunner(t, profile, { LAB_TEST_CRASH_AT: point });
    const w = await request(profile, {
      op: "submit",
      id: "window",
      params: { text: `window ${point}` },
    });
    const exit = await first.exited;
    assert.equal(exit.code, 86, first.stderr());
    const second = await childRunner(t, profile);
    await completed(profile, w.workId);
    const duplicate = await request(profile, {
      op: "submit",
      id: "window",
      params: { text: `window ${point}` },
    });
    assert.equal(duplicate.workId, w.workId);
    assert.equal(duplicate.duplicate, true);
    assert.equal(files(profile, "mailbox").length, 1);
    assert.equal(files(profile, "artifacts").length, 1);
    await second.stop();
    const entries = await nativeEntries(profile, w.workId);
    assert.equal(
      entries.filter((e) => e.kind === "superapp.work-input").length,
      1,
    );
  });
}
