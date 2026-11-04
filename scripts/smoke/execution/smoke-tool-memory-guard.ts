import assert from "node:assert/strict";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { renderToolMemoryGuard } from "../../server-deployment/prepare-tool-memory-guard.mjs";
import { AccountPoolStore, CodexCoreControlClient } from "@opencraft/account-pool-host";

// Explicit opt-in real CLI, synthetic accounts, private HOME and local model only.
let executable = process.env.OPENCRAFT_CODEX_EXECUTABLE;
if (!executable) throw new Error("Set OPENCRAFT_CODEX_EXECUTABLE to the fixed CLI under test");
const root = await mkdtemp(join(process.env.OPENCRAFT_CORE_DRILL_ROOT ?? tmpdir(), "split-drill-"));
await mkdir(join(root, "home"), { mode: 0o700 });
if (process.env.OPENCRAFT_TOOL_MEMORY_FORCE_WRAPPER_IMMUNITY === "1") {
  const original = executable;
  const directory = join(root,"launcher"); await mkdir(directory);
  executable = join(directory,"codex");
  await writeFile(executable, `#!/usr/bin/python3\nimport os,sys,subprocess,pathlib\nreal=${JSON.stringify(original)}\nif 'app-server' not in sys.argv:\n os.execv(real,[real,*sys.argv[1:]])\nhelper=subprocess.Popen(['/bin/sleep','20'])\npathlib.Path('/proc/'+str(helper.pid)+'/oom_score_adj').write_text('0')\npathlib.Path(__file__).with_name('score-zero-pid').write_text(str(helper.pid))\nchild=subprocess.Popen([real,*sys.argv[1:]])\npathlib.Path('/proc/'+str(child.pid)+'/oom_score_adj').write_text('-1000')\nsys.exit(child.wait())\n`, {mode:0o700});
}
const cliVersion = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
const token = "synthetic-split-control-".repeat(3);
const records: any[] = [], children = new Set<ChildProcess>();
const units = new Map<ChildProcess, string>();
const systemd = process.env.OPENCRAFT_CORE_DRILL_SYSTEMD === "1";
if (!systemd) throw new Error("This local-only OOM drill requires OPENCRAFT_CORE_DRILL_SYSTEMD=1");
let unitSequence = 0;
const model = createServer((request, response) => {
  // command/exec does not need inference; reject accidental upstream work.
  if (request.url === "/usage") { response.end('{"plan_type":"pro"}'); return; }
  if (request.url?.endsWith("/models")) { response.end('{"data":[]}'); return; }
  records.push({ event: "unexpected-model-request", path: request.url });
  response.writeHead(500); response.end();
});
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as import("node:net").AddressInfo).port;
}
const modelPort = await listen(model);
const reservation = createServer(), proxyPort = await listen(reservation);
await new Promise<void>(resolve => reservation.close(() => resolve()));
const dataDirectory = join(root, "data");
const store = new AccountPoolStore({ databasePath: join(dataDirectory, "account-pool.sqlite"), secretsDirectory: join(dataDirectory, "secrets") });
store.addAccount({ id: "synthetic", provider: "codex", label: "Synthetic", upstreamAccountId: "synthetic", enabled: true, priority: 0 },
  { accessToken: "synthetic-no-upstream-access", refreshToken: null, expiresAt: null }); store.close();
