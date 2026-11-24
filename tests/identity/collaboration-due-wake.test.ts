import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergedOwnerWake, type OwnerWake } from "@opencraft/owner-wake";
import { ActorStore } from "../../packages/access-control/src/actors";
import {
  Collaboration,
  type ConversationExecutionPort,
  type ExecutionReceipt,
} from "../../packages/access-control/src/collaboration";
import { communicationCommand } from "../../packages/access-control/src/communication-command";
import { OrchestrationRuntimeWorker } from "../../packages/access-control/src/orchestration-runtime-store";
import {
  ThreadOrchestrationBroker,
  type OrchestrationExecutionPort,
  type OrchestrationRuntimeSnapshot,
} from "../../packages/access-control/src/thread-orchestration-broker";
import {
  ProjectAutomations,
  AUTOMATION_RUN_CHECK_MS,
  type AutomationExecution,
} from "../../packages/access-control/src/automation-runtime";
import {
  nextAutomationOccurrence,
  automationOccurrence,
  parseAutomationSchedule,
} from "../../packages/access-control/src/automation";
import { openActorAdmission } from "../../packages/access-control/src/actor-admission";
import { openServerDatabase } from "../../packages/storage-node/src/server/index";
import { parsePrincipal } from "../../packages/identity-core/src/index";
import {
  fakeAlarm,
  fakeMonotonicOwnerWake,
  fakeOwnerWake,
  fakeWakeClock,
  flush,
  HOUR,
  MINUTE,
} from "../support/fake-wake-clock.ts";

/** An owner wake-up over a fake monotonic clock that counts the wake-ups it delivers. */
function countingWake(fake: ReturnType<typeof fakeWakeClock>, base: OwnerWake = fakeMonotonicOwnerWake(fake)) {
  const state = { wakes: 0 };
  const wake: OwnerWake = {
    now: base.now,
    timer: (callback) =>
      base.timer(() => {
        state.wakes++;
        callback();
      }),
  };
  return { wake, state };
}
/** Lets queued work, including storage Worker round trips, run while fake time stands still. */
async function realTurns(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
/** Lets `ms` pass in `step` slices, letting the owner's asynchronous passes settle in between. */
async function elapse(fake: ReturnType<typeof fakeWakeClock>, ms: number, step = 50) {
  for (let passed = 0; passed < ms; passed += step) {
    fake.elapse(Math.min(step, ms - passed));
    await realTurns(2);
  }
}

/** Advances fake time by `step` (0: none) between real turns until `condition` holds, or gives up after a bound. */
async function until(fake: ReturnType<typeof fakeWakeClock>, condition: () => boolean, step = 0) {
  for (let i = 0; i < 200 && !condition(); i++) {
    fake.elapse(step);
    await realTurns(1);
  }
}

async function collaborationFixture(t: any, fake: ReturnType<typeof fakeWakeClock>) {
  const root = await mkdtemp(join(tmpdir(), "collaboration-due-wake-"));
  const actors = new ActorStore(join(root, "actors.sqlite"));
  const principal = parsePrincipal({
    provider: "local",
    subject: "person-1",
    displayName: "person",
    expiresAt: Date.now() + HOUR,
  })!;
  const human = actors.resolveHuman(principal)!;
  const a = actors.createSession("A", human.actorId),
    b = actors.createSession("B", human.actorId);
  const ca = actors.issueCredential(a.id, Date.now() + HOUR, human.actorId);
  const aContext = actors.authenticateSession(ca.token)!;
  const receipts = new Map<string, ExecutionReceipt>();
  const adds: string[] = [];
  let reads = 0,
    hold: Promise<void> | null = null;
  const execution: ConversationExecutionPort = {
    hostId: "fixture-host",
    async validate() {},
    async receipt(_binding, id) {
      reads++;
      if (hold) await hold;
      return receipts.get(id) ?? null;
    },
    async add(_binding, id) {
      adds.push(id);
      const row = { id: "queue:" + id, state: "queued" as const, targetTurnId: null };
      receipts.set(id, row);
      return row;
    },
    async steer() {},
    async cancel() {
      return false;
    },
  };
  const service = new Collaboration(join(root, "collaboration.sqlite"), actors, execution, () => fake.now);
  for (const action of ["message.send", "execution.queue"]) actors.setGrant(a.id, b.id, action, true, "operator");
  await service.bind(b.id, "thread-B", 0, () => {});
  // Open the storage companion now, so timer passes below settle within a few real turns.
  await service.pump();
  t.after(async () => {
    await service.close();
    actors.close();
    await rm(root, { recursive: true, force: true });
  });
  let key = 0;
  return {
    service,
    receipts,
    adds,
    aContext,
    b,
    get reads() {
      return reads;
    },
    resetReads() {
      reads = 0;
    },
    holdReceipts() {
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = () => {
          hold = null;
          resolve();
        };
      });
      return release;
    },
    send() {
      return service.send(aContext, {
        targetActorId: b.id,
        content: "work",
        idempotencyKey: "k" + ++key,
        execution: { mode: "queue" },
      });
    },
  };
}

