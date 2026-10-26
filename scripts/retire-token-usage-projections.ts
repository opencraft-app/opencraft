import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireCodexWriter } from "@opencraft/account-pool-host";
import { retireLegacyTokenProjection, restoreLegacyTokenProjection, proveTokenUsageRebuild } from "../apps/opencraft-daemon/src/token-usage-projection-retirement.js";
const {values}=parseArgs({options:{"data-dir":{type:"string"},"server-id":{type:"string"},"native-home":{type:"string"},archive:{type:"string"},apply:{type:"boolean"},restore:{type:"boolean"},help:{type:"boolean"}}});
async function main(){
 if(values.help){console.log("Usage: npx tsx scripts/retire-token-usage-projections.ts --data-dir DIR --server-id ID --native-home DIR [--apply --archive FILE.jsonl.gz | --restore --archive FILE.jsonl.gz]\nStop both Headless and the physical Host first. Default verifies an exact rebuild. Retained backups are never removed. Restore finishes before selecting ledger and restarting the Host.");return;}
 if(!values["data-dir"]||!values["server-id"]||(!values.restore&&!values["native-home"])||((values.apply||values.restore)&&!values.archive)||values.apply&&values.restore)throw new Error("Explicit target and operation arguments are required");
 const directory=resolve(values["data-dir"]),serverId=values["server-id"];
 const probe=new DatabaseSync(join(directory,"token-usage.sqlite"),{readOnly:true});probe.close();
 const release=await acquireCodexWriter(directory);let overlays:(()=>void)|undefined;
 try{
  overlays=await acquireCodexWriter(join(directory,"host-overlays-owner"));
  const options={directory,serverId,nativeHome:resolve(values["native-home"]??directory),archivePath:values.archive?resolve(values.archive):""};
  const result=values.restore?await restoreLegacyTokenProjection(options):values.apply?await retireLegacyTokenProjection(options):await proveTokenUsageRebuild(options);
  console.log(JSON.stringify(result,null,2));
 }finally{overlays?.();release();}
}
void main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
