import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { ChaosViolation, generateRecoveryChaos, parseRecoveryTrace, shrinkRecoveryFailure, simulateRecovery } from "../tests/protocol/fixtures/recovery-chaos";
const {values}=parseArgs({options:{seed:{type:"string",default:"20261025"},cases:{type:"string",default:"100"},steps:{type:"string",default:"120"},output:{type:"string"},replay:{type:"string"},mutant:{type:"string"}}});
function integer(value:string,name:string,maximum:number) {
  const n=Number(value);if(!Number.isSafeInteger(n) || n<0 || n>maximum) throw Error(`Invalid ${name}: expected an integer in 0..${maximum}`);return n;
}
const seed=integer(values.seed!,"seed",0xffffffff),cases=integer(values.cases!,"cases",100_000),steps=integer(values.steps!,"steps",10_000);
if(values.mutant && !["sticky-initialize","replay-mutation"].includes(values.mutant)) throw Error("Unknown negative control");
const options=values.mutant?{mutant:values.mutant as "sticky-initialize" | "replay-mutation"}:{};
const output=path.resolve(values.output??path.join(process.env.TMPDIR??"/tmp",`opencraft-recovery-chaos-${process.pid}`));
await mkdir(output,{recursive:true});
const started=Date.now(),coverage:Record<string,number>={};let events=0,wires=0,ready=0;
const sourceSha256=Object.fromEntries(await Promise.all([
  "scripts/recovery-chaos.ts", "tests/protocol/fixtures/recovery-chaos.ts",
  "packages/appserver-client/src/client.ts", "packages/appserver-client/src/transport.ts",
  "packages/workbench-runtime/src/connection-lifecycle.ts", "packages/workbench-runtime/src/recovery-clock.ts",
].map(async file=>[file,createHash("sha256").update(await readFile(new URL(`../${file}`,import.meta.url))).digest("hex")])));
const provenance={generatorVersion:2,sourceSha256};
const replay=values.replay?JSON.parse(await readFile(values.replay,"utf8")):null;
const replaySeed=replay?.seed===undefined?seed:integer(String(replay.seed),"replay seed",0xffffffff);
const count=replay?1:cases;
if(count===0) throw Error("At least one case is required");
for(let i=0;i<count;i++) {
  const caseSeed=replay?replaySeed:(seed+i)>>>0;
  const trace=replay?parseRecoveryTrace(replay.events??replay):generateRecoveryChaos(caseSeed,steps);
  try {
    const result=await simulateRecovery(trace,options);events+=result.events;wires+=result.wires;ready+=result.ready;
    for(const [key,value] of Object.entries(result.coverage))coverage[key]=(coverage[key]??0)+value;
  } catch(error) {
    const rule=error instanceof ChaosViolation?error.rule:"HARNESS_ERROR";
    const minimal=error instanceof ChaosViolation?await shrinkRecoveryFailure(trace,rule,options):trace;
    const artifact={schema:1,...provenance,seed:caseSeed,rule,mutant:values.mutant??null,error:error instanceof Error?error.message:String(error),events:trace};
    await writeFile(path.join(output,"failure.json"),JSON.stringify(artifact,null,2)+"\n");
    await writeFile(path.join(output,"failure-minimal.json"),JSON.stringify({...artifact,events:minimal},null,2)+"\n");
    console.error(JSON.stringify({passed:false,seed:caseSeed,rule,originalEvents:trace.length,minimizedEvents:minimal.length,output}));
    process.exitCode=1;break;
  }
}
if(!process.exitCode) {
  const result={schema:1,...provenance,passed:true,seed:replay?replaySeed:seed,cases:count,events,wires,ready,coverage,elapsedMs:Date.now()-started};
  await writeFile(path.join(output,"results.json"),JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify({...result,output}));
}
