import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { collectCgroupPids, serviceCgroupRoot } from "../../scripts/server-deployment/owner-cgroup.mjs";
import { collectInventory } from "../../scripts/full-upgrade/inventory.mjs";
import { collectDelegatedOwnerPids, SystemdGenerationSupervisor } from "../../apps/codex-core/src/generation-supervisor.js";
const exec = promisify(execFile);

test("owner membership covers nested tools and refuses incomplete coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-cgroup-"));
  try {
    await writeFile(join(root, "cgroup.procs"), "");
    for (const [path, pid] of [["app", 100], ["tool-a", 200], ["tool-a/child", 300]] as const) {
      await mkdir(join(root, path), { recursive: true }); await writeFile(join(root, path, "cgroup.procs"), `${pid}\n`);
    }
    assert.deepEqual([...collectCgroupPids(root)].sort(), [100, 200, 300]);
    await rm(join(root, "tool-a/child/cgroup.procs")); assert.throws(() => collectCgroupPids(root));
    assert.equal(serviceCgroupRoot("/user.slice/user@1.service/app.slice/owner.service/app"), "/user.slice/user@1.service/app.slice/owner.service");
    assert.throws(() => serviceCgroupRoot("/system.slice/../owner.service/app"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("delegated occupancy, inventory and retirement see orphan tools; owner stop kills them", {
  skip: process.platform !== "linux" || process.env.OPENCRAFT_TEST_DELEGATED_CGROUPS !== "1",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-delegated-live-"));
  const unit = `oc-delegated-test-${process.pid}-${Date.now()}.service`;
  const script = join(root, "owner.mjs"), marker = join(root, "orphan");
  const inspector = new URL("../../scripts/server-deployment/owner-cgroup.mjs", import.meta.url).href;
  await writeFile(script, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; import {inspectOwnerCgroup} from ${JSON.stringify(inspector)}; spawn('/bin/sh',['-c',${JSON.stringify(`sleep 90 & echo $! > '${marker}'`)}],{stdio:'ignore'}); setTimeout(()=>writeFileSync(${JSON.stringify(join(root,"coverage"))},JSON.stringify(inspectOwnerCgroup([]))),300); setInterval(()=>{},1000);`);
  try {
    await exec("systemd-run", ["--quiet", `--unit=${unit}`, "--property=Delegate=yes", "--property=DelegateSubgroup=app", process.execPath, script]);
    let tool = 0;
    for (let n=0; n<200; n++) { try { tool=Number((await readFile(marker,"utf8")).trim()); if(tool) break; } catch {} await new Promise(r=>setTimeout(r,10)); }
    assert.ok(tool > 0);
    const owner = Number((await exec("systemctl", ["show", unit, "-p", "MainPID", "--value"])).stdout.trim());
    const group = (await exec("systemctl", ["show", unit, "-p", "ControlGroup", "--value"])).stdout.trim();
    const cgroup = `/sys/fs/cgroup${group}`;
    await writeFile(`${cgroup}/cgroup.subtree_control`, "+memory +pids"); await mkdir(`${cgroup}/tool-fixture`); await writeFile(`${cgroup}/tool-fixture/cgroup.procs`, String(tool));
    for (let n=0; n<200; n++) { try { await readFile(join(root,"coverage")); break; } catch {} await new Promise(r=>setTimeout(r,10)); }
    const coverage = JSON.parse(await readFile(join(root,"coverage"),"utf8"));
    assert.equal(coverage.coverage,"complete"); assert.ok(coverage.activeCount>=1);
    const inventory = await collectInventory({schemaVersion:1,owners:[{ownerId:"fixture",units:[unit]}]});
    const observed=inventory.owners[0].units[0]; assert.equal(observed.stable,true); assert.ok(observed.processes.some((p:{pid:number})=>p.pid===tool));
    const supervisor=new SystemdGenerationSupervisor({registryDirectory:root,coreEndpoint:"/fixture",dataDirectory:root,tokenFile:"/fixture",token:"fixture",scope:"system"});
    const identity={ownerPid:owner,ownerStart:"fixture",nativePid:owner,nativeStart:"fixture",cliSha256:"fixture",cliVersion:"fixture",unit};
    assert.equal(await supervisor.processesQuiet(identity),false,"an orphan tool still occupies the delegated owner");
    await exec("systemctl",["stop",unit]);
    let state="unknown";
    for(let n=0;n<200;n++) { try {state=(await readFile(`/proc/${tool}/stat`,"utf8")).split(") ")[1]!.split(" ")[0]!;} catch {state="absent";} if(["absent","Z"].includes(state)) break; await new Promise(r=>setTimeout(r,10)); }
    assert.ok(["absent","Z"].includes(state),`owner stop left tool alive: ${state}`);
  } finally { await exec("systemctl",["stop",unit]).catch(()=>undefined); await exec("systemctl",["reset-failed",unit]).catch(()=>undefined); await rm(root,{recursive:true,force:true}); }
});


test("a concurrent adoption cannot certify an empty stable cgroup inventory", async () => {
  for (const existingDestination of [false, true]) {
    let moved = false;
    const children = (path: string) => path === "/owner" ? (existingDestination || moved ? ["a-tool", "app"] : ["app"]) : [];
    const members = (path: string) => {
      if (path === "/owner/app") { moved = true; return ""; }
      return path === "/owner/a-tool" && moved ? "999\n" : "";
    };
    const io = {
      readdirSync: (path: string) => children(path).map(name => ({ name, isDirectory: () => true })),
      readFileSync: (path: string) => members(path.replace(/\/cgroup.procs$/u, "")),
    };
    assert.throws(() => collectCgroupPids("/owner", io), /changed/u,
      "occupancy/inventory must reject a walk that missed a moving orphan");
    moved = false;
    assert.equal(await collectDelegatedOwnerPids("/owner", {
      members: async path => members(path), children: async path => children(path),
    }), null, "retirement must reject the same unstable walk");
  }
});
