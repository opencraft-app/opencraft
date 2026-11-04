import assert from 'node:assert/strict';
import test from 'node:test';
import {liveDirectoryMetadata} from '../../apps/local-agent-host/src/dsh-directory-metadata.mjs';
import {DshAppServerAdapter} from '../../apps/local-agent-host/src/dsh-appserver-adapter.js';

test('live metadata reads only requested cached projection columns, with no history or persistence access',()=>{
 const touched:string[]=[];
 const ctx={sessions:{get(id:string){touched.push(id);return id==='cold'?undefined:{id,header:{createdAt:100,cwd:'/synthetic'},get events(){throw Error('history must not be read');}};}},
 agents:{get:()=>({status:'running'})},get(name:string){assert.equal(name,'sessionProjections');return{snapshot:()=>({asOfSeq:20,values:{sessionListMetadata:{blank:false,lastPromptAt:200},title:'new name',privateInstructions:'never export',toolResults:'never export'}})};}};
 const result=liveDirectoryMetadata(ctx,['live','cold','live']);
 assert.deepEqual(touched,['live','cold']);assert.deepEqual(result.missing,['cold']);
 assert.equal(result.items[0].updatedAt,200);assert.equal(result.items[0].running,true);
 assert.deepEqual(result.items[0].projections.values,{title:'new name'});
 assert.throws(()=>liveDirectoryMetadata(ctx,Array.from({length:65},(_,i)=>String(i))),/Invalid/);
});

test('absent or corrupt live metadata reports missing and never fabricates a summary',()=>{
 const ctx={sessions:{get:()=>({header:{createdAt:10}})},agents:{get:()=>undefined},get:()=>({snapshot:()=>({values:{sessionListMetadata:{blank:false,lastPromptAt:'bad'}}})})};
 assert.deepEqual(liveDirectoryMetadata(ctx,['a']),{items:[],missing:['a']});
});

test('hot dirty batches avoid session.list; overlapping cold fallbacks share one full source read',async t=>{
 let full=0,release:()=>void=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const summary=(id:string)=>({sessionId:id,updatedAt:200,running:false,blank:false,cwd:'/synthetic',projections:{asOfSeq:1,values:{title:id}}});
 const adapter=new DshAppServerAdapter({call:async(method:string)=>{assert.equal(method,'session.list');full++;await gate;return{items:[summary('cold')]};}} as any);
 t.after(()=>adapter.close());
 adapter.setDirectoryMetadataReader(async ids=>({items:ids.filter(id=>id!=='cold').map(summary),missing:ids.filter(id=>id==='cold')}));
 const hot=await adapter.directoryMetadata(['hot']);assert.equal(hot[0].name,'hot');assert.equal(full,0);
 const a=adapter.directoryMetadata(['hot','cold']),b=adapter.directoryMetadata(['cold']);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(full,1);release();
 assert.deepEqual((await a).map(row=>row.id),['hot','cold']);assert.deepEqual((await b).map(row=>row.id),['cold']);
});
