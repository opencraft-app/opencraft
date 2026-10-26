import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { ChaosViolation, generateRecoveryChaos, parseRecoveryTrace, shrinkChaosFailure, simulateRecovery } from "../tests/protocol/fixtures/recovery-chaos";
import { generateHistoryChaos, parseHistoryTrace, simulateHistoryRecovery } from "../tests/protocol/fixtures/history-recovery-chaos";
import { generateHydrationChaos, parseHydrationTrace, simulateHydrationRecovery } from "../tests/protocol/fixtures/hydration-recovery-chaos";
import { generateExecutionChaos, parseExecutionTrace, simulateExecutionRecovery, type ExecutionChaosMutant } from "../tests/protocol/fixtures/execution-recovery-chaos";
import { generateStopChaos, parseStopTrace, simulateStopRecovery, type StopChaosMutant } from "../tests/protocol/fixtures/stop-recovery-chaos";
import { generateProjectionChaos, parseProjectionTrace, simulateProjectionNotifications, type ProjectionChaosMutant } from "../tests/protocol/fixtures/projection-notification-chaos";
import { generateFanoutChaos, parseFanoutTrace, simulateNotificationFanout, type FanoutChaosMutant } from "../tests/protocol/fixtures/notification-fanout-chaos";
import { generateObserverChaos, parseObserverTrace, simulateObserverAdmission, type ObserverChaosMutant } from "../tests/protocol/fixtures/observer-admission-chaos";
import { generateHandlerChaos, parseHandlerTrace, simulateHandlerRegistration, type HandlerChaosMutant } from "../tests/protocol/fixtures/handler-registration-chaos";
import { generateTransportChaos, parseTransportTrace, simulateTransportStatus, type TransportChaosMutant } from "../tests/protocol/fixtures/transport-status-chaos";
import { generateMemoryChaos, parseMemoryTrace, simulateMemoryGenerations, type MemoryChaosMutant } from "../tests/protocol/fixtures/memory-generation-chaos";
import { generateRetirementChaos, parseRetirementTrace, simulateClientRetirement, type RetirementMutant } from "../tests/protocol/fixtures/client-retirement-chaos";
const {values}=parseArgs({options:{seed:{type:"string",default:"20261025"},cases:{type:"string",default:"100"},steps:{type:"string",default:"120"},output:{type:"string"},replay:{type:"string"},mutant:{type:"string"},suite:{type:"string"}}});
function integer(value:string,name:string,maximum:number) {
  const n=Number(value);if(!Number.isSafeInteger(n) || n<0 || n>maximum) throw Error(`Invalid ${name}: expected an integer in 0..${maximum}`);return n;
}
const seed=integer(values.seed!,"seed",0xffffffff),cases=integer(values.cases!,"cases",100_000),steps=integer(values.steps!,"steps",10_000);
const replay=values.replay?JSON.parse(await readFile(values.replay,"utf8")):null;
const suite=replay?.suite??values.suite??"host";
if(!["host","history","hydration","execution","stop","projection","fanout","observers","handlers","transport","memory","retirement"].includes(suite) || (replay?.suite && values.suite && values.suite!==replay.suite))throw Error("Invalid or conflicting chaos suite");
if(values.mutant && !(suite==="retirement"?["rearm-old-loss","drop-current-loss","orphan-connect","replay-request"]:suite==="memory"?["orphan-connect","stale-peer","cleanup-retarget"]:suite==="transport"?["orphan-connect","stale-token","stale-status","drop-peer"]:suite==="handlers"?["stale-token","retarget-result","cancel-admitted"]:suite==="observers"?["live-admission","stale-token","drop-terminal"]:suite==="fanout"?["live-admission","stale-token","lost-continuation"]:suite==="projection"?["global-buffer","peer-buffer","native-replay","drop-projection","missing-restore-wake"]:suite==="stop"?["history-gated-stop","prompt-gated-stop","retarget-stop","replay-stop"]:suite==="host"?["sticky-initialize","replay-mutation","wall-clock-budget"]:suite==="history"?["lost-admission"]:suite==="execution"?["buffer-native","buffer-settings","wrong-native-answer","wrong-response-id","history-gated-response"]:["sticky-read","coupled-activation","early-dispatch","delta-only"]).includes(values.mutant))throw Error("Unknown negative control for this suite");
const hostOptions=values.mutant?{mutant:values.mutant as "sticky-initialize" | "replay-mutation" | "wall-clock-budget"}:{};
const hydrationOptions=values.mutant?{mutant:values.mutant as "sticky-read" | "coupled-activation" | "early-dispatch" | "delta-only"}:{};
const executionOptions=values.mutant?{mutant:values.mutant as ExecutionChaosMutant}:{};
const stopOptions=values.mutant?{mutant:values.mutant as StopChaosMutant}:{};
const projectionOptions=values.mutant?{mutant:values.mutant as ProjectionChaosMutant}:{};
const fanoutOptions=values.mutant?{mutant:values.mutant as FanoutChaosMutant}:{};
const retirementOptions=values.mutant?{mutant:values.mutant as RetirementMutant}:{};
const memoryOptions=values.mutant?{mutant:values.mutant as MemoryChaosMutant}:{};
const transportOptions=values.mutant?{mutant:values.mutant as TransportChaosMutant}:{};
const handlerOptions=values.mutant?{mutant:values.mutant as HandlerChaosMutant}:{};
const observerOptions=values.mutant?{mutant:values.mutant as ObserverChaosMutant}:{};
const historyOptions=values.mutant?{mutant:"lost-admission" as const}:{};
const output=path.resolve(values.output??path.join(process.env.TMPDIR??"/tmp",`opencraft-recovery-chaos-${process.pid}`));
await mkdir(output,{recursive:true});
const started=Date.now(),coverage:Record<string,number>={};let events=0,wires=0,ready=0,historyRuns=0,historyCompleted=0,nativeReplies=0,stopIntents=0,nativeEvents=0,requestedReads=0,notificationDeliveries=0,observerEvents=0,observerDeliveries=0,rpcIntents=0,rpcFrames=0,connectIntents=0,connectSettled=0,statusEvents=0,statusDeliveries=0,statusSamples=0,nativeAdmissions=0,cleanupCalls=0,messageDeliveries=0,nativeInitializations=0;
const sourcePaths=["scripts/recovery-chaos.ts","package-lock.json", "tests/protocol/fixtures/recovery-chaos.ts", "packages/workbench-runtime/src/recovery-clock.ts", "packages/appserver-client/src/clock.ts","packages/appserver-client/src/observer-list.ts",
  ...(suite==="retirement"?["tests/protocol/fixtures/client-retirement-chaos.ts","packages/appserver-client/src/client.ts","packages/appserver-client/src/transport.ts","packages/appserver-transport-memory/src/memory-transport.ts","packages/appserver-transport-memory/src/index.ts"]:suite==="memory"?["tests/protocol/fixtures/memory-generation-chaos.ts","packages/appserver-transport-memory/src/index.ts","packages/appserver-transport-memory/src/memory-transport.ts","packages/appserver-client/src/transport.ts"]:suite==="transport"?["tests/protocol/fixtures/transport-status-chaos.ts","tests/protocol/fixtures/transport-status.ts","tests/protocol/fixtures/execution-channels.ts","packages/appserver-client/src/transport.ts","packages/appserver-transport-websocket/src/websocket-transport.ts","packages/appserver-transport-memory/src/memory-transport.ts","packages/appserver-transport-replay/src/replay-transport.ts","packages/app-host-client/src/index.ts"]:suite==="handlers"?["tests/protocol/fixtures/handler-registration-chaos.ts","tests/protocol/fixtures/execution-channels.ts","packages/appserver-client/src/client.ts","packages/appserver-client/src/observer-list.ts","packages/appserver-transport-memory/src/index.ts","packages/appserver-transport-memory/src/memory-transport.ts"]:suite==="observers"?["package-lock.json","tests/protocol/fixtures/observer-admission-chaos.ts","tests/protocol/fixtures/execution-channels.ts","packages/appserver-client/src/client.ts","packages/appserver-transport-memory/src/memory-transport.ts"]:suite==="fanout"?["package-lock.json","tests/protocol/fixtures/notification-fanout-chaos.ts","tests/protocol/fixtures/execution-channels.ts","packages/appserver-client/src/client.ts","packages/appserver-transport-memory/src/index.ts","packages/appserver-transport-memory/src/memory-transport.ts"]:suite==="projection"?["tests/protocol/fixtures/projection-notification-chaos.ts","tests/protocol/fixtures/execution-channels.ts","tests/protocol/fixtures/execution-recovery-chaos.ts","packages/appserver-client/src/client.ts","packages/appserver-client/src/cordis-service.ts","packages/appserver-session/src/notification-buffer.ts","packages/appserver-session/src/resume-coordinator.ts","packages/appserver-session/src/cordis-runtime.ts","packages/appserver-session/src/view-store.ts","packages/appserver-session/src/projectors.ts","packages/workbench-runtime/src/appserver-runtime.ts"]:suite==="stop"?["tests/protocol/fixtures/stop-control.ts","tests/protocol/fixtures/stop-recovery-chaos.ts","tests/protocol/fixtures/execution-recovery-chaos.ts","packages/workbench-runtime/src/appserver-runtime.ts","packages/workbench-runtime/src/connection-lifecycle.ts","packages/appserver-client/src/client.ts","packages/composer-appserver/src/command-port.ts","packages/composer-appserver/src/interaction-broker.ts","packages/chat-runtime/src/ports.ts","packages/chat-runtime/src/replica-conversation-runtime.ts","packages/appserver-session/src/resume-coordinator.ts","packages/appserver-session/src/notification-buffer.ts"]:suite==="execution"?["tests/protocol/fixtures/execution-recovery-chaos.ts","tests/protocol/fixtures/execution-channels.ts","packages/appserver-client/src/client.ts","packages/appserver-session/src/notification-buffer.ts","packages/appserver-session/src/resume-coordinator.ts","packages/appserver-session/src/view-store.ts","packages/composer-appserver/src/interaction-broker.ts","packages/composer-appserver/src/interaction-ledger.ts"]:suite==="hydration"?["tests/protocol/fixtures/hydration-recovery-chaos.ts","packages/workbench-runtime/src/appserver-runtime.ts","packages/workbench-runtime/src/recovery-policy.ts","packages/appserver-session/src/resume-coordinator.ts","packages/appserver-session/src/history-strategies.ts","packages/appserver-session/src/projectors.ts","packages/appserver-session/src/notification-buffer.ts","packages/appserver-session/src/replica-adapter.ts","packages/composer-appserver/src/command-port.ts","packages/chat-runtime/src/replica-conversation-runtime.ts","packages/appserver-client/src/client.ts"]:suite==="history"?["tests/protocol/fixtures/history-recovery-chaos.ts","packages/workbench-runtime/src/recovery-policy.ts"]:
    ["packages/appserver-client/src/client.ts","packages/appserver-client/src/transport.ts","packages/workbench-runtime/src/connection-lifecycle.ts"])];