test("collaboration pump: one pass after start, then no wake-up while no request is open", async (t) => {
  const fake = fakeWakeClock(Date.now());
  const { wake, state } = countingWake(fake);
  const f = await collaborationFixture(t, fake);
  f.service.start(wake);
  assert.equal(fake.pending, 1, "the first pass is armed one period after start, as the 500 ms interval was");
  await elapse(fake, 500);
  assert.equal(state.wakes, 1);
  assert.equal(fake.pending, 0, "no open request: nothing armed (the interval ran every 500 ms regardless)");
  await elapse(fake, HOUR, MINUTE);
  assert.equal(state.wakes, 1);
});

test("collaboration pump: a new request is handed off at once; an unchanged receipt wakes only at its backoff", async (t) => {
  const fake = fakeWakeClock(Date.now());
  const { wake, state } = countingWake(fake);
  const f = await collaborationFixture(t, fake);
  f.service.start(wake);
  await elapse(fake, 500);
  const sent = f.send();
  await until(fake, () => f.adds.length === 1);
  assert.deepEqual(
    f.adds,
    [sent.requestId],
    "creating a request makes the next pass due at once, without waiting for a period",
  );
  f.resetReads();
  state.wakes = 0;
  await elapse(fake, 10_000);
  assert.ok(f.reads >= 8 && f.reads <= 12, `unchanged queued receipt read ${f.reads} times in 10 s (as before)`);
  assert.equal(state.wakes, f.reads, "every wake-up read a due receipt; none was idle");
  await elapse(fake, 30_000, 100);
  f.resetReads();
  state.wakes = 0;
  await elapse(fake, 20_000, 100);
  assert.ok(f.reads >= 3 && f.reads <= 5, `capped at one per 5 s, read ${f.reads} in 20 s`);
  assert.equal(state.wakes, f.reads);
  f.receipts.set(sent.requestId!, { id: "queue:" + sent.requestId, state: "delivered", targetTurnId: "turn-1" });
  await elapse(fake, 5_000, 100);
  assert.equal(fake.pending, 0, "a settled request leaves nothing to wake for");
});

