import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { TurnActivityKeepAwake, createPlatformSleepInhibitor } from "../../apps/opencraft-daemon/src/keep-awake.js";
import { DesktopPowerSaveCoordinator } from "../../apps/desktop/src/power-save-coordinator.js";

function manualClock() {
  let current = 1_000;
  let nextId = 0;
  const timers = new Map<number, { dueAt: number; callback: () => void }>();
  return {
    now: () => current,
    setTimer(callback: () => void, delayMs: number) {
      const id = ++nextId;
      timers.set(id, { dueAt: current + delayMs, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(handle: ReturnType<typeof setTimeout>) {
      timers.delete(handle as unknown as number);
    },
    advance(ms: number) {
      current += ms;
      for (;;) {
        const ready = [...timers.entries()]
          .filter(([, entry]) => entry.dueAt <= current)
          .sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
        if (!ready) break;
        timers.delete(ready[0]);
        ready[1].callback();
      }
    },
    get timerCount() {
      return timers.size;
    },
  };
}

test("TurnActivityKeepAwake holds one sleep lock across concurrent turns, coalesces grace windows, and yields on approval/silence", () => {
  const clock = manualClock();
  let acquired = 0;
  let released = 0;
  const keepAwake = new TurnActivityKeepAwake({
    inhibitor: {
      acquire() {
        acquired++;
        let done = false;
        return () => {
          if (!done) {
            done = true;
            released++;
          }
        };
      },
    },
    graceMs: 60_000,
    maxSilenceMs: 300_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  keepAwake.observeFrame(
    "local-codex",
    JSON.stringify({ method: "turn/started", params: { threadId: "t-1", turn: { id: "u-1" } } }),
  );
  keepAwake.observeFrame(
    "local",
    JSON.stringify({ method: "turn/started", params: { threadId: "t-2", turn: { id: "u-2" } } }),
  );
  assert.equal(keepAwake.activeCount, 2);
  assert.equal(keepAwake.isBlocking, true);
  assert.equal(acquired, 1);
  assert.equal(released, 0);

  // Completing one turn keeps blocking while another turn is still running.
  keepAwake.observeFrame(
    "local-codex",
    JSON.stringify({ method: "turn/completed", params: { threadId: "t-1", turn: { id: "u-1", status: "completed" } } }),
  );
  assert.equal(keepAwake.activeCount, 1);
  assert.equal(keepAwake.isBlocking, true);

  // Completing the last turn enters the 60s grace window; a queued turn starting within 60s reuses the same lock.
  keepAwake.observeFrame(
    "local",
    JSON.stringify({ method: "turn/completed", params: { threadId: "t-2", turn: { id: "u-2", status: "completed" } } }),
  );
  assert.equal(keepAwake.activeCount, 0);
  assert.equal(keepAwake.isBlocking, true);
  clock.advance(30_000);
  assert.equal(keepAwake.isBlocking, true);
  keepAwake.observeFrame(
    "local-codex",
    JSON.stringify({ method: "turn/started", params: { threadId: "t-1", turn: { id: "u-3" } } }),
  );
  assert.equal(acquired, 1, "queued follow-up turn reuses the active sleep assertion without churn");

  // Waiting solely on human approval releases active status and expires after grace window.
  keepAwake.observeFrame(
    "local-codex",
    JSON.stringify({
      method: "thread/status/changed",
      params: { threadId: "t-1", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
    }),
  );
  assert.equal(keepAwake.activeCount, 0);
  clock.advance(60_000);
  assert.equal(keepAwake.isBlocking, false);
  assert.equal(released, 1);

  // Silence watchdog yields an unattended stalled turn and re-acquires when streaming resumes.
  keepAwake.observeFrame(
    "local-codex",
    JSON.stringify({ method: "turn/started", params: { threadId: "t-stalled", turn: { id: "u-4" } } }),
  );
  assert.equal(acquired, 2);
  assert.equal(keepAwake.isBlocking, true);
  clock.advance(300_000);
  assert.equal(keepAwake.isBlocking, false);
  assert.equal(released, 2);

  keepAwake.observeFrame(
    "local-codex",
    JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "t-stalled", delta: "resumed" } }),
  );
  assert.equal(keepAwake.isBlocking, true);
  assert.equal(acquired, 3);

  keepAwake.close();
  assert.equal(keepAwake.isBlocking, false);
  assert.equal(released, 3);
  assert.equal(clock.timerCount, 0);
});

test("createPlatformSleepInhibitor spawns caffeinate -i -w <pid> on darwin and terminates on release", () => {
  const spawned: Array<{ file: string; args: readonly string[]; killed: string[] }> = [];
  const inhibitor = createPlatformSleepInhibitor({
    platform: "darwin",
    env: { OPENCRAFT_KEEP_AWAKE: "1" },
    pid: 42424,
    spawnProcess: ((file: string, args: readonly string[]) => {
      const proc = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        killed: false,
        unref() {},
        kill(signal: string) {
          record.killed.push(signal);
          this.killed = true;
          return true;
        },
      });
      const record = { file, args, killed: [] as string[] };
      spawned.push(record);
      return proc as any;
    }) as any,
  });

  const release = inhibitor.acquire();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.file, "/usr/bin/caffeinate");
  assert.deepEqual(spawned[0]!.args, ["-i", "-w", "42424"]);
  release();
  release();
  assert.deepEqual(spawned[0]!.killed, ["SIGTERM"]);
});

test("DesktopPowerSaveCoordinator scopes Electron powerSaveBlocker to local daemon hosts and cleans up on bridge/host loss", () => {
  const clock = manualClock();
  const activeIds = new Set<number>();
  let seq = 0;
  const coordinator = new DesktopPowerSaveCoordinator(
    {
      start() {
        const id = ++seq;
        activeIds.add(id);
        return id;
      },
      stop(id) {
        activeIds.delete(id);
      },
    },
    {
      graceMs: 10_000,
      maxSilenceMs: 120_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
  );

  // Remote SSH/cloud hosts do not block local laptop sleep.
  coordinator.observeDaemonPayload(1, {
    type: "host/frame",
    hostId: "ssh:remote-box",
    generation: 1,
    frame: JSON.stringify({ method: "turn/started", params: { threadId: "remote-t", turn: { id: "r1" } } }),
  });
  assert.equal(coordinator.isBlocking, false);

  // Local Codex turn starts powerSaveBlocker.
  coordinator.observeDaemonPayload(1, {
    type: "host/frame",
    hostId: "local-codex",
    generation: 1,
    frame: JSON.stringify({ method: "turn/started", params: { threadId: "local-t", turn: { id: "l1" } } }),
  });
  assert.equal(coordinator.isBlocking, true);
  assert.deepEqual([...activeIds], [1]);

  // Host failure releases the scope and stops powerSaveBlocker after grace window.
  coordinator.observeDaemonPayload(1, {
    type: "host/status",
    hostId: "local-codex",
    generation: 1,
    status: { state: "failed" },
  });
  assert.equal(coordinator.activeCount, 0);
  clock.advance(10_000);
  assert.equal(coordinator.isBlocking, false);
  assert.equal(activeIds.size, 0);

  // Explicit close immediately stops active blocker without waiting for grace window.
  coordinator.observeDaemonPayload(2, {
    type: "host/frame",
    hostId: "local",
    generation: 1,
    frame: JSON.stringify({ method: "turn/started", params: { threadId: "dsh-t", turn: { id: "d1" } } }),
  });
  assert.equal(coordinator.isBlocking, true);
  coordinator.close();
  assert.equal(coordinator.isBlocking, false);
  assert.equal(activeIds.size, 0);
});
