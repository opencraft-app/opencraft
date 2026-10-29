import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SystemdGenerationSupervisor, type GenerationProcessIdentity, type GenerationSupervisor } from "../../apps/codex-core/src/generation-supervisor.js";
import { coldHomeValidator } from "../../apps/codex-core/src/generation-cold-home.js";
import type { GenerationRecord } from "../../apps/codex-core/src/generation-registry.js";

const temporaryDirectory = realpathSync(tmpdir());

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
  const root = await mkdtemp(join(temporaryDirectory, "oc-cold-recover-")), sockets = await mkdtemp(join(temporaryDirectory, "v-"));
  const old: GenerationRecord = { id: "old", state: "retired", incarnation: 1, runtimeDataDirectory: join(root, "old"), endpoint: join(root, "old/control.sock"), executable: "/fixed/codex", bundle: "/fixed/app.cjs", node: process.execPath, cwd: root };
  const validationId = "validation-12345678-1234-4234-8234-123456789abc", receipt = join(root, "old.pending.json"); let fail = true; const stopped: string[] = [];
  const supervisor = { async discardUnready(g: GenerationRecord) { assert.equal(g.state, "candidate"); assert.equal(g.runtimeDataDirectory, old.runtimeDataDirectory); if (fail) throw new Error("unit still active"); stopped.push(g.id); } } as GenerationSupervisor;
  try {
    await mkdir(old.runtimeDataDirectory); await writeFile(receipt, JSON.stringify({ version: 1, validationId, runtimeDataDirectory: old.runtimeDataDirectory, socketDirectory: sockets }));
    const validator = coldHomeValidator({ directory: root, socketParentDirectory: temporaryDirectory, supervisor });
    await assert.rejects(validator.recover([old]), /still active/); assert.ok(await readFile(receipt, "utf8"));
    fail = false; await validator.recover([old]); assert.deepEqual(stopped, [validationId]);
    await assert.rejects(readFile(receipt), { code: "ENOENT" }); await validator.recover([old]); assert.equal(stopped.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); await rm(sockets, { recursive: true, force: true }); }
});


test("failed systemd stop and unreadable unit state cannot be mistaken for a stopped validation owner", async () => {
  const root = await mkdtemp(join(temporaryDirectory, "oc-unit-query-")), originalPath = process.env.PATH;
  const script = join(root, "systemctl"), supervisor = new SystemdGenerationSupervisor({ registryDirectory: root, coreEndpoint: join(root, "core.sock"), dataDirectory: root, tokenFile: join(root, "token"), token: "synthetic", scope: "system" });
  const generation = { id: "validation", state: "candidate", incarnation: 0 } as GenerationRecord;
  try {
    await writeFile(script, '#!/bin/sh\nexit 1\n'); await chmod(script, 0o755); process.env.PATH = root;
    await assert.rejects(supervisor.discardUnready(generation));
    await writeFile(script, '#!/bin/sh\nif [ "$1" = show ]; then printf "MainPID=0\\nLoadState=not-found\\nActiveState=inactive\\n"; exit 0; fi\nexit 1\n');
    await supervisor.discardUnready(generation);
  } finally { process.env.PATH = originalPath; await rm(root, { recursive: true, force: true }); }
});