test("collaboration pump: a request created while a pass reads its receipts is not lost", async (t) => {
  const fake = fakeWakeClock(Date.now());
  const { wake } = countingWake(fake);
  const f = await collaborationFixture(t, fake);
  f.service.start(wake);
  await elapse(fake, 500);
  const first = f.send();
  await until(fake, () => f.adds.length === 1);
  assert.deepEqual(f.adds, [first.requestId]);
  // The next timer pass blocks reading the first receipt; it already read its rows.
  const release = f.holdReceipts();
  const readsBefore = f.reads;
  await until(fake, () => f.reads > readsBefore, 50);
  await realTurns();
  assert.equal(fake.pending, 0, "nothing is armed while a pass runs; it re-arms when it settles");
  const second = f.send();
  await flush();
  assert.deepEqual(f.adds, [first.requestId], "the running pass cannot see the second request");
  // The first request settles in that pass, so the pass alone would leave nothing due.
  f.receipts.set(first.requestId!, { id: "queue:" + first.requestId, state: "delivered", targetTurnId: "turn-1" });
  release();
  await until(fake, () => f.adds.length === 2);
  assert.deepEqual(
    f.adds,
    [first.requestId, second.requestId],
    "the signal made the next pass due as soon as the running one settled",
  );
  // An explicit pump that coalesces into a running pass also leaves the next pass due at once.
  const release2 = f.holdReceipts();
  const readsBefore2 = f.reads;
  await until(fake, () => f.reads > readsBefore2, 50);
  const third = f.service.send(f.aContext, {
    targetActorId: f.b.id,
    content: "late",
    idempotencyKey: "late",
    execution: { mode: "queue" },
  });
  void f.service.pump();
  release2();
  await until(fake, () => f.adds.includes(third.requestId!));
  assert.ok(f.adds.includes(third.requestId!));
});

test("collaboration pump: a Worker command that creates a request reports it; close disarms", async (t) => {
  const fake = fakeWakeClock(Date.now());
  const { wake } = countingWake(fake);
  const f = await collaborationFixture(t, fake);
  const database = (f.service as any).database;
  const plain = communicationCommand(f.service, database, {
    context: f.aContext,
    method: "send",
    params: { targetActorId: f.b.id, content: "hello", idempotencyKey: "w1" },
  });
  assert.equal(plain.executionRequested, undefined, "a message without execution creates no request");
  const request = communicationCommand(f.service, database, {
    context: f.aContext,
    method: "send",
    params: { targetActorId: f.b.id, content: "work", idempotencyKey: "w2", execution: { mode: "queue" } },
  });
  assert.equal(
    request.executionRequested,
    true,
    "the network instance signals its pump from this flag (managed storage)",
  );
  f.service.start(wake);
  await f.service.close();
  assert.equal(fake.pending, 0, "closing disarms");
  await elapse(fake, 2_000);
  assert.deepEqual(f.adds, []);
});

test("collaboration pump shares a single alarm with other owner work", async (t) => {
  const fake = fakeWakeClock(Date.now());
  const alarm = fakeAlarm(fake);
  const merged = mergedOwnerWake(alarm.wake);
  const f = await collaborationFixture(t, fake);
  f.service.start(merged);
  assert.equal(alarm.state.armed, fake.now + 500, "the first pass one period after start");
  const sent = f.send();
  assert.equal(alarm.state.armed, fake.now, "a new request arms the alarm for now");
  alarm.fire();
  await until(fake, () => f.adds.length === 1 && alarm.state.armed !== null);
  assert.deepEqual(f.adds, [sent.requestId]);
  assert.equal(alarm.state.armed, fake.now + 500, "the queued receipt is next read at its backoff");
  f.receipts.set(sent.requestId!, { id: "queue:" + sent.requestId, state: "delivered", targetTurnId: "turn-1" });
  const reads = f.reads;
  fake.jump(500);
  alarm.fire();
  await until(fake, () => f.reads > reads);
  await realTurns(6);
  assert.equal(alarm.state.armed, null, "no open request: the alarm is cleared");
});