const endpoint = join(root, "accounts/control.sock"), appServerEndpoint = join(root, "execution/control.sock");
const common = { authToken: token, executable, dataDirectory, runtimeDirectory: root };
const coreOptions = { ...common, endpoint, appServerEndpoint, proxyPort, nativeCodexHomeDirectory: join(root, "native"), upstreamBaseUrl: `http://127.0.0.1:${modelPort}` };
const runtimeOptions = { ...common, endpoint: appServerEndpoint, coreEndpoint: endpoint, waitForCore: true };
const control = new CodexCoreControlClient(endpoint, token);
const runtimeControl = new CodexCoreControlClient(appServerEndpoint, token);
async function wait(check: () => Promise<unknown> | unknown, label: string, timeout = 20000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
async function owner(kind: "core" | "runtime", options: object) {
  const config = join(root, `${kind}.json`); await writeFile(config, JSON.stringify(options), { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: root, LANG: "C.UTF-8", XDG_CONFIG_HOME: join(root, "home/config"),
    XDG_DATA_HOME: join(root, "home/data"), RUST_LOG: "error" };
  const cwd = resolve(import.meta.dirname, "../../..");
  const legacy = (kind === "runtime" && process.env.OPENCRAFT_DRILL_LEGACY_RUNTIME === "1")
    || (kind === "core" && process.env.OPENCRAFT_DRILL_LEGACY_CORE === "1");
  const appBundle=process.env.OPENCRAFT_TOOL_MEMORY_APP_BUNDLE;
  const tokenFile=join(root,"token"); await writeFile(tokenFile,token,{mode:0o600});
  const args = kind === "runtime" && appBundle ? [appBundle,"--endpoint",runtimeOptions.endpoint,"--core-endpoint",runtimeOptions.coreEndpoint,"--token-file",tokenFile,"--data-directory",dataDirectory,"--runtime-directory",root,"--codex-executable",executable!] : legacy ? [process.env.OPENCRAFT_DRILL_LEGACY_OWNER!,kind,config] : ["--import","tsx","tests/fixtures/split-codex-owner.ts",kind,config];
  const unit = `oc-core-split-drill-${process.pid}-${++unitSequence}-${kind}.service`;
  const child = systemd ? spawn("systemd-run", ["--quiet", "--wait", "--pipe", "--collect", `--unit=${unit}`,
    "--property=KillMode=control-group", "--property=TimeoutStopSec=infinity", `--working-directory=${cwd}`,
    ...(kind === "runtime" ? ["--property=Restart=on-failure", "--property=RestartSec=1", "--property=Delegate=yes", "--property=DelegateSubgroup=app", "--property=OOMPolicy=continue", "--property=OOMScoreAdjust=-1000", "--property=MemoryHigh=512M", "--property=MemoryMax=512M", "--property=MemorySwapMax=0"] : []),
    "/usr/bin/env", "-i", ...Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`),
    process.execPath, ...args], { stdio: ["ignore", "pipe", "pipe"] })
    : spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  if (systemd) units.set(child, unit);
  children.add(child); child.once("exit", () => children.delete(child));
  let output = "", errors = ""; child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.on("data", chunk => { errors += chunk; });
  child.once("exit", () => { void writeFile(join(root, `${kind}-${child.pid}.log`), errors); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out: ${kind} startup`)), 20000);
    const onData = () => { if ((output.includes("ready\n") || output.includes('"type":"codex-app-server-ready"'))) finish(); };
    const onExit = () => finish(new Error(errors || `${kind} exited during startup`));
    const finish = (error?: Error) => { clearTimeout(timer); child.stdout!.off("data", onData); child.off("exit", onExit); error ? reject(error) : resolve(); };
    child.stdout!.on("data", onData); child.once("exit", onExit); onData();
    if (child.exitCode !== null) onExit();
  });
  return child;
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const unit = units.get(child);
  if (unit) await new Promise<void>((resolve, reject) => execFile("systemctl",
    signal === "SIGKILL" ? ["kill", "--kill-whom=main", "--signal=SIGKILL", unit] : ["stop", unit], error => error ? reject(error) : resolve()));
  else child.kill(signal);
  await exit;
}
async function connectNative(socketPath?: string) {
  const nativeSocket = socketPath ?? (await control.health()).nativeSocket;
  const socket = new WebSocket(`ws+unix://${nativeSocket}:/`);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let seq = 0; const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const notifications: any[] = [];
  socket.on("message", raw => {
    const frame = JSON.parse(String(raw));
    if (frame.id && !frame.method) { const item = pending.get(frame.id); pending.delete(frame.id); frame.error ? item?.reject(new Error(frame.error.message)) : item?.resolve(frame.result); }
    else notifications.push(frame);
  });
  socket.on("close", () => { for (const item of pending.values()) item.reject(new Error("native closed")); pending.clear(); });
  async function rpc(method: string, params: object = {}) {
    const id = ++seq;
    return new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  }
  await rpc("initialize", { clientInfo: { name: "isolated-split-drill", version: "1" }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: "initialized" }));
  return { socket, rpc, notifications };
}
let core: ChildProcess | undefined, runtime: ChildProcess | undefined, native: Awaited<ReturnType<typeof connectNative>> | undefined;
const result: any = { root, cliVersion, systemd, scenarios: [] };
let guardUnit = "";
const show = (unit: string, property: string) => execFileSync("systemctl", ["show", unit, "-p", property, "--value"], { encoding: "utf8" }).trim();