const sourceSha256=Object.fromEntries(await Promise.all(sourcePaths.map(async file=>[file,
  createHash("sha256").update(await readFile(new URL(`../${file}`,import.meta.url))).digest("hex")])));
const provenance={runtime:{node:process.versions.node,platform:process.platform,arch:process.arch},suite,generatorVersion:suite==="transport"?2:suite==="host"?3:suite==="hydration"?3:suite==="execution"?3:1,sourceSha256};
const replaySeed=replay?.seed===undefined?seed:integer(String(replay.seed),"replay seed",0xffffffff);
const count=replay?1:cases;
if(count===0)throw Error("At least one case is required");
interface Result {events:number;coverage:Record<string,number>;wires?:number;ready?:number;historyRuns?:number;historyCompleted?:number;nativeReplies?:number;stopIntents?:number;nativeEvents?:number;requestedReads?:number;notificationDeliveries?:number;observerEvents?:number;observerDeliveries?:number;rpcIntents?:number;rpcFrames?:number;connectIntents?:number;connectSettled?:number;statusEvents?:number;statusDeliveries?:number;statusSamples?:number;nativeAdmissions?:number;cleanupCalls?:number;messageDeliveries?:number;nativeInitializations?:number}
async function execute<T>(trace:readonly T[],caseSeed:number,run:(events:readonly T[])=>Promise<Result>) {
  try {
    const result=await run(trace);events+=result.events;wires+=result.wires??0;ready+=result.ready??0;
    historyRuns+=result.historyRuns??0;historyCompleted+=result.historyCompleted??0;nativeReplies+=result.nativeReplies??0;stopIntents+=result.stopIntents??0;nativeEvents+=result.nativeEvents??0;requestedReads+=result.requestedReads??0;notificationDeliveries+=result.notificationDeliveries??0;observerEvents+=result.observerEvents??0;observerDeliveries+=result.observerDeliveries??0;rpcIntents+=result.rpcIntents??0;rpcFrames+=result.rpcFrames??0;connectIntents+=result.connectIntents??0;connectSettled+=result.connectSettled??0;statusEvents+=result.statusEvents??0;statusDeliveries+=result.statusDeliveries??0;statusSamples+=result.statusSamples??0;nativeAdmissions+=result.nativeAdmissions??0;cleanupCalls+=result.cleanupCalls??0;messageDeliveries+=result.messageDeliveries??0;nativeInitializations+=result.nativeInitializations??0;
    for(const [key,value] of Object.entries(result.coverage))coverage[key]=(coverage[key]??0)+value;
    return true;
  }catch(error) {
    const rule=error instanceof ChaosViolation?error.rule:"HARNESS_ERROR";
    const minimal=error instanceof ChaosViolation?await shrinkChaosFailure(trace,rule,run):trace;
    const artifact={schema:1,...provenance,seed:caseSeed,rule,mutant:values.mutant??null,error:error instanceof Error?error.message:String(error),
      ...(error instanceof ChaosViolation && error.cleanupFailure?{cleanupFailure:error.cleanupFailure}:{}),events:trace};
    await writeFile(path.join(output,"failure.json"),JSON.stringify(artifact,null,2)+"\n");
    await writeFile(path.join(output,"failure-minimal.json"),JSON.stringify({...artifact,events:minimal},null,2)+"\n");
    console.error(JSON.stringify({passed:false,suite,seed:caseSeed,rule,originalEvents:trace.length,minimizedEvents:minimal.length,output}));
    process.exitCode=1;return false;
  }
}
for(let i=0;i<count;i++) {
  const caseSeed=replay?replaySeed:(seed+i)>>>0;
  const passed=suite==="retirement"
    ?await execute(replay?parseRetirementTrace(replay.events??replay):generateRetirementChaos(caseSeed,steps),caseSeed,trace=>simulateClientRetirement(trace,retirementOptions))
    :suite==="memory"
    ?await execute(replay?parseMemoryTrace(replay.events??replay):generateMemoryChaos(caseSeed,steps),caseSeed,trace=>simulateMemoryGenerations(trace,memoryOptions))
    :suite==="transport"
    ?await execute(replay?parseTransportTrace(replay.events??replay):generateTransportChaos(caseSeed,steps),caseSeed,trace=>simulateTransportStatus(trace,transportOptions))
    :suite==="handlers"
    ?await execute(replay?parseHandlerTrace(replay.events??replay):generateHandlerChaos(caseSeed,steps),caseSeed,trace=>simulateHandlerRegistration(trace,handlerOptions))
    :suite==="observers"
    ?await execute(replay?parseObserverTrace(replay.events??replay):generateObserverChaos(caseSeed,steps),caseSeed,trace=>simulateObserverAdmission(trace,observerOptions))
    :suite==="fanout"
    ?await execute(replay?parseFanoutTrace(replay.events??replay):generateFanoutChaos(caseSeed,steps),caseSeed,trace=>simulateNotificationFanout(trace,fanoutOptions))
    :suite==="projection"
    ?await execute(replay?parseProjectionTrace(replay.events??replay):generateProjectionChaos(caseSeed,steps),caseSeed,trace=>simulateProjectionNotifications(trace,projectionOptions))
    :suite==="stop"
    ?await execute(replay?parseStopTrace(replay.events??replay):generateStopChaos(caseSeed,steps),caseSeed,trace=>simulateStopRecovery(trace,stopOptions))
    :suite==="execution"
    ?await execute(replay?parseExecutionTrace(replay.events??replay):generateExecutionChaos(caseSeed,steps),caseSeed,trace=>simulateExecutionRecovery(trace,executionOptions))
    :suite==="hydration"
    ?await execute(replay?parseHydrationTrace(replay.events??replay):generateHydrationChaos(caseSeed,steps),caseSeed,trace=>simulateHydrationRecovery(trace,hydrationOptions))
    :suite==="history"
    ?await execute(replay?parseHistoryTrace(replay.events??replay):generateHistoryChaos(caseSeed,steps),caseSeed,trace=>simulateHistoryRecovery(trace,historyOptions))
    :await execute(replay?parseRecoveryTrace(replay.events??replay):generateRecoveryChaos(caseSeed,steps),caseSeed,trace=>simulateRecovery(trace,hostOptions));
  if(!passed)break;
}
if(!process.exitCode) {
  const result={schema:1,...provenance,passed:true,seed:replay?replaySeed:seed,cases:count,events,
    ...(suite==="retirement"?{nativeEvents,nativeAdmissions,nativeInitializations,connectIntents,connectSettled,rpcIntents,rpcFrames,statusSamples}:suite==="memory"?{nativeEvents,nativeAdmissions,cleanupCalls,messageDeliveries,connectIntents,connectSettled}:suite==="transport"?{nativeEvents,connectIntents,connectSettled,statusEvents,statusDeliveries,statusSamples}:suite==="handlers"?{nativeEvents,nativeReplies}:suite==="observers"?{observerEvents,observerDeliveries,nativeEvents,rpcIntents,rpcFrames}:suite==="fanout"?{nativeEvents,notificationDeliveries}:suite==="projection"?{historyRuns,requestedReads,nativeEvents}:suite==="stop"?{historyRuns,stopIntents,wires}:suite==="execution"?{historyRuns,nativeReplies}:suite!=="host"?{historyRuns,historyCompleted}:{wires,ready}),coverage,elapsedMs:Date.now()-started};
  await writeFile(path.join(output,"results.json"),JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify({...result,output}));
}
