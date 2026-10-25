import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { ChaosViolation, generateRecoveryChaos, parseRecoveryTrace, shrinkRecoveryFailure, simulateRecovery } from "../tests/protocol/fixtures/recovery-chaos";
const {values}=parseArgs({options:{seed:{type:"string",default:"20261025"},cases:{type:"string",default:"100"},steps:{type:"string",default:"120"},output:{type:"string"},replay:{type:"string"},mutant:{type:"string"}}});
function integer(value:string,name:string,maximum:number) {
  const n=Number(value);if(!Number.isSafeInteger(n) || n<0 || n>maximum) throw Error(`Invalid ${name}: expected an integer in 0..${maximum}`);return n;
}
const seed=integer(values.seed!,"seed",0xffffffff),cases=integer(values.cases!,"cases",100_000),steps=integer(values.steps!,"steps",10_000);
if(values.mutant && values.mutant!=="sticky-initialize") throw Error("Unknown negative control");
const options=values.mutant?{mutant:"sticky-initialize" as const}:{};
const output=path.resolve(values.output??path.join(process.env.TMPDIR??"/tmp",`opencraft-recovery-chaos-${process.pid}`));
await mkdir(output,{recursive:true});
const started=Date.now(),coverage:Record<string,number>={};let events=0,wires=0,ready=0;
const replay=values.replay?JSON.parse(await readFile(values.replay,"utf8")):null;
const count=replay?1:cases;
if(count===0) throw Error("At least one case is required");
for(let i=0;i<count;i++) {
  const caseSeed=replay?.seed===undefined?(seed+i)>>>0:integer(String(replay.seed),"replay seed",0xffffffff);
  const trace=replay?parseRecoveryTrace(replay.events??replay):generateRecoveryChaos(caseSeed,steps);
  try {
    const result=await simulateRecovery(trace,options);events+=result.events;wires+=result.wires;ready+=result.ready;
    for(const [key,value] of Object.entries(result.coverage))coverage[key]=(coverage[key]??0)+value;
  } catch(error) {
    const rule=error instanceof ChaosViolation?error.rule:"HARNESS_ERROR";
    const minimal=error instanceof ChaosViolation?await shrinkRecoveryFailure(trace,rule,options):trace;
    const artifact={schema:1,seed:caseSeed,rule,mutant:values.mutant??null,error:error instanceof Error?error.message:String(error),events:trace};
    await writeFile(path.join(output,"failure.json"),JSON.stringify(artifact,null,2)+"\n");
    await writeFile(path.join(output,"failure-minimal.json"),JSON.stringify({...artifact,events:minimal},null,2)+"\n");
    console.error(JSON.stringify({passed:false,seed:caseSeed,rule,originalEvents:trace.length,minimizedEvents:minimal.length,output}));
    process.exitCode=1;break;
  }
}
if(!process.exitCode) {
  const result={schema:1,passed:true,seed,cases:count,events,wires,ready,coverage,elapsedMs:Date.now()-started};
  await writeFile(path.join(output,"results.json"),JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify({...result,output}));
}
