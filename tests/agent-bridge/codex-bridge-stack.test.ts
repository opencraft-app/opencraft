import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CODEX_BRIDGE_PROGRAMS } from "../../apps/opencraft-daemon/src/codex-bridge-stack.js";

/** Stand-in programs: each announces readiness the way the real one does and then idles. */
const IDLE = 'setInterval(() => {}, 1000); process.on("SIGTERM", () => process.exit(0));';
async function programs(root: string) {
  await writeFile(
    join(root, CODEX_BRIDGE_PROGRAMS.core),
    `process.stdout.write('{"type":"codex-accounts-listening"}\\n'); ${IDLE}`,
  );
  await writeFile(
    join(root, CODEX_BRIDGE_PROGRAMS.appServer),
    `process.stdout.write('{"type":"codex-app-server-ready"}\\n'); ${IDLE}`,
  );
  // Like the real Engine Host, it runs a worker thread, which inherits the preload.
  await writeFile(
    join(root, CODEX_BRIDGE_PROGRAMS.engineHost),
    `import { Worker } from "node:worker_threads"; const worker = new Worker("setInterval(() => {}, 1000)", { eval: true }); worker.unref(); await new Promise((accept) => setTimeout(accept, 300)); process.stdout.write('{"url":"http://127.0.0.1:1/"}\\n'); ${IDLE}`,
  );
  await writeFile(join(root, CODEX_BRIDGE_PROGRAMS.provider), "// provider stand-in\n");
  await writeFile(
    join(root, CODEX_BRIDGE_PROGRAMS.exitWithParent),
    await readFile(resolve("apps/opencraft-daemon/src/codex-bridge-exit-with-parent.cjs")),
  );
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function owner(root: string) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/agent-bridge/fixtures/bridge-stack-owner.ts", root, root],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const line = await new Promise<string>((accept, reject) => {
    createInterface({ input: child.stdout! }).once("line", accept);
    child.once("exit", (code) => reject(new Error(`owner exited ${code}`)));
  });
  return { child, ...(JSON.parse(line) as { children: number[]; url: string }) };
}

test(
  "bridge stack children stop by themselves when the daemon is killed",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "oc-stack-life-"));
    try {
      await programs(root);
      const first = await owner(root);
      assert.equal(first.children.length, 3);
      assert.ok(first.children.every(alive));
      const config = JSON.parse(await readFile(join(root, "state/engine-host.json"), "utf8"));
      assert.equal(config.cutoverCodex, true);
      assert.equal(config.generations[0].id, config.activate);
      first.child.kill("SIGKILL");
      for (let attempt = 0; attempt < 100 && first.children.some(alive); attempt++) await delay(50);
      assert.deepEqual(first.children.filter(alive), [], "no child outlives a killed daemon");

      // A graceful stop removes its record; the next start begins clean.
      const second = await owner(root);
      second.child.kill("SIGTERM");
      await new Promise((accept) => second.child.once("exit", accept));
      assert.deepEqual(second.children.filter(alive), []);
      await assert.rejects(readFile(join(root, "state/children.json")), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