async function brokerFixture(t: any, fake: ReturnType<typeof fakeWakeClock>) {
  const root = await mkdtemp(join(tmpdir(), "broker-due-wake-")),
    actors = new ActorStore(join(root, "actors.sqlite"));
  const a = actors.resolveHuman(
    parsePrincipal({ provider: "local", subject: "a", displayName: "a", expiresAt: Date.now() + HOUR })!,
  )!;
  const receipts = new Map<string, ExecutionReceipt>(),
    states = new Map<string, OrchestrationRuntimeSnapshot>();
  let creates = 0,
    hold: Promise<void> | null = null;
  const snapshots: string[] = [];
  const native: ConversationExecutionPort = {
    serverId: "server",
    hostId: "local-codex",
    async validate() {},
    async receipt(_b, id) {
      return receipts.get(id) ?? null;
    },
    async add(_b, id) {
      const row = { id: "queue:" + id, state: "queued" as const, targetTurnId: null };
      receipts.set(id, row);
      return row;
    },
    async steer() {},
    async cancel() {
      return false;
    },
  };
  const execution: OrchestrationExecutionPort = {
    async create(_id, _source, _args, admit) {
      if (!admit()) throw Error("revoked");
      const child = { threadId: "child-" + ++creates };
      states.set(child.threadId, { threadId: child.threadId, turnId: null, rootTurnId: null, state: "starting" });
      return child;
    },
    async snapshot(id) {
      snapshots.push(id);
      if (hold) await hold;
      return states.get(id) ?? { threadId: id, turnId: null, rootTurnId: null, state: "active" };
    },
    async acknowledge() {},
  } as OrchestrationExecutionPort;
  const collaboration = new Collaboration(join(root, "collaboration.sqlite"), actors, native, () => fake.now);
  const storage = new OrchestrationRuntimeWorker(join(root, "collaboration.sqlite"));
  await storage.start();
  const broker = new ThreadOrchestrationBroker(collaboration, execution, () => fake.now, storage);
  collaboration.authorizeExecution(a, "parent", "human-input", [{ type: "text", text: "Delegate" }]);
  collaboration.executionStarted("parent", "human-input", "parent-turn");
  t.after(async () => {
    await broker.close();
    await storage.close();
    await collaboration.close();
    actors.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    broker,
    states,
    snapshots,
    holdSnapshots() {
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = () => {
          hold = null;
          resolve();
        };
      });
      return release;
    },
    spawn(key: string) {
      return broker.invoke("parent", "parent-turn", "parent:parent-turn:" + key, "thread_spawn", {
        title: "Child",
        prompt: "Work",
      }) as Promise<any>;
    },
  };
}
/** Waits, while fake time stands still, until `condition` holds or a real-time bound passes. */
async function untilReal(fake: ReturnType<typeof fakeWakeClock>, condition: () => boolean) {
  for (let i = 0; i < 400 && !condition(); i++) {
    fake.elapse(0);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
/** Waits for the broker's asynchronous storage Worker round trips while time stands still. */
async function drain(fake: ReturnType<typeof fakeWakeClock>) {
  for (let i = 0; i < 6; i++) {
    fake.elapse(0);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}
async function elapseBroker(fake: ReturnType<typeof fakeWakeClock>, ms: number, step = 250) {
  for (let passed = 0; passed < ms; passed += step) {
    fake.elapse(Math.min(step, ms - passed));
    await drain(fake);
  }
}

test("orchestration sweep: wakes only for due children; a spawn mid-sweep is read at once; none watched, none armed", async (t) => {
  const fake = fakeWakeClock(Date.now());
  const { wake, state } = countingWake(fake);
  const f = await brokerFixture(t, fake);
  f.broker.start(wake);
  await elapseBroker(fake, 500);
  assert.equal(state.wakes, 1);
  assert.equal(
    fake.pending,
    0,
    "no child, wait or notification: nothing armed (the interval ran every 500 ms regardless)",
  );
  await elapseBroker(fake, 10 * MINUTE, MINUTE);
  assert.equal(state.wakes, 1);
  const child = await f.spawn("one");
  await untilReal(fake, () => f.snapshots.includes(child.threadId));
  assert.ok(f.snapshots.includes(child.threadId), "a spawn makes the next sweep due at once");
  // Paced reads of an unchanged child: 500 ms, backing off to 5 s; every wake-up reads it.
  f.snapshots.length = 0;
  state.wakes = 0;
  await elapseBroker(fake, 30_000);
  const reads = f.snapshots.filter((id) => id === child.threadId).length;
  assert.ok(reads >= 6 && reads <= 16, `unchanged child read ${reads} times in 30 s`);
  assert.ok(state.wakes <= reads + 1, `${state.wakes} wake-ups for ${reads} reads`);
  // A spawn while a sweep reads a child status is seen right after that sweep.
  const release = f.holdSnapshots();
  await elapseBroker(fake, 5_000);
  const second = f.spawn("two");
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const spawned = await second;
  f.snapshots.length = 0;
  await untilReal(fake, () => f.snapshots.includes(spawned.threadId));
  assert.ok(f.snapshots.includes(spawned.threadId), "the signal made the next sweep due at once");
  // Children that finish leave nothing to watch.
  for (const id of [child.threadId, spawned.threadId])
    f.states.set(id, { threadId: id, turnId: "t", rootTurnId: "t", state: "completed" });
  await elapseBroker(fake, 12_000, 500);
  assert.equal(fake.pending, 0, "finished children leave nothing to watch: nothing armed");
  await f.broker.close();
  assert.equal(fake.pending, 0, "closing disarms");
});

test("next automation occurrence follows the launch rules", () => {
  const cron = (expression: string, timezone = "UTC") =>
    parseAutomationSchedule({ kind: "cron", expression, timezone });
  const at = Date.parse("2026-11-10T12:00:30Z");
  assert.equal(nextAutomationOccurrence(cron("* * * * *"), at, at + HOUR), Date.parse("2026-11-10T12:01:00Z"));
  assert.equal(nextAutomationOccurrence(cron("15 12 * * *"), at, at + HOUR), Date.parse("2026-11-10T12:15:00Z"));
  assert.equal(nextAutomationOccurrence(cron("0 0 * * *"), at, at + HOUR), null, "none within the horizon");
  assert.equal(nextAutomationOccurrence({ kind: "once", at: at + 5_000 }, at, at + HOUR), at + 5_000);
  assert.equal(nextAutomationOccurrence({ kind: "once", at: at - 5_000 }, at, at + HOUR), null);
  // The repeated hour of a fall-back fold is skipped exactly as `automationOccurrence` skips it.
  const fold = cron("30 1 * * *", "America/New_York"),
    first = Date.parse("2026-11-01T05:30:00Z");
  assert.equal(nextAutomationOccurrence(fold, first - MINUTE, first + 3 * HOUR), first);
  assert.equal(nextAutomationOccurrence(fold, first, first + 3 * HOUR), null);
  assert.equal(automationOccurrence(fold, first + HOUR), null);
});

async function automationFixture(
  t: any,
  fake: ReturnType<typeof fakeWakeClock>,
  port: Partial<AutomationExecution> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "automation-due-wake-"));
  const owner = await openServerDatabase(root),
    actors = new ActorStore(owner);
  const context = actors.resolveHuman({
    provider: "local",
    subject: "automation-owner",
    displayName: "Owner",
    expiresAt: Math.max(Date.now(), fake.now) + 86_400_000,
  })!;
  const worker = new OrchestrationRuntimeWorker(join(root, "opencraft-server.sqlite"));
  await worker.start();
  const dispatched: number[] = [];
  const execution: AutomationExecution = {
    async validate() {
      return "permission-snapshot";
    },
    async dispatch() {
      dispatched.push(fake.now);
      return { state: "completed" };
    },
    async inspect() {
      return { state: "running" };
    },
    ...port,
  };
  const service = new ProjectAutomations(worker, execution, () => fake.now);
  t.after(async () => {
    await service.close();
    await worker.close();
    actors.close();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  });
  const caller = { context };
  return {
    service,
    caller,
    dispatched,
    worker,
    async grant() {
      return (await service.grant(
        caller,
        "create",
        {
          serverId: "server",
          projectId: "project",
          target: { kind: "cron", threadId: "thread", environment: "host", prompt: "Say OK" },
          permissionProfile: "read-only",
        },
        "grant-one",
      )) as any;
    },
  };
}
async function waitFor(condition: () => boolean, what: string) {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), what);
}

