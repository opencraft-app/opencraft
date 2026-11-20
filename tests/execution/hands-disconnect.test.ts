import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxPool } from "../../packages/sandbox/src/index.js";
import { handsUnixSandboxBackend, startHandsExecutionOwner } from "../../packages/sandbox-node/src/hands-unix.js";

test("disconnect ends the executor wait but does not confirm cleanup or accept more input", async t => {
  const root = await mkdtemp(join(tmpdir(), "oc-hands-disconnect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), endpoint = join(root, "owner.sock");
  const tokenFile = join(root, "owner.token"), executable = join(root, "codex");
  await mkdir(workspace);
  await writeFile(executable, "#!/bin/sh\nwhile IFS= read -r line; do printf '%s\\n' \"$line\"; done\n");
  await chmod(executable, 0o755);
  const resources = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 };
  const owner = await startHandsExecutionOwner({ endpoint, tokenFile, executable, workspace, resources });
  t.after(() => owner.close());
  const pool = await createSandboxPool({ id: "disconnect-test", capacity: resources }, await handsUnixSandboxBackend({ endpoint, tokenFile }));
  t.after(() => pool.close().catch(() => undefined));
  const sandbox = await pool.createSandbox({ owner: "old-native" });
  const child = await sandbox.spawn({ command: [executable, "exec-server", "--listen", "stdio"], cwd: workspace, env: {} });
  await owner.close();
  const result = await Promise.race([child.exited, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(Error("old executor wait was not ended")), 1000); timer.unref();
  })]);
  assert.deepEqual(result, { code: null });
  await assert.rejects(child.writeStdin(Buffer.from("must-not-replay\n")), /transport failed/);
  await assert.rejects(sandbox.close(), /cleanup is unconfirmed/);
});
