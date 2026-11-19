import assert from "node:assert/strict";
import test from "node:test";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {delimiter, join} from "node:path";
import {createServer} from "node:http";
import {WebSocketServer} from "ws";
import {SystemdGenerationSupervisor} from "../../apps/codex-core/src/generation-supervisor.js";
import {inspectRouterNative} from "../../apps/codex-core/src/router-maintenance.js";
import {startControlServer} from "../../apps/codex-core/src/control-server.js";

test("existing Native custody remains cold-readable while fault recovery captures a systemd invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-identity-upgrade-"));
  const native = join(root, "native.sock"), endpoint = join(root, "core.sock"), bin = join(root, "bin");
  const token = "synthetic-identity-upgrade", originalPath = process.env.PATH;
  const http = createServer(), wss = new WebSocketServer({server:http});
  wss.on("connection", socket => socket.on("message", raw => {
    const packet = JSON.parse(String(raw));
    if (packet.id !== undefined) socket.send(JSON.stringify({id:packet.id,result:packet.method === "thread/loaded/list" ? {data:[]} : {userAgent:"fixture"}}));
  }));
  let control: Awaited<ReturnType<typeof startControlServer>> | undefined;
  try {
    await mkdir(bin); await writeFile(join(bin,"systemctl"), `#!${process.execPath}
console.log(${JSON.stringify("LoadState=loaded\nActiveState=active\nMainPID="+process.pid+"\nUnitFileState=static\nInvocationID=fixture-invocation")});
`, {mode:0o755});
    process.env.PATH = bin + delimiter + (originalPath ?? "");
    await new Promise<void>(resolve => http.listen(native,resolve));
    control = await startControlServer(endpoint,token,async () => ({status:200,value:{pid:process.pid,
      handoff:{protocolVersion:1,topology:"split",phase:"open",persistence:"ready",owner:"fixture",epoch:1,uncertain:[]},
      proof:{counts:{oauth:0,proxy:0,refresh:0,requests:0,resetCredits:0,subscriptions:0}}}}));
    const generation:any = {id:"one",state:"active",incarnation:1,externalUnit:"fixture.service",executable:process.execPath,node:process.execPath,
      cwd:root,runtimeDataDirectory:root,executionUid:process.getuid!(),executionGid:process.getgid!()};
    const health:any = {pid:process.pid,codexPid:process.pid,nativeSocket:native,callbackProtocolVersion:1,pendingCallbacks:0,pendingOrchestrationMutations:0};
    const supervisor = new SystemdGenerationSupervisor({registryDirectory:root,coreEndpoint:endpoint,dataDirectory:root,tokenFile:join(root,"token"),token,scope:"system"});
    const observed = await supervisor.identify(generation,health);
    const {invocationId: _extra, ...legacy} = observed;
    const inspect = () => inspectRouterNative({generations:[generation],routes:[],metadata:{"runtime:one":legacy},unresolvedCreations:0,
      supervisor:{inspect:async()=>health,identify:supervisor.identify.bind(supervisor),processesQuiet:async()=>true} as any,
      coreEndpoint:endpoint,token,failures:{version:1,failures:[]}},true);
    assert.deepEqual((await inspect()).generations[0]!.identity,legacy);
    const fault = await supervisor.captureExecutionIdentity(generation,legacy);
    assert.equal(fault.invocationId,"fixture-invocation");
    assert.deepEqual((await inspect()).generations[0]!.identity,legacy,"fault provenance must not invalidate old Native custody");
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await control?.close(); for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(()=>resolve())); await new Promise<void>(resolve => http.close(()=>resolve()));
    await rm(root,{recursive:true,force:true});
  }
});
