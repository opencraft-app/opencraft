import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { ChaosViolation, generateRecoveryChaos, parseRecoveryTrace, shrinkChaosFailure, simulateRecovery } from "../tests/protocol/fixtures/recovery-chaos";
import { generateHistoryChaos, parseHistoryTrace, simulateHistoryRecovery } from "../tests/protocol/fixtures/history-recovery-chaos";
import { generateHydrationChaos, parseHydrationTrace, simulateHydrationRecovery } from "../tests/protocol/fixtures/hydration-recovery-chaos";
const {values}=parseArgs({options:{seed:{type:"string",default:"20261025"},cases:{type:"string",default:"100"},steps:{type:"string",default:"120"},output:{type:"string"},replay:{type:"string"},mutant:{type:"string"},suite:{type:"string"}}});
function integer(value:string,name:string,maximum:number) {
  const n=Number(value);if(!Number.isSafeInteger(n) || n<0 || n>maximum) throw Error(`Invalid ${name}: expected an integer in 0..${maximum}`);return n;
}
const seed=integer(values.seed!,"seed",0xffffffff),cases=integer(values.cases!,"cases",100_000),steps=integer(values.steps!,"steps",10_000);
const replay=values.replay?JSON.parse(await readFile(values.replay,"utf8")):null;
const suite=replay?.suite??values.suite??"host";
if(!["host","history","hydration"].includes(suite) || (replay?.suite && values.suite && values.suite!==replay.suite))throw Error("Invalid or conflicting chaos suite");
if(values.mutant && !(suite==="host"?["sticky-initialize","replay-mutation","wall-clock-budget"]:suite==="history"?["lost-admission"]:["sticky-read","coupled-activation","early-dispatch"]).includes(values.mutant))throw Error("Unknown negative control for this suite");
const hostOptions=values.mutant?{mutant:values.mutant as "sticky-initialize" | "replay-mutation" | "wall-clock-budget"}:{};
const hydrationOptions=values.mutant?{mutant:values.mutant as "sticky-read" | "coupled-activation" | "early-dispatch"}:{};
const historyOptions=values.mutant?{mutant:"lost-admission" as const}:{};
const output=path.resolve(values.output??path.join(process.env.TMPDIR??"/tmp",`opencraft-recovery-chaos-${process.pid}`));
await mkdir(output,{recursive:true});
const started=Date.now(),coverage:Record<string,number>={};let events=0,wires=0,ready=0,historyRuns=0,historyCompleted=0;
const sourcePaths=["scripts/recovery-chaos.ts", "tests/protocol/fixtures/recovery-chaos.ts", "packages/workbench-runtime/src/recovery-clock.ts", "packages/appserver-client/src/clock.ts",
  ...(suite==="hydration"?["tests/protocol/fixtures/hydration-recovery-chaos.ts","packages/workbench-runtime/src/appserver-runtime.ts","packages/workbench-runtime/src/recovery-policy.ts","packages/appserver-session/src/resume-coordinator.ts","packages/appserver-session/src/history-strategies.ts","packages/appserver-session/src/projectors.ts","packages/appserver-session/src/notification-buffer.ts","packages/appserver-session/src/replica-adapter.ts","packages/composer-appserver/src/command-port.ts","packages/chat-runtime/src/replica-conversation-runtime.ts","packages/appserver-client/src/client.ts"]:suite==="history"?["tests/protocol/fixtures/history-recovery-chaos.ts","packages/workbench-runtime/src/recovery-policy.ts"]:
    ["packages/appserver-client/src/client.ts","packages/appserver-client/src/transport.ts","packages/workbench-runtime/src/connection-lifecycle.ts"])];
const sourceSha256=Object.fromEntries(await Promise.all(sourcePaths.map(async file=>[file,
  createHash("sha256").update(await readFile(new URL(`../${file}`,import.meta.url))).digest("hex")])));
const provenance={suite,generatorVersion:suite==="host"?3:suite==="hydration"?2:1,sourceSha256};
const replaySeed=replay?.seed===undefined?seed:integer(String(replay.seed),"replay seed",0xffffffff);
const count=replay?1:cases;
if(count===0)throw Error("At least one case is required");
interface Result {events:number;coverage:Record<string,number>;wires?:number;ready?:number;historyRuns?:number;historyCompleted?:number}
async function execute<T>(trace:readonly T[],caseSeed:number,run:(events:readonly T[])=>Promise<Result>) {
  try {
    const result=await run(trace);events+=result.events;wires+=result.wires??0;ready+=result.ready??0;
    historyRuns+=result.historyRuns??0;historyCompleted+=result.historyCompleted??0;
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
  const passed=suite==="hydration"
    ?await execute(replay?parseHydrationTrace(replay.events??replay):generateHydrationChaos(caseSeed,steps),caseSeed,trace=>simulateHydrationRecovery(trace,hydrationOptions))
    :suite==="history"
    ?await execute(replay?parseHistoryTrace(replay.events??replay):generateHistoryChaos(caseSeed,steps),caseSeed,trace=>simulateHistoryRecovery(trace,historyOptions))
    :await execute(replay?parseRecoveryTrace(replay.events??replay):generateRecoveryChaos(caseSeed,steps),caseSeed,trace=>simulateRecovery(trace,hostOptions));
  if(!passed)break;
}
if(!process.exitCode) {
  const result={schema:1,...provenance,passed:true,seed:replay?replaySeed:seed,cases:count,events,
    ...(suite!=="host"?{historyRuns,historyCompleted}:{wires,ready}),coverage,elapsedMs:Date.now()-started};
  await writeFile(path.join(output,"results.json"),JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify({...result,output}));
}