test("automations: schedules wake at their next occurrence, the run check only while a run is open", async (t) => {
  // Wall time just after 12:00:20; the cron below is due at 12:05.
  const fake = fakeWakeClock(Date.parse("2026-11-10T12:00:20Z"));
  const runs = countingWake(fake),
    schedules = countingWake(fake, fakeOwnerWake(fake));
  let inspect: "running" | "completed" = "running";
  const f = await automationFixture(t, fake, {
    async dispatch() {
      return { state: "running" };
    },
    async inspect() {
      return { state: inspect };
    },
  });
  await f.service.start({ ownerWake: runs.wake, scheduleWake: schedules.wake });
  const grant = await f.grant();
  fake.elapse(AUTOMATION_RUN_CHECK_MS); // The first sweep, one period after start, as before.
  await waitFor(() => runs.state.wakes === 1, "first sweep");
  await drain(fake);
  await f.service.command(
    f.caller,
    "create",
    { grantId: grant.id, schedule: { kind: "cron", expression: "5 12 * * *", timezone: "UTC" } },
    "create-one",
  );
  await drain(fake);
  assert.equal(schedules.state.wakes, 1, "a changed definition is swept at once (it may be due this minute)");
  const sweeps = () => runs.state.wakes + schedules.state.wakes;
  const before = sweeps();
  // Until 12:05 nothing wakes but the bounded wall-clock re-reads, which do not sweep.
  fake.elapse(Date.parse("2026-11-10T12:05:00Z") - fake.now - 1);
  await drain(fake);
  assert.equal(sweeps(), before, "no sweep before the occurrence (the 1 s interval swept ~280 times)");
  fake.elapse(1);
  await waitFor(() => schedules.state.wakes === 2, "occurrence wake-up");
  await drain(fake);
  const runsAt = (await f.service.command(f.caller, "runs", {
    id: ((await f.service.command(f.caller, "list", { projectId: "project" })) as any).items[0].id,
  })) as any;
  assert.equal(runsAt.items.length, 1, "launched at exactly 12:05:00 (formerly within the following second)");
  // The run is running: it is inspected every second until it ends.
  const checks = runs.state.wakes;
  fake.elapse(3 * AUTOMATION_RUN_CHECK_MS);
  await drain(fake);
  fake.elapse(0);
  await drain(fake);
  assert.ok(runs.state.wakes >= checks + 2, "running run inspected every second");
  inspect = "completed";
  // A sweep that starts now settles the run; its end disarms the run check.
  await f.service.tick();
  await drain(fake);
  const settled = runs.state.wakes;
  for (let i = 0; i < 10; i++) {
    fake.elapse(AUTOMATION_RUN_CHECK_MS);
    await drain(fake);
  }
  assert.equal(runs.state.wakes, settled, "no open run: the run check is disarmed");
  await f.service.close();
  assert.equal(fake.pending, 0, "closing disarms both");
});