try {
  core=await owner("core",coreOptions); runtime=await owner("runtime",runtimeOptions);
  native=await connectNative(); const before=await runtimeControl.health(); const appUnit=units.get(runtime)!;
  const ownerCgroup = `/sys/fs/cgroup${show(appUnit, "ControlGroup")}`;
  await writeFile(`${ownerCgroup}/cgroup.subtree_control`, "+memory +pids");
  const unfinishedGroup = `${ownerCgroup}/tool-2147483647-1`;
  await mkdir(unfinishedGroup);
  assert.equal((await readFile(`${unfinishedGroup}/memory.max`, "utf8")).trim(), "max");
  const score=(pid:number)=>readFile(`/proc/${pid}/oom_score_adj`,"utf8").then(s=>Number(s.trim()));
  assert.equal(await score(before.codexPid), -999, "APP must make native killable before any guard starts");
  const pendingFamily=[before.codexPid], checkedFamily=new Set<number>();
  while(pendingFamily.length) {
    const pid=pendingFamily.pop()!; if(checkedFamily.has(pid)) continue; checkedFamily.add(pid);
    try {
      assert.notEqual(await score(pid),-1000,"no native launcher descendant may retain immunity before guard startup");
      for(const task of await readdir(`/proc/${pid}/task`)) {
        try { pendingFamily.push(...(await readFile(`/proc/${pid}/task/${task}/children`,"utf8")).trim().split(/\s+/u).filter(Boolean).map(Number)); }
        catch(error) {if(!["ENOENT","ESRCH"].includes((error as NodeJS.ErrnoException).code??"")) throw error;}
      }
    } catch(error) {if(!["ENOENT","ESRCH"].includes((error as NodeJS.ErrnoException).code??"")) throw error;}
  }
  if(process.env.OPENCRAFT_TOOL_MEMORY_FORCE_WRAPPER_IMMUNITY==="1") {
    const zeroPid=Number(await readFile(join(root,"launcher/score-zero-pid"),"utf8"));
    assert.equal(await score(zeroPid),0,"startup recovery must preserve an existing tool score 0");
  }
  result.scenarios.push({name:"native family killable before guard",checkedProcesses:checkedFamily.size,forcedLauncherImmunity:process.env.OPENCRAFT_TOOL_MEMORY_FORCE_WRAPPER_IMMUNITY==="1"});
  const plan = renderToolMemoryGuard({ unit: appUnit, highMiB: 512, maxMiB: 512,
    payload: await readFile(process.env.OPENCRAFT_TOOL_MEMORY_GUARD_PAYLOAD ?? resolve("scripts/server-deployment/tool-memory-guard.py")),
    policy: { schemaVersion: 1, toolMemoryHighMiB: 64, toolMemoryMaxMiB: 256, toolPidsMax: 256,
      generationUnitPattern: `oc-core-split-drill-${process.pid}-*.service`, nativeExecutableNames: [executable!.split("/").at(-1)!] }, stateDirectory: root });
  const guardPayload = join(root, "guard.py"), guardConfig = join(root, "guard-policy.json");
  await writeFile(guardPayload, plan.files[0].content, { mode: 0o600 }); await writeFile(guardConfig, plan.files[1].content, { mode: 0o600 });
  guardUnit=`oc-tool-guard-${process.pid}.service`;
  execFileSync("systemd-run",["--quiet",`--unit=${guardUnit}`,"--property=Restart=always","--property=RestartSec=100ms","--property=KillMode=control-group","/usr/bin/python3",guardPayload,"--watch-generations","--config",guardConfig]);
  await wait(() => execFileSync("journalctl", ["-u", guardUnit, "-o", "cat", "--no-pager"], { encoding: "utf8" }).includes('"event": "ready"'), "guard connector ready");
  await wait(async()=>await score(before.codexPid)===-999,"priority registered");assert.equal(await score(before.pid),-1000);
  await wait(() => readFile(`${unfinishedGroup}/memory.max`, "utf8").then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT"), "unfinished group discarded on restart");
  result.scenarios.push({name:"unfinished initialization recovery",defaultMaxWasUnlimited:true,emptyGroupRemoved:true});
  const holdPidFile = join(root, "guard-restart-tool");
  const hold = native.rpc("command/exec", {command:["/usr/bin/python3","-c",`import os,pathlib,time; pathlib.Path(${JSON.stringify(holdPidFile)}).write_text(str(os.getpid())); a=bytearray(16*1024*1024); time.sleep(3)`],cwd:root,sandboxPolicy:{type:"dangerFullAccess"},timeoutMs:10000});
  let heldPid = 0;
  await wait(async () => { heldPid=Number(await readFile(holdPidFile,"utf8")); return (await readFile(`/proc/${heldPid}/cgroup`,"utf8")).includes("/tool-"); }, "held tool adopted");
  const heldGroup = await readFile(`/proc/${heldPid}/cgroup`,"utf8");
  const heldCgroup = `/sys/fs/cgroup${heldGroup.trim().slice(3)}`;
  assert.equal(Number(await readFile(`${heldCgroup}/memory.high`,"utf8")),64*1024*1024);
  assert.equal(Number(await readFile(`${heldCgroup}/memory.max`,"utf8")),256*1024*1024);
  const guardBefore = Number(show(guardUnit,"MainPID"));
  execFileSync("systemctl",["kill","--kill-whom=main","--signal=SIGKILL",guardUnit]);
  await wait(() => Number(show(guardUnit,"MainPID"))>0 && Number(show(guardUnit,"MainPID"))!==guardBefore && execFileSync("journalctl",["-u",guardUnit,"-o","cat","--no-pager"],{encoding:"utf8"}).split('"event": "ready"').length>=3,"guard restart and worker reconciliation");
  assert.equal(await readFile(`/proc/${heldPid}/cgroup`,"utf8"),heldGroup); assert.equal(await score(heldPid),0);
  assert.equal((await hold).exitCode,0);
  result.scenarios.push({name:"supervisor crash recovery",restarts:Number(show(guardUnit,"NRestarts")),heldToolPreserved:true,nativeKillableBeforeGuard:true});
  const highProbe = await native.rpc("command/exec", {command:["/usr/bin/python3","-c","import pathlib,time;\nwhile '/tool-' not in pathlib.Path('/proc/self/cgroup').read_text(): time.sleep(.002)\na=bytearray(96*1024*1024)"],cwd:root,sandboxPolicy:{type:"dangerFullAccess"},timeoutMs:1500});
  assert.notEqual(highProbe.exitCode,137,"High-only probe must not be called an OOM kill");
  result.scenarios.push({name:"High-only observation",exitCode:highProbe.exitCode,timeoutConfiguredMs:1500});
  const pressurePolicy = JSON.parse(plan.files[1].content); pressurePolicy.toolMemoryHighMiB=256;
  await writeFile(guardConfig,JSON.stringify(pressurePolicy),{mode:0o600});
  const priorGuard = Number(show(guardUnit,"MainPID"));
  execFileSync("systemctl",["restart",guardUnit]);
  await wait(()=>Number(show(guardUnit,"MainPID"))!==priorGuard && execFileSync("journalctl",["-u",guardUnit,"-o","cat","--no-pager"],{encoding:"utf8"}).split('"event": "ready"').length>=4,"configured worker restart");
  const pressure=(name:string)=>Promise.allSettled(Array.from({length:12},()=>native!.rpc("command/exec",{command:["/usr/bin/python3","-c",`import os,time,pathlib,json; pathlib.Path(${JSON.stringify(root)}).joinpath(${JSON.stringify("score-")}+${JSON.stringify(name)}+"-"+str(os.getpid())).write_text(json.dumps({"score":pathlib.Path("/proc/self/oom_score_adj").read_text().strip(),"cgroup":pathlib.Path("/proc/self/cgroup").read_text().strip()})); a=bytearray(96*1024*1024); time.sleep(2)`],cwd:root,sandboxPolicy:{type:"dangerFullAccess"},timeoutMs:10000})));
  const guarded=await pressure("guarded");assert.ok(guarded.every(item => item.status === "fulfilled"), "guarded tools must finish without losing native");const after=await runtimeControl.health();assert.equal(after.pid,before.pid);assert.equal(after.codexPid,before.codexPid);
  const outcomes=guarded.filter((x:any)=>x.status==="fulfilled").map((x:any)=>x.value.exitCode);assert.ok(outcomes.some((x:number)=>x!==0));
  const cg=execFileSync("systemctl",["show",appUnit,"-p","ControlGroup","--value"],{encoding:"utf8"}).trim();
  assert.ok(outcomes.every((code:number) => code === 0 || code === 137), "only success or OOM exit, no budget rejection");
  result.scenarios.push({name:"guarded parent OOM",appPid:before.pid,nativePid:before.codexPid,appScore:await score(before.pid),nativeScore:await score(before.codexPid),appPidUnchanged:true,nativePidUnchanged:true,outcomes,localEvents:await readFile(`/sys/fs/cgroup${cg}/memory.events.local`,"utf8")});
  result.guardLog = execFileSync("journalctl", ["-u", guardUnit, "-o", "cat", "--no-pager"], { encoding: "utf8" });
  const memoryEvents = result.guardLog.split("\n").filter((line:string)=>line.startsWith("{")).map((line:string)=>JSON.parse(line)).filter((event:any)=>["tool-memory-high","tool-memory-oom"].includes(event.event));
  assert.ok(memoryEvents.some((event:any)=>event.event==="tool-memory-high")); assert.ok(memoryEvents.some((event:any)=>event.event==="tool-memory-oom"));
  assert.ok(memoryEvents.every((event:any)=>event.generation===appUnit && event.command_name && event.timestamp && event.memory_peak_bytes>=0 && event.occurrences>0));
  result.scenarios.push({name:"configured High/OOM telemetry",highProbeMiB:64,pressureHighMiB:256,toolMaxMiB:256,eventCount:memoryEvents.length,allMetadataPresent:true});
  if(process.env.OPENCRAFT_TOOL_MEMORY_FORCE_WRAPPER_IMMUNITY==="1") {
    const prior=await runtimeControl.health(), restarts=Number(show(appUnit,"NRestarts")), start=Date.now();
    process.kill(prior.codexPid,"SIGKILL"); native.socket.terminate();
    await wait(async()=>{
      if(Number(show(appUnit,"NRestarts"))<=restarts) return false;
      const candidate=await connectNative();
      try {
        const reply=await candidate.rpc("command/exec",{command:["/bin/echo","launcher recovered"],cwd:root,sandboxPolicy:{type:"dangerFullAccess"},timeoutMs:2000});
        if(reply.exitCode!==0) throw new Error("launcher recovery failed"); native=candidate; return true;
      } catch(error) {candidate.socket.terminate();throw error;}
    },"launcher exit recovery without waiting for inherited stdio",8000);
    result.scenarios.push({name:"launcher exit with inherited stdio",elapsedMs:Date.now()-start,budgetMs:8000,restarted:true});
  }
  execFileSync("systemctl",["stop",guardUnit]);assert.equal(show(guardUnit, "ActiveState"), "inactive");
  const fallbackBefore = await runtimeControl.health();
  const fallback=await pressure("unadopted");native.socket.terminate();
  const unadopted = await Promise.all((await readdir(root)).filter(name => name.startsWith("score-unadopted-")).map(async name => JSON.parse(await readFile(join(root, name), "utf8"))));
  assert.ok(unadopted.length > 0); assert.ok(unadopted.every(item => item.score === "-999" && item.cgroup.endsWith("/app")), "unadopted tools inherit killable native priority in app leaf");
  // Old health can still be 200 while native close is propagating. Require a
  // fresh connection and successful command together, retrying transient 503s.
  await wait(async()=>{
    const candidate=await connectNative();
    try {
      const healthy=await candidate.rpc("command/exec",{command:["/bin/echo","recovered"],cwd:root,sandboxPolicy:{type:"dangerFullAccess"},timeoutMs:5000});
      assert.equal(healthy.exitCode,0); native=candidate; return true;
    } catch (error) { candidate.socket.terminate(); throw error; }
  },"fallback command recovery",30000);
  result.scenarios.push({name:"guard stopped / unadopted pressure",settled:fallback.length,outcomes:fallback.map(item => item.status === "fulfilled" ? item.value.exitCode : "native connection closed"),beforeAppPid:fallbackBefore.pid,beforeNativePid:fallbackBefore.codexPid,unadoptedMetadata:unadopted,restarts:Number(show(appUnit,"NRestarts")),readyAgain:true,localEvents:await readFile(`/sys/fs/cgroup${cg}/memory.events.local`,"utf8"),appPid:(await runtimeControl.health()).pid,nativePid:(await runtimeControl.health()).codexPid});result.result="passed";
} catch (error) { result.result = "failed"; result.error = error instanceof Error ? error.message : String(error); throw error; }
finally {
  native?.socket.terminate();
  if (guardUnit) { try { execFileSync("systemctl", ["stop", guardUnit], { stdio: "ignore" }); } catch {} }
  for (const child of children) await stop(child);
  model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
  result.requests = records;
  await writeFile(join(root, "report.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ result: result.result, report: join(root, "report.json") }));
}
