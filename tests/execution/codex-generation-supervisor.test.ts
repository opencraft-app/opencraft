import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SystemdGenerationSupervisor, type GenerationProcessIdentity, type GenerationSupervisor } from "../../apps/codex-core/src/generation-supervisor.js";
import { coldHomeValidator } from "../../apps/codex-core/src/generation-cold-home.js";
import type { GenerationRecord } from "../../apps/codex-core/src/generation-registry.js";

test("retirement detects a shell spawned by a Native worker thread", { skip: process.platform !== "linux" }, async () => {
  const source = `const {Worker}=require('node:worker_threads'); new Worker(\`const {spawn}=require('node:child_process'); const p=spawn('/bin/sh',['-c','sleep 120']); require('node:worker_threads').parentPort.postMessage(p.pid);\`,{eval:true}).on('message',pid=>console.log(JSON.stringify({pid})));`;
  const native = spawn(process.execPath, ["-e", source], { detached: true, stdio: ["ignore", "pipe", "inherit"] }); let shell = 0;
  try {
    shell = await new Promise<number>((resolve, reject) => { native.stdout.once("data", data => resolve(JSON.parse(String(data)).pid)); native.once("error", reject); });
    const mainChildren = (await readFile(`/proc/${native.pid}/task/${native.pid}/children`, "utf8")).trim(); assert.equal(mainChildren, "", "fixture shell belongs to worker thread");
    const supervisor = new SystemdGenerationSupervisor({ registryDirectory: "/synthetic", coreEndpoint: "/synthetic/control.sock", dataDirectory: "/synthetic", tokenFile: "/synthetic/token", token: "synthetic", scope: "system" });
    assert.equal(await supervisor.processesQuiet({ nativePid: native.pid! } as GenerationProcessIdentity), false);
  } finally { const exited = new Promise(resolve => native.once("exit", resolve)); try { process.kill(-native.pid!, "SIGKILL"); } catch {} await exited; }
});

test("restart cleans the persisted validation owner before retrying a cold HOME and retains receipts on cleanup failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-cold-recover-")), sockets = await mkdtemp(join(tmpdir(), "v-"));
  const old: GenerationRecord = { id: "old", state: "retired", incarnation: 1, runtimeDataDirectory: join(root, "old"), endpoint: join(root, "old/control.sock"), executable: "/fixed/codex", bundle: "/fixed/app.cjs", node: process.execPath, cwd: root };
  const validationId = "validation-12345678-1234-4234-8234-123456789abc", receipt = join(root, "old.pending.json"); let fail = true; const stopped: string[] = [];
  const supervisor = { async discardUnready(g: GenerationRecord) { assert.equal(g.state, "candidate"); assert.equal(g.runtimeDataDirectory, old.runtimeDataDirectory); if (fail) throw new Error("unit still active"); stopped.push(g.id); } } as GenerationSupervisor;
  try {
    await mkdir(old.runtimeDataDirectory); await writeFile(receipt, JSON.stringify({ version: 1, validationId, runtimeDataDirectory: old.runtimeDataDirectory, socketDirectory: sockets }));
    const validator = coldHomeValidator({ directory: root, supervisor });
    await assert.rejects(validator.recover([old]), /still active/); assert.ok(await readFile(receipt, "utf8"));
    fail = false; await validator.recover([old]); assert.deepEqual(stopped, [validationId]);
    await assert.rejects(readFile(receipt), { code: "ENOENT" }); await validator.recover([old]); assert.equal(stopped.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); await rm(sockets, { recursive: true, force: true }); }
});


test("failed systemd stop and unreadable unit state cannot be mistaken for a stopped validation owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-unit-query-")), originalPath = process.env.PATH;
  const script = join(root, "systemctl"), supervisor = new SystemdGenerationSupervisor({ registryDirectory: root, coreEndpoint: join(root, "core.sock"), dataDirectory: root, tokenFile: join(root, "token"), token: "synthetic", scope: "system" });
  const generation = { id: "validation", state: "candidate", incarnation: 0 } as GenerationRecord;
  try {
    await writeFile(script, '#!/bin/sh\nexit 1\n'); await chmod(script, 0o755); process.env.PATH = root;
    await assert.rejects(supervisor.discardUnready(generation));
    await writeFile(script, '#!/bin/sh\nif [ "$1" = show ]; then printf "MainPID=0\\nLoadState=not-found\\nActiveState=inactive\\n"; exit 0; fi\nexit 1\n');
    await supervisor.discardUnready(generation);
  } finally { process.env.PATH = originalPath; await rm(root, { recursive: true, force: true }); }
});
