import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChaosViolation, shrinkChaosFailure } from "./fixtures/recovery-chaos";
import {
  generateWebSocketRecoveryChaos,
  parseWebSocketRecoveryTrace,
  simulateWebSocketRecovery,
  type WebSocketRecoveryEvent,
} from "./fixtures/websocket-recovery-chaos";

test("WebSocket chaos: transparent resume preserves ordered output and input custody across two tabs", async () => {
  const result = await simulateWebSocketRecovery([
    { type: "output", tab: "a" },
    { type: "input", tab: "b" },
    { type: "offline", tab: "a", enabled: true },
    { type: "input", tab: "a" },
    { type: "output", tab: "a" },
    { type: "tick", ms: 500 },
    { type: "offline", tab: "a", enabled: false },
    { type: "heal" },
    { type: "late", tab: "a" },
    { type: "input", tab: "b" },
  ]);
  assert.ok(result.coverage["server:resume-accepted"]! >= 1);
  assert.equal(result.coverage["native:initialize"], 2, "resume must not create a new native generation");
  assert.equal(result.inputs.admitted, 3);
  assert.deepEqual(result.outputs.a.slice(0, 2), [1, 2], "output produced while detached must replay exactly once");
});

test("WebSocket chaos: unknown session immediately falls back and initializes a fresh lease", async () => {
  const result = await simulateWebSocketRecovery([
    { type: "offline", tab: "a", enabled: true },
    { type: "forget", tab: "a" },
    { type: "input", tab: "a" },
    { type: "tick", ms: 500 },
    { type: "offline", tab: "a", enabled: false },
    { type: "heal" },
  ]);
  assert.ok(result.coverage["server:resume-rejected"]! >= 1);
  assert.ok(result.coverage["native:initialize"]! > 2);
  assert.ok(result.diagnostics.some((d) => d.reason === "unknown-session"));
});

test("WebSocket chaos: half-open route is detected, and hiding/foregrounding cannot strand recovery", async () => {
  const result = await simulateWebSocketRecovery([
    { type: "blackhole", tab: "a", enabled: true },
    { type: "visible", tab: "a", value: false },
    { type: "tick", ms: 31_000 },
    { type: "visible", tab: "a", value: true },
    { type: "tick", ms: 31_000 },
    { type: "heal" },
  ]);
  assert.ok(result.wires > 2, "stale open route must be replaced");
});

test("WebSocket chaos: lost resume replies expire, late replies cannot poison the successor", async () => {
  const result = await simulateWebSocketRecovery([
    { type: "hold", tab: "a", boundary: "resumed", enabled: true },
    { type: "cut", tab: "a" },
    { type: "tick", ms: 31_000 },
    { type: "heal" },
    { type: "late", tab: "a" },
  ]);
  assert.ok(result.coverage["held:resumed"]! > 0);
  assert.ok(result.coverage["late-frame"]! > 0);
});

test("WebSocket chaos: held native initialization does not retain a cancelled generation forever", async () => {
  const result = await simulateWebSocketRecovery([
    { type: "offline", tab: "a", enabled: true },
    { type: "forget", tab: "a" },
    { type: "hold", tab: "a", boundary: "initialize", enabled: true },
    { type: "offline", tab: "a", enabled: false },
    { type: "tick", ms: 31_000 },
    { type: "heal" },
    { type: "late", tab: "a" },
  ]);
  assert.ok(result.coverage["held:initialize"]! > 0);
});

test("WebSocket chaos: an open socket without ready times out and a later handshake can recover", async () => {
  const result = await simulateWebSocketRecovery([
    { type: "offline", tab: "a", enabled: true },
    { type: "forget", tab: "a" },
    { type: "hold", tab: "a", boundary: "ready", enabled: true },
    { type: "offline", tab: "a", enabled: false },
    { type: "tick", ms: 31_000 },
    { type: "heal" },
    { type: "late", tab: "a" },
  ]);
  assert.ok(result.coverage["held:ready"]! > 0);
  assert.ok(result.coverage["client:handshake-timeout"]! > 0);
});