test("packaged Node CLI adoption binds launcher, native child and fixed artifacts without restarting them", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(temporaryDirectory, "oc-cli-launcher-")), originalPath = process.env.PATH;
  const entrypoint = join(root, "cli.cjs"), ownerScript = join(root, "owner.cjs"), wrapper = join(root, "codex"), systemctl = join(root, "systemctl");
  await writeFile(wrapper, "#!/bin/sh\nexit 1\n");
  await writeFile(entrypoint, `const {spawn}=require('node:child_process'); const p=spawn('/bin/sleep',['120'],{stdio:'ignore'}); console.log(JSON.stringify({launcherPid:process.pid,childPid:p.pid})); process.stdin.on('data',()=>{const extra=spawn('/bin/sleep',['120'],{stdio:'ignore'});console.log(JSON.stringify({extraPid:extra.pid}));});`);
  await writeFile(ownerScript, `const {spawn}=require('node:child_process'); const p=spawn(process.execPath,[${JSON.stringify(entrypoint)},'app-server'],{stdio:['pipe','pipe','inherit']});p.stdout.pipe(process.stdout);process.stdin.pipe(p.stdin);`);
  const owner = spawn(process.execPath, [ownerScript, "--codex-executable", wrapper], { detached: true, stdio: ["pipe", "pipe", "inherit"] });
  const lines: any[] = []; let buffer = "";
  owner.stdout.on("data", data => { buffer += String(data); let n; while ((n = buffer.indexOf("\n")) >= 0) { lines.push(JSON.parse(buffer.slice(0,n))); buffer = buffer.slice(n+1); } });
  const wait = async (predicate: () => boolean) => { for (let n=0;n<400&&!predicate();n++) await new Promise(resolve=>setTimeout(resolve,5)); assert.ok(predicate()); };
  try {
    await wait(()=>lines.length>0); const native = lines[0];
    await writeFile(systemctl, `#!/bin/sh\nprintf 'MainPID=${owner.pid}\nLoadState=loaded\nActiveState=active\nUnitFileState=static\n'\n`, { mode: 0o755 });
    process.env.PATH = root;
    const supervisor = new SystemdGenerationSupervisor({ registryDirectory: root, coreEndpoint: join(root,"control.sock"), dataDirectory: root, tokenFile: join(root,"token"), token: "synthetic", scope: "system" });
    const generation = { id:"launcher",state:"active",incarnation:1,externalUnit:"fixture.service",runtimeDataDirectory:root,cwd:root,executable:wrapper,bundle:ownerScript,node:process.execPath,nativeLauncher:{entrypoint,executable:"/bin/sleep"} } as GenerationRecord;
    const health = { pid:owner.pid!,codexPid:native.launcherPid } as any;
    const identity = await supervisor.identify(generation,health);
    assert.equal(identity.nativePid,native.launcherPid);assert.equal(identity.launcher!.childPid,native.childPid);assert.match(identity.cliVersion,/sleep/u);
    assert.deepEqual(await supervisor.identify(generation,health),identity);assert.equal(await supervisor.processesQuiet(identity),true);
    await assert.rejects(supervisor.identify({...generation,nativeLauncher:{entrypoint:ownerScript,executable:"/bin/sleep"}},health),/launcher command/u);
    await assert.rejects(supervisor.identify({...generation,node:"/bin/false"},health),/launcher Node/u);
    await assert.rejects(supervisor.identify({...generation,nativeLauncher:{entrypoint,executable:"/bin/false"}},health),/CLI child/u);
    await assert.rejects(supervisor.identify({...generation,executable:ownerScript},health),/launcher command/u);
    assert.equal(await supervisor.processesQuiet({...identity,launcher:{...identity.launcher!,childStart:"wrong"}}),false);
    owner.stdin.write("extra\n");await wait(()=>lines.length>1);
    await assert.rejects(supervisor.identify(generation,health),/ambiguous/u);assert.equal(await supervisor.processesQuiet(identity),false);
    await writeFile(systemctl, "#!/bin/sh\nprintf 'MainPID=0\\nLoadState=loaded\\nActiveState=inactive\\nUnitFileState=static\\n'\n", { mode: 0o755 });
    await assert.rejects(supervisor.stop(generation,{...identity,nativePid:0,nativeStart:"absent"}),/outlived its unit/u);
    assert.equal(owner.exitCode,null);
  } finally {
    process.env.PATH=originalPath; const exited=new Promise(resolve=>owner.once("exit",resolve));try{process.kill(-owner.pid!,"SIGKILL");}catch{}await exited;await rm(root,{recursive:true,force:true});
  }
});
