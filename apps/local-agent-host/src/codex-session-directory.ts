import {readdir,readFile,stat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {containedNativeHistoryPath} from './codex-history-sources.js';

let namedIndex: {home:string;stamp:string;names:Map<string,string>} | undefined;
async function sessionNames(home:string) {
 const path=join(home,'session_index.jsonl');
 const info=await stat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 if(!info)return new Map<string,string>();
 const stamp=JSON.stringify([info.dev,info.ino,info.size,info.mtimeMs]);
 if(namedIndex?.home===home&&namedIndex.stamp===stamp)return namedIndex.names;
 if(info.size>64*1024*1024)throw new Error('Native name index too large');
 const bytes=await readFile(await containedNativeHistoryPath(home,path));
 if(bytes.length>64*1024*1024)throw new Error('Native name index too large');
 const names=new Map<string,string>();
 for(const line of bytes.toString('utf8').split('\n')){
  if(!line.trim())continue;
  let row;try{row=JSON.parse(line);}catch{continue;} // An active native writer may leave a partial tail.
  if(typeof row.id==='string'&&/^[-a-f0-9]{36}$/u.test(row.id)&&typeof row.thread_name==='string'&&row.thread_name.trim())names.set(row.id,row.thread_name.trim());
 }
 namedIndex={home,stamp,names};return names;
}

/** Native Codex metadata mirror, read only and called exclusively by the history Worker. */
export async function codexSessionDirectory(home:string, cursor?:string, archived=false) {
 const files=await readdir(home,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
 const index=files.filter(e=>e.isFile()&&/^state_\d+\.sqlite$/u.test(e.name)).sort((a,b)=>Number(b.name.match(/\d+/u)![0])-Number(a.name.match(/\d+/u)![0]))[0];
 if(!index)return {available:false,sessions:[],nextCursor:null};
 const names=await sessionNames(home);
 const db=new DatabaseSync(await containedNativeHistoryPath(home,join(home,index.name)),{readOnly:true});
 try{
  const columns=new Set((db.prepare('PRAGMA table_info(threads)').all() as {name:string}[]).map(c=>c.name));
  if(!['id','cwd','title','updated_at','created_at','archived'].every(c=>columns.has(c)))throw new Error('Unsupported Codex session index');
  const updated=columns.has('updated_at_ms')?'COALESCE(updated_at_ms,updated_at*1000)':'updated_at*1000';
  const created=columns.has('created_at_ms')?'COALESCE(created_at_ms,created_at*1000)':'created_at*1000';
  const titles=['name','title','first_user_message'].filter(c=>columns.has(c)).map(c=>`NULLIF(TRIM(${c}),'')`);
  const title=titles.length>1?`COALESCE(${titles.join(',')})`:titles[0];
  let boundary:{at:number;id:string;archived:boolean}|undefined;
  if(cursor){boundary=JSON.parse(Buffer.from(cursor,'base64url').toString());if(!boundary||!Number.isSafeInteger(boundary.at)||typeof boundary.id!=='string'||!/^[-a-f0-9]{36}$/u.test(boundary.id)||boundary.archived!==archived)throw new Error('Invalid native directory cursor');}
  // Child/attached worker threads are context, not user-facing resume choices.
  const scope=[ 'archived=?',...(columns.has('source')?["(CASE WHEN json_valid(source) THEN json_type(source,'$.subagent') ELSE NULL END) IS NULL AND COALESCE(source,'') NOT IN ('subagent','memory_consolidation')"]:[]),...(columns.has('attached_thread_parent_id')?['attached_thread_parent_id IS NULL']:[])];
  const args:(string|number)[]=[archived?1:0];
  if(boundary){scope.push(`(${updated} < ? OR (${updated} = ? AND id < ?))`);args.push(boundary.at,boundary.at,boundary.id);}
  const rows=db.prepare(`SELECT id,cwd,${columns.has('name')?'name':'NULL'} AS native_name,${title} AS label,${updated} AS updated,${created} AS created FROM threads WHERE ${scope.join(' AND ')} ORDER BY ${updated} DESC,id DESC LIMIT 201`).all(...args) as {id:string;cwd:string;label:string|null;native_name:string|null;updated:number;created:number}[];
  const page=rows.slice(0,200),sessions=page.map(row=>{
   if(!/^[-a-f0-9]{36}$/u.test(row.id)||!isAbsolute(row.cwd)||!Number.isSafeInteger(row.updated)||!Number.isSafeInteger(row.created))throw new Error('Invalid native session index entry');
   return {sessionId:row.id,cwd:row.cwd,title:(row.native_name?.trim() || names.get(row.id) || row.label)?.replace(/\s+/gu,' ').trim().slice(0,256)||null,updatedAt:new Date(row.updated).toISOString(),createdAt:new Date(row.created).toISOString()};
  });
  const last=page.at(-1);
  return {available:true,sessions,nextCursor:rows.length>200&&last?Buffer.from(JSON.stringify({at:last.updated,id:last.id,archived})).toString('base64url'):null};
 }finally{db.close();}
}

/** Discover native homes without consulting credentials or shell configuration. */
export async function codexHistoryHomes(configuredHome: string, discoveryRoot?:string) {
  const {readdir, realpath, stat} = await import("node:fs/promises");
  const {homedir} = await import("node:os");
  const {join} = await import("node:path");
  const {createHash} = await import("node:crypto");
  const configured = await realpath(configuredHome).catch(() => configuredHome);
  const names = await readdir(discoveryRoot ?? homedir(), {withFileTypes:true});
  const candidates = [configured, ...names.filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && /^\.codex(?:[-_a-zA-Z0-9].*)?$/u.test(entry.name)).map(entry => join(discoveryRoot ?? homedir(), entry.name))];
  const seen = new Set<string>();
  const sources: {id:string;path:string;configured:boolean;hasNames:boolean}[] = [];
  for (const candidate of candidates.slice(0, 100)) {
    const path = await realpath(candidate).catch(() => null);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (path !== configured && !(await stat(join(path,"sessions")).catch(() => null))?.isDirectory()) continue;
    sources.push({id:path === configured ? "default" : createHash("sha256").update(path).digest("hex").slice(0,24),path,configured:path===configured,hasNames:(await stat(join(path,"session_index.jsonl")).catch(() => null))?.isFile() === true});
  }
  return {sources};
}
