import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, openSync, fsyncSync, closeSync, existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, rename } from "node:fs/promises";
import { createGzip, createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { RolloutDerivedTokenUsage } from "./token-usage-derived.js";
import { OpenCraftTokenUsageLedger } from "./token-usage-ledger.js";

export const LEGACY_PROJECTION_TABLES = ["token_usage_daily","token_usage_actor_daily","token_usage_turn_projections",
  "token_usage_turn_actor_projections","token_usage_projection_state","token_usage_allocations","token_usage_buckets"] as const;
const marker="legacy-projection-retired-v1";
const stringify=(value:unknown)=>JSON.stringify(value,(_,v)=>typeof v==="bigint"?{$integer:v.toString()}:v);
const parse=(value:string)=>JSON.parse(value,(_,v)=>v&&typeof v==="object"&&Object.keys(v).length===1&&typeof v.$integer==="string"?BigInt(v.$integer):v);
type Fingerprint=Record<string,{rows:number;sha256:string}>;
function statement(db:DatabaseSync,table:string,serverId:string,columns="*"){
  const fields=db.prepare(`PRAGMA table_info("${table}")`).all();
  const pk=fields.filter(f=>Number(f.pk)>0).sort((a,b)=>Number(a.pk)-Number(b.pk)).map(f=>`"${f.name}"`);
  const result=db.prepare(`SELECT ${columns} FROM "${table}" WHERE server_id=? ORDER BY ${pk.join(",")}`);
  result.setReadBigInts(true);return result;
}
function fingerprint(db:DatabaseSync,tables:readonly string[],serverId:string,semantic=false):Fingerprint{
  const result:Fingerprint={};
  for(const table of tables){
    const hash=createHash("sha256");let rows=0;
    for(const row of statement(db,table,serverId).iterate(serverId)){
      if(semantic&&table==="token_usage_turns")delete row.revision;
      if(semantic&&table==="token_usage_checkpoints"&&row.lineage===marker)continue;
      hash.update(stringify(row)+"\n");rows++;
    }
    result[table]={rows,sha256:hash.digest("hex")};
  }
  return result;
}
const projected=["token_usage_turns","token_usage_inputs","token_usage_allocations","token_usage_buckets",
  "token_usage_daily","token_usage_actor_daily","token_usage_turn_projections","token_usage_turn_actor_projections"];
async function drain(owner:RolloutDerivedTokenUsage){for(let i=0;i<1000000;i++){if(!await owner.step())return;await new Promise(resolve=>setImmediate(resolve));}throw new Error("Projection did not drain");}
/** Offline proof compares every turn, allocation, model bucket and aggregate.
 * Query revision/cursors and wall-clock gap timestamps are not token results. */
export async function proveTokenUsageRebuild(options:{directory:string;nativeHome:string;serverId:string}){
  const path=join(options.directory,"token-usage.sqlite");
  let current:RolloutDerivedTokenUsage|null=new RolloutDerivedTokenUsage({databasePath:path,...options});
  const temporary=await mkdtemp(join(options.directory,".usage-rebuild-proof-"));
  try{
    await drain(current);const before=fingerprint(current.database,projected,options.serverId,true);
    const coverage=(db:DatabaseSync)=>db.prepare("SELECT gap_key,thread_id,turn_id,reason,ends_ms IS NULL AS open FROM token_usage_gaps WHERE server_id=? ORDER BY gap_key").all(options.serverId);
    const gaps=coverage(current.database);current.close();current=null;
    const retained=new DatabaseSync(join(options.directory,"token-usage-retained.sqlite"));
    try{retained.exec("PRAGMA wal_checkpoint(TRUNCATE)");}finally{retained.close();}
    await copyFile(join(options.directory,"token-usage-retained.sqlite"),join(temporary,"token-usage-retained.sqlite"));
    const rebuilt=new RolloutDerivedTokenUsage({databasePath:path,nativeHome:options.nativeHome,serverId:options.serverId,directory:temporary});
    try{
      await drain(rebuilt);const after=fingerprint(rebuilt.database,projected,options.serverId,true);
      if(JSON.stringify(before)!==JSON.stringify(after)||JSON.stringify(gaps)!==JSON.stringify(coverage(rebuilt.database)))throw new Error("Rebuilt token results differ");
      return {identical:true,tables:before,coverage:gaps};
    }finally{rebuilt.close();}
  }finally{current?.close();await rm(temporary,{recursive:true,force:true});}
}
async function archiveHash(path:string){const hash=createHash("sha256");for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest("hex");}
async function readArchive(path:string,consume?:(table:string,row:Record<string,any>)=>void){
  const input=createReadStream(path),unzip=createGunzip();input.on("error",error=>unzip.destroy(error));input.pipe(unzip);
  const lines=createInterface({input:unzip,crlfDelay:Infinity});let header:any=null;
  const hashes=new Map<string,ReturnType<typeof createHash>>(),counts:Record<string,number>={};
  try{
    for await(const line of lines){
      const value=parse(line);
      if(!header){header=value;if(header.format!==1||JSON.stringify(header.tables)!==JSON.stringify(LEGACY_PROJECTION_TABLES))throw new Error("Invalid projection archive");
        for(const table of LEGACY_PROJECTION_TABLES){hashes.set(table,createHash("sha256"));counts[table]=0;}continue;}
      if(!hashes.has(value.table)||!value.row||typeof value.row!=="object")throw new Error("Invalid archived projection row");
      hashes.get(value.table)!.update(stringify(value.row)+"\n");counts[value.table]++;consume?.(value.table,value.row);
    }
    if(!header)throw new Error("Empty projection archive");
    for(const table of LEGACY_PROJECTION_TABLES)if(counts[table]!==header.fingerprints[table].rows||hashes.get(table)!.digest("hex")!==header.fingerprints[table].sha256)throw new Error("Projection archive checksum mismatch");
    return header;
  }finally{lines.close();input.destroy();unzip.destroy();}
}
/** Caller owns the existing physical Host writer lease for this entire offline operation. */
export async function retireLegacyTokenProjection(options:{directory:string;nativeHome:string;serverId:string;archivePath:string}){
  const archivePath=resolve(options.archivePath);
  const db=new DatabaseSync(join(options.directory,"token-usage.sqlite"));
  try{
    if(!db.prepare("SELECT 1 FROM token_usage_scopes WHERE server_id=?").get(options.serverId))throw new Error("Unknown usage server");
    if(db.prepare("SELECT 1 FROM token_usage_attempts WHERE server_id=? AND outcome='pending'").get(options.serverId))throw new Error("Reconcile pending attempts before retirement");
    const receipt=db.prepare("SELECT cursor FROM token_usage_checkpoints WHERE server_id=? AND lineage=?").get(options.serverId,marker);
    if(receipt){
      const previous=JSON.parse(String(receipt.cursor)),sha256=await archiveHash(archivePath),header=await readArchive(archivePath);
      if(previous.sha256!==sha256||header.serverId!==options.serverId)throw new Error("Archive does not match retirement receipt");
      for(const table of LEGACY_PROJECTION_TABLES)if(table!=="token_usage_projection_state"&&db.prepare(`SELECT 1 FROM "${table}" WHERE server_id=? LIMIT 1`).get(options.serverId))throw new Error("Projection restoration is in progress");
      db.exec("PRAGMA temp_store=MEMORY;PRAGMA wal_checkpoint(TRUNCATE);VACUUM;PRAGMA wal_checkpoint(TRUNCATE)");
      return {archivePath,sha256,proof:header.proof,fingerprints:header.fingerprints};
    }
    if(existsSync(archivePath))throw new Error("Projection archive already exists");
    const proof=await proveTokenUsageRebuild(options);
    const fingerprints=fingerprint(db,LEGACY_PROJECTION_TABLES,options.serverId);
    const schemas=Object.fromEntries(LEGACY_PROJECTION_TABLES.map(table=>[table,db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table)!.sql]));
    const header={format:1,serverId:options.serverId,tables:LEGACY_PROJECTION_TABLES,schemas,fingerprints,proof};
    const temporary=archivePath+".partial-"+process.pid;
    async function* records(){yield stringify(header)+"\n";for(const table of LEGACY_PROJECTION_TABLES)for(const row of statement(db,table,options.serverId).iterate(options.serverId))yield stringify({table,row})+"\n";}
    await pipeline(Readable.from(records()),createGzip(),createWriteStream(temporary,{flags:"wx",mode:0o600}));
    const fd=openSync(temporary,"r");try{fsyncSync(fd);}finally{closeSync(fd);}
    await readArchive(temporary);await rename(temporary,archivePath);
    const directoryFd=openSync(dirname(archivePath),"r");try{fsyncSync(directoryFd);}finally{closeSync(directoryFd);}
    const sha256=await archiveHash(archivePath);
    db.exec("BEGIN IMMEDIATE");
    try{
      // The verified offline snapshot must still be the exact rows removed.
      if(JSON.stringify(fingerprints)!==JSON.stringify(fingerprint(db,LEGACY_PROJECTION_TABLES,options.serverId)))throw new Error("Projection changed during backup");
      for(const table of LEGACY_PROJECTION_TABLES)db.prepare(`DELETE FROM "${table}" WHERE server_id=?`).run(options.serverId);
      db.prepare("INSERT INTO token_usage_checkpoints VALUES(?,?,?)").run(options.serverId,marker,JSON.stringify({archivePath,sha256}));db.exec("COMMIT");
    }catch(error){db.exec("ROLLBACK");throw error;}
    db.exec("PRAGMA temp_store=MEMORY;PRAGMA wal_checkpoint(TRUNCATE);VACUUM;PRAGMA wal_checkpoint(TRUNCATE)");
    return {archivePath,sha256,proof,fingerprints};
  }finally{db.close();}
}
export async function restoreLegacyTokenProjection(options:{directory:string;serverId:string;archivePath:string}){
  const header=await readArchive(options.archivePath),sha256=await archiveHash(options.archivePath);
  if(header.serverId!==options.serverId)throw new Error("Archive server mismatch");
  const db=new DatabaseSync(join(options.directory,"token-usage.sqlite"));
  try{
    const row=db.prepare("SELECT cursor FROM token_usage_checkpoints WHERE server_id=? AND lineage=?").get(options.serverId,marker);
    if(!row||JSON.parse(String(row.cursor)).sha256!==sha256)throw new Error("Archive does not match retirement receipt");
    for(const table of LEGACY_PROJECTION_TABLES)if(db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table)?.sql!==header.schemas[table])throw new Error("Projection schema differs from archive");
    db.exec("BEGIN IMMEDIATE");
    try{
      for(const table of LEGACY_PROJECTION_TABLES)db.prepare(`DELETE FROM "${table}" WHERE server_id=?`).run(options.serverId);
      const inserts=new Map<string,ReturnType<DatabaseSync["prepare"]>>();
      await readArchive(options.archivePath,(table,row)=>{
        if(row.server_id!==options.serverId)throw new Error("Archived row scope mismatch");
        let insert=inserts.get(table);
        if(!insert){const columns=db.prepare(`PRAGMA table_info("${table}")`).all().map(field=>String(field.name));if(JSON.stringify(columns)!==JSON.stringify(Object.keys(row)))throw new Error("Archive columns differ");
          insert=db.prepare(`INSERT INTO "${table}" VALUES(${columns.map(()=>"?").join(",")})`);inserts.set(table,insert);}
        insert.run(...Object.values(row));
      });
      const restored=fingerprint(db,LEGACY_PROJECTION_TABLES,options.serverId);
      if(JSON.stringify(restored)!==JSON.stringify(header.fingerprints))throw new Error("Restored projection rows differ from backup");
      db.prepare("INSERT INTO token_usage_projection_state VALUES(?,0,'','') ON CONFLICT(server_id) DO UPDATE SET ready=0,cursor_thread='',cursor_turn=''").run(options.serverId);
      db.exec("COMMIT");
    }catch(error){db.exec("ROLLBACK");throw error;}
    const ledger=new OpenCraftTokenUsageLedger({database:db,transaction(body){db.exec("BEGIN IMMEDIATE");try{const result=body();db.exec("COMMIT");return result;}catch(error){db.exec("ROLLBACK");throw error;}}},options.serverId,Date.now,undefined,{projectLegacy:true});
    while(!ledger.backfillProjectionBatch(32,true))await new Promise(resolve=>setImmediate(resolve));
    db.prepare("DELETE FROM token_usage_checkpoints WHERE server_id=? AND lineage=?").run(options.serverId,marker);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");return {restored:true,restoredProjectionExact:true,archivePath:resolve(options.archivePath),sha256};
  }finally{db.close();}
}