test("ActorAdmission re-checks issued permits every 500 ms only while one is issued", async () => {
  const fake = fakeWakeClock(Date.now());
  const { wake, state } = countingWake(fake);
  let admits = true;
  const actor = { id: "human:1", kind: "human", enabled: true, generation: 1 };
  const admission = openActorAdmission({
    actors: {
      get: () => actor,
      isCurrent: () => true,
      bindings: () => [],
      onAuthorityChanged: () => () => {},
      findHuman: () => actor,
    } as any,
    membership: { revocationRevision: () => 0, onAuthorityChanged: () => () => {} } as any,
    access: { admitsActor: () => admits },
    ownerWake: wake,
  });
  assert.equal(fake.pending, 0, "no permit: no wake-up (the interval ran every 500 ms regardless)");
  const proof = admission.admitResource(actor.id);
  assert.equal(fake.pending, 1);
  await elapse(fake, 1_000, 500);
  assert.equal(state.wakes, 2, "every 500 ms, as InstanceAccess.watch");
  admits = false;
  await elapse(fake, 500, 500);
  assert.equal(Atomics.load(proof.resourcePermit, 0), 0, "policy change retires the permit within one period");
  assert.equal(fake.pending, 0, "no permit left: disarmed");
  admits = true;
  admission.admitResource(actor.id);
  admission.close();
  assert.equal(fake.pending, 0, "closing disarms");
});