test("WebSocket chaos: lost input answer stays unconfirmed instead of blindly replaying the write", async () => {
  const result = await simulateWebSocketRecovery([
    { type: "hold", tab: "a", boundary: "answer", enabled: true },
    { type: "input", tab: "a" },
    { type: "offline", tab: "a", enabled: true },
    { type: "forget", tab: "a" },
    { type: "tick", ms: 31_000 },
    { type: "heal" },
    { type: "late", tab: "a" },
  ]);
  assert.equal(result.inputs.applied, 1);
  assert.equal(result.coverage["native:input"], 1);
  assert.equal(result.inputs.retained, 1, "ambiguous outcome must retain durable custody");
});

for (const seed of [0, 1, 2, 7, 19, 42, 88, 512, 1024, 20261116]) {
  test(`WebSocket chaos: reproducible fault schedule seed ${seed}`, async () => {
    await simulateWebSocketRecovery(generateWebSocketRecoveryChaos(seed, 40));
  });
}

test("WebSocket chaos: trace schema and seed zero are deterministic", () => {
  const events = generateWebSocketRecoveryChaos(0);
  assert.deepEqual(events, generateWebSocketRecoveryChaos(0));
  assert.deepEqual(events, parseWebSocketRecoveryTrace(JSON.parse(JSON.stringify(events))));
  for (const trace of [
    [{ type: "tick", ms: -1 }],
    [{ type: "tick", ms: 120_001 }],
    [{ type: "cut", tab: "c" }],
    [{ type: "hold", tab: "a", boundary: "foo", enabled: true }],
    [{ type: "offline", tab: "a", enabled: 1 }],
  ]) {
    assert.throws(() => parseWebSocketRecoveryTrace(trace), /TRACE_SCHEMA/);
  }
});

test("WebSocket chaos: the real wire-admission oracle catches, shrinks and replays duplicate writes", async () => {
  const events: WebSocketRecoveryEvent[] = [
    { type: "output", tab: "b" },
    { type: "input", tab: "a" },
    { type: "tick", ms: 500 },
  ];
  const run = (trace: readonly WebSocketRecoveryEvent[]) =>
    simulateWebSocketRecovery(trace, { mutant: "replay-input" });
  await assert.rejects(run(events), (error) => error instanceof ChaosViolation && error.rule === "INPUT_ONCE");
  const minimal = await shrinkChaosFailure(events, "INPUT_ONCE", run, 10);
  assert.deepEqual(minimal, [{ type: "input", tab: "a" }]);
  await assert.rejects(run(minimal), /INPUT_ONCE/);
  await simulateWebSocketRecovery(minimal);
});

test("WebSocket chaos: a falsely ready but unwritable route fails the independent round-trip oracle", async () => {
  await assert.rejects(
    simulateWebSocketRecovery([], { mutant: "stuck-route" }),
    (error) => error instanceof ChaosViolation && error.rule === "ROUTE_USABLE",
  );
});

test("WebSocket chaos CLI: failure artifact contains seed zero, evidence and a replayable minimal trace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "websocket-chaos-cli-"));
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/recovery-chaos.ts", ...args], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      timeout: 15_000,
    });
  try {
    const trace = join(directory, "trace.json"),
      output = join(directory, "failure");
    await writeFile(
      trace,
      JSON.stringify({
        suite: "websocket",
        seed: 0,
        events: [
          { type: "output", tab: "b" },
          { type: "input", tab: "a" },
        ],
      }),
    );
    const first = run(["--replay", trace, "--mutant", "replay-input", "--output", output]);
    assert.equal(first.status, 1, first.stderr);
    const artifact = JSON.parse(await readFile(join(output, "failure-minimal.json"), "utf8"));
    assert.equal(artifact.seed, 0);
    assert.equal(artifact.suite, "websocket");
    assert.equal(artifact.rule, "INPUT_ONCE");
    assert.ok(artifact.evidence.tabs.a);
    assert.ok(artifact.sourceSha256["packages/app-host-resume/src/server.ts"]);
    assert.deepEqual(artifact.events, [{ type: "input", tab: "a" }]);
    const replay = run([
      "--replay",
      join(output, "failure-minimal.json"),
      "--mutant",
      "replay-input",
      "--output",
      join(directory, "replay"),
    ]);
    assert.equal(replay.status, 1, replay.stderr);
    const healthy = run(["--replay", join(output, "failure-minimal.json"), "--output", join(directory, "healthy")]);
    assert.equal(healthy.status, 0, healthy.stderr);
    assert.equal(JSON.parse(await readFile(join(directory, "healthy", "results.json"), "utf8")).seed, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
