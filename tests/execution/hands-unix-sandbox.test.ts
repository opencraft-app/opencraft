import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxPool } from "../../packages/sandbox/src/index.js";
import { handsUnixSandboxBackend, startHandsExecutionOwner } from "../../packages/sandbox-node/src/hands-unix.js";

test("Hands Unix owner runs only the pinned Codex exec-server and fences its lease", async t => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-hands-unix-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), endpoint = join(root, "owner.sock"), tokenFile = join(root, "owner.token"), executable = join(root, "codex");
  await mkdir(workspace); await writeFile(executable, "#!/bin/sh\nwhile IFS= read -r line; do printf 'hands:%s\\n' \"$line\"; done\n"); await chmod(executable, 0o755);
  const resources = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 };
  const owner = await startHandsExecutionOwner({ endpoint, tokenFile, executable, workspace, resources }); t.after(() => owner.close());
  const pool = await createSandboxPool({ id: "hands-test", capacity: resources }, await handsUnixSandboxBackend({ endpoint, tokenFile })); t.after(() => pool.close());
  const sandbox = await pool.createSandbox({ owner: "turn:generation-7", resources });
  const output: Buffer[] = [];
  const child = await sandbox.spawn({ command: [executable, "exec-server", "--listen", "stdio"], cwd: workspace, env: { PATH: "/usr/bin:/bin" } }, event => output.push(Buffer.from(event.data)));
  await child.writeStdin(Buffer.from("hello\n")); await child.closeStdin();
  assert.deepEqual(await child.exited, { code: 0 }); assert.equal(Buffer.concat(output).toString(), "hands:hello\n");
  await sandbox.close();
});

test("Hands Unix owner rejects an arbitrary command", async t => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-hands-reject-")); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), endpoint = join(root, "owner.sock"), tokenFile = join(root, "owner.token"), executable = join(root, "codex");
  await mkdir(workspace); await writeFile(executable, "#!/bin/sh\nexit 0\n"); await chmod(executable, 0o755);
  const resources = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 };
  const owner = await startHandsExecutionOwner({ endpoint, tokenFile, executable, workspace, resources }); t.after(() => owner.close());
  const pool = await createSandboxPool({ id: "hands-reject", capacity: resources }, await handsUnixSandboxBackend({ endpoint, tokenFile })); t.after(() => pool.close().catch(() => undefined));
  const sandbox = await pool.createSandbox({ owner: "turn:generation-8" });
  await assert.rejects(sandbox.spawn({ command: [executable, "not-exec-server"], cwd: workspace, env: {} }), /transport failed|could not start/i);
  await assert.rejects(sandbox.close(), /cleanup is unconfirmed/i);
});
