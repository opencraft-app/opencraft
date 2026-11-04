import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {historyReadTiming} from "./history-read-timing.js";

/** Counts API executions and rows returned, never rows scanned or bind values. */
export class SqlObservation {
  calls=0; rows=0; ms=0; maxMs=0; errors=0; prepareCalls=0; prepareMs=0; overflow=0;
  maxFingerprint?: string;
  private readonly queries=new Map<string,{calls:number;rows:number;ms:number}>();
  record(fingerprint:string,ms:number,rows:number,error:boolean,calls=1) {
    this.calls+=calls;this.rows+=rows;this.ms+=ms;this.errors+=error?1:0;
    if(ms>this.maxMs){this.maxMs=ms;this.maxFingerprint=fingerprint;}
    let query=this.queries.get(fingerprint);
    if(!query && this.queries.size<64){query={calls:0,rows:0,ms:0};this.queries.set(fingerprint,query);}
    if(query){query.calls+=calls;query.rows+=rows;query.ms+=ms;}else this.overflow+=calls;
  }
  summary():Record<string,string|number> {
    const top=[...this.queries].sort((a,b)=>b[1].ms-a[1].ms)[0];
    return {sqlCalls:this.calls,sqlRows:this.rows,sqlMs:this.ms,sqlMaxMs:this.maxMs,sqlErrors:this.errors,
      sqlPrepareCalls:this.prepareCalls,sqlPrepareMs:this.prepareMs,sqlFingerprintOverflow:this.overflow,
      ...(this.maxFingerprint?{sqlMaxFingerprint:this.maxFingerprint}:{}),
      ...(top?{sqlTopFingerprint:top[0],sqlTopCalls:top[1].calls,sqlTopRows:top[1].rows,sqlTopMs:top[1].ms}: {})};
  }
}
export function sqlFingerprint(sql:string):string {
  const shape=sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//gu," ").replace(/'(?:''|[^'])*'/gu,"?")
    .replace(/\b\d+(?:\.\d+)?\b/gu,"?").replace(/\s+/gu," ").trim().toLowerCase();
  return createHash("sha256").update(shape).digest("hex").slice(0,16);
}
const installed=new WeakSet<DatabaseSync>();
const capture=()=>{const trace=historyReadTiming.getStore();return trace?.active?trace.sql:undefined;};
/** Native receivers stay bound to the real object. Diagnostics cannot affect settlement. */
export function observeSqlite(database:DatabaseSync):void {
  if(installed.has(database))return;installed.add(database);
  const prepare=database.prepare.bind(database),exec=database.exec.bind(database),fingerprints=new Map<string,string>();
  const fingerprintOf=(sql:string)=>{let value=fingerprints.get(sql);if(value)return value;value=sqlFingerprint(sql);if(sql.length<=8192){if(fingerprints.size>=256)fingerprints.delete(fingerprints.keys().next().value!);fingerprints.set(sql,value);}return value;};
  const timed=<T>(fingerprint:string,run:()=>T,rows:(value:T)=>number,calls=1):T=>{
    const observation=capture();if(!observation)return run();
    const start=performance.now();let count=0,error=true;
    try{const value=run();error=false;count=rows(value);return value;}
    finally{try{observation.record(fingerprint,performance.now()-start,count,error,calls);}catch{/* Observation only. */}}
  };
  database.prepare=(...args:Parameters<DatabaseSync["prepare"]>)=>{
    const observation=capture(),start=observation?performance.now():0;
    let statement;
    try{statement=prepare(...args);}finally{if(observation){observation.prepareCalls++;observation.prepareMs+=performance.now()-start;}}
    const fingerprint=fingerprintOf(args[0]);
    return new Proxy(statement,{get(target,key){
      const value=Reflect.get(target,key,target);if(typeof value!=="function")return value;
      if(key==="all"||key==="get"||key==="run")return(...params:unknown[])=>timed(fingerprint,()=>value.apply(target,params),
        result=>key==="all"?result.length:key==="get"&&result!==undefined?1:0);
      if(key==="iterate")return(...params:unknown[])=>{
        const iterator=value.apply(target,params);let started=false;
        const observedIterator:IterableIterator<unknown>=new Proxy(iterator,{get(iter,method){const fn=Reflect.get(iter,method,iter);
          if(method==="next")return(...input:unknown[])=>{const calls=started?0:1;started=true;return timed(fingerprint,()=>fn.apply(iter,input),result=>result.done?0:1,calls);};
          if(method===Symbol.iterator)return()=>observedIterator;
          return typeof fn==="function"?fn.bind(iter):fn;
        }});
        return observedIterator;
      };
      return value.bind(target);
    }});
  };
  database.exec=(...args:Parameters<DatabaseSync["exec"]>)=>timed(fingerprintOf(args[0]),()=>exec(...args),()=>0);
}
