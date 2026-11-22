import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  patchDshGitExecution,
  bashGitEdit,
  bashGitEnvironmentEdit,
  terminalGitEdit,
  terminalGitEnvironmentEdit,
} from "../../scripts/postinstall/patch-dsh-git-execution.mjs";
import { registerDshExecutionEnvironment } from "../../apps/local-agent-host/src/dsh-execution-environment.mjs";
import { dshGitRuntime, dshGitContext } from "../support/dsh-git-runtime.mjs";

test("Git SDK patch is exact, idempotent, and validates both modules before writing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-git-patch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bash = join(root, "node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js");
  const terminal = join(root, "node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js");
  for (const path of [bash, terminal]) await mkdir(join(path, ".."), { recursive: true });
  const original = bashGitEdit[0] + bashGitEnvironmentEdit[0];
  await writeFile(bash, original);
  await writeFile(terminal, "// SDK drift");
  await assert.rejects(patchDshGitExecution(root), /boundary changed/);
  assert.equal(await readFile(bash, "utf8"), original);
  await writeFile(terminal, terminalGitEdit[0] + terminalGitEnvironmentEdit[0]);
  await patchDshGitExecution(root);
  const patched = await readFile(bash, "utf8"),
    before = await stat(bash);
  await patchDshGitExecution(root);
  assert.equal(await readFile(bash, "utf8"), patched);
  assert.equal((await stat(bash)).mtimeMs, before.mtimeMs);
});

function nativeContext(prepare) {
  let port;
  const agent = {
    id: "native",
    status: "running",
    session: {
      header: { id: "native" },
      events: [
        { type: "turn/start", data: { turn: 7 } },
        { type: "user/message", data: { source: { rpcId: "original" } } },
        { type: "user/message", data: { source: { rpcId: "later-steer" } } },
      ],
    },
  };
  const agents = new Map([["native", agent]]);
  let logicalId = "public-thread";
  const ctx = {
    agents,
    provide(name, value) {
      assert.equal(name, "opencraftExecutionThread");
      port = value;
    },
    inject() {},
  };
  registerDshExecutionEnvironment(ctx, () => logicalId, undefined, { prepare });
  return {
    agent,
    agents,
    get port() {
      return port;
    },
    move() {
      logicalId = "replacement-thread";
    },
  };
}
const snapshot = { apply() {}, overlay: () => ({ SYNTHETIC_GIT: "sealed" }) };
test("native Turn selects immutable admission, not the latest steer; stale and forged Agents deny", async () => {
  const calls = [];
  const f = nativeContext(async (input) => {
    calls.push(input);
    return snapshot;
  });
  assert.deepEqual(await f.port.prepare({ agent: f.agent }), { SYNTHETIC_GIT: "sealed" });
  assert.deepEqual(calls, [
    { hostId: "opencraft-server", threadId: "public-thread", turnId: "dsh-turn-public-thread-7" },
  ]);
  await assert.rejects(f.port.prepare({ agent: { ...f.agent } }), /unavailable/);
  f.agent.session.events.push({ type: "turn/end", data: { turn: 7 } });
  await assert.rejects(f.port.prepare({ agent: f.agent }), /unavailable/);
  assert.equal(calls.length, 1);
});
test("cancel, native replacement and generation remap while awaiting credentials cannot publish environment", async () => {
  for (const change of ["abort", "turn", "agent", "generation"]) {
    const held = Promise.withResolvers();
    const f = nativeContext(() => held.promise),
      controller = new AbortController();
    const pending = f.port.prepare({ agent: f.agent, signal: controller.signal });
    if (change === "abort") controller.abort();
    if (change === "turn") f.agent.session.events.push({ type: "turn/end" }, { type: "turn/start", data: { turn: 8 } });
    if (change === "agent") f.agents.set("native", { ...f.agent });
    if (change === "generation") f.move();
    held.resolve(snapshot);
    await assert.rejects(pending);
  }
});

test(
  "pinned native foreground/background/PTY boundaries await authorization and start nothing on cancellation",
  { skip: !process.env.OPENCRAFT_DSH_RUNTIME },
  async (t) => {
    const sdk = await dshGitRuntime(t);
    for (const kind of ["foreground", "background", "terminal"]) {
      const held = Promise.withResolvers(),
        f = nativeContext(() => held.promise);
      const root = await mkdtemp(join(tmpdir(), "dsh-git-cancel-"));
      const h = dshGitContext(sdk, root, () => f.port);
      f.agent.ctx = h.ctx;
      const abort = new AbortController();
      // Count actual SDK process allocations, not just a mock tool's output.
      let allocations = 0;
      for (const name of ["spawn", "spawnTerminal"]) {
        const original = h.ctx.subprocess[name];
        h.ctx.subprocess[name] = function (...args) {
          allocations++;
          return original.apply(this, args);
        };
      }
      try {
        const pending =
          kind === "terminal"
            ? new sdk.terminal.BashTerminalBackend(h.ctx, {}).spawn({
                owner: f.agent,
                sessionId: "pty",
                signal: abort.signal,
              })
            : h.tool.execute(
                {
                  command: "echo must-not-run",
                  description: "Synthetic cancellation probe",
                  run_in_background: kind === "background",
                },
                { agent: f.agent, signal: abort.signal },
              );
        await Promise.resolve();
        assert.equal(allocations, 0);
        assert.equal(h.jobs.length, 0);
        abort.abort();
        held.resolve(snapshot);
        await assert.rejects(pending);
        assert.equal(allocations, 0);
        assert.equal(h.jobs.length, 0);
      } finally {
        await h.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
