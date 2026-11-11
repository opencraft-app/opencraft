import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexOwnerConnection } from '../../apps/agent-bridge-host/src/codex-owner';
import { CodexBridgeRuntime } from '../../apps/agent-bridge-host/src/codex-runtime';

const environment={OPENCRAFT_THREAD_CLI:'reserved-execution-launcher',PATH:'reserved-path'};
const settings={sandbox:{type:'workspaceWrite',writableRoots:['/allowed'],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true},approvalPolicy:'on-request',approvalsReviewer:'user',model:'fixture',reasoningEffort:'low'};
function fixture(options:{history?:boolean;duringRead?:(owner:CodexOwnerConnection,includeTurns:boolean)=>boolean|void}={}) {
  const calls:{method:string;params:any}[]=[];
  let loaded=true,history=options.history??false;
  const owner=new CodexOwnerConnection('/unused','unused',()=>{},()=>{},()=>{});
  (owner as any).write=(frame:any)=>{
    calls.push(frame);queueMicrotask(()=>{
      const reply=(result:any)=>(owner as any).receive({id:frame.id,result});
      if(frame.method==='thread/start')return reply({...settings,thread:{id:'native',status:{type:'idle'},turns:[]}});
      if(frame.method==='thread/read'){
        if(options.duringRead?.(owner,frame.params.includeTurns===true))history=true;
        if(frame.params.includeTurns&&!history)return (owner as any).receive({id:frame.id,error:{code:-32600,message:'thread native is not materialized yet; includeTurns is unavailable before first user message'}});
        return reply({thread:{status:{type:loaded?'idle':'notLoaded'},turns:frame.params.includeTurns&&history?[{id:'existing'}]:[]}});
      }
      if(frame.method==='thread/resume'){if(!history)return (owner as any).receive({id:frame.id,error:{code:-32600,message:'no rollout found for thread id native'}});return reply(settings);}
      if(frame.method==='thread/unsubscribe'){loaded=false;return reply({status:'unsubscribed'});}
      if(frame.method==='turn/start'){history=true;return reply({turn:{id:'first-turn'}});}
      reply({});
    });
  };
  const frames:any[]=[];
  const runtime=new CodexBridgeRuntime(owner,f=>frames.push(f));
  const create=async(config:Record<string,unknown>={})=>{
    await runtime.handle({jsonrpc:'2.0',id:'init',method:'initialize',params:{protocolVersion:1,grammarRange:{min:1,max:1}}});
    await runtime.handle({jsonrpc:'2.0',id:'create',method:'session/create',params:{threadId:'canonical',cliEnvironment:environment,native:{cwd:'/workspace',sandbox:'workspace-write',approvalPolicy:'on-request',approvalsReviewer:'user',config:{model_reasoning_effort:'low',...config}}}});
    assert.equal(frames.find(f=>f.id==='create').error,undefined);
  };
  return {owner,calls,frames,runtime,create};
}

test('first admitted Turn uses creation-installed namespace, preserving identity and permissions without native mutations',async()=>{
  const f=fixture();await f.create();
  await f.runtime.handle({jsonrpc:'2.0',id:'start',method:'turn/start',params:{threadId:'canonical',native:{input:[{type:'text',text:'hello'}]},cliEnvironment:environment}});
  assert.equal(f.frames.find(r=>r.id==='start').error,undefined);
  assert.equal(f.calls.filter(c=>c.method==='thread/start').length,1);
  assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);
  assert.ok(!f.calls.some(c=>['thread/resume','thread/unsubscribe','thread/delete','thread/settings/update'].includes(c.method)));
  const native=f.calls.find(c=>c.method==='thread/start')!.params;
  assert.deepEqual(native.config['shell_environment_policy.set'],environment);
  assert.equal(native.config.model_reasoning_effort,'low');assert.equal(native.historyMode,'legacy');
  assert.equal(native.sandbox,'workspace-write');assert.equal(native.approvalPolicy,'on-request');assert.equal(native.approvalsReviewer,'user');
  assert.equal(f.runtime.adapter.nativeSession('canonical'),'native');
  const identities=f.frames.filter(r=>r.method==='thread/identity');
  assert.equal(identities.length,1);assert.equal(identities[0].params.providerThreadId,'native');
});

test('a created thread with materialized history keeps native identity and the existing resume path',async()=>{
  const f=fixture({history:true});await f.create();
  await f.owner.configureExecution('native',environment);
  assert.ok(f.calls.some(c=>c.method==='thread/read'&&c.params.includeTurns));
  assert.equal(f.calls.filter(c=>c.method==='thread/start').length,1);
  assert.equal(f.calls.filter(c=>c.method==='thread/resume').length,2);
  const apply=f.calls.filter(c=>c.method==='thread/resume').at(-1)!.params;
  assert.equal(apply.threadId,'native');assert.equal(apply.approvalPolicy,'on-request');
  const restore=f.calls.find(c=>c.method==='thread/settings/update')!.params;
  assert.deepEqual(restore.sandboxPolicy,settings.sandbox);assert.equal(restore.approvalsReviewer,'user');
});

test('a native Turn observed during the history read defeats creation evidence',async()=>{
  let notified=false;
  const f=fixture({duringRead(owner,includeTurns){if(includeTurns&&!notified){notified=true;(owner as any).receive({method:'turn/started',params:{threadId:'native',turn:{id:'external'}}});}}});
  await f.create();await assert.rejects(f.owner.configureExecution('native',environment));
  assert.equal(f.calls.filter(c=>c.method==='thread/start').length,1);
  assert.equal(f.calls.filter(c=>c.method==='thread/resume').length,1);
  assert.ok(!f.calls.some(c=>c.method==='turn/start'));
});

test('different first-Turn environment refuses before input, without permanently fencing a safe retry',async()=>{
  const f=fixture();await f.create();
  await assert.rejects(f.owner.configureExecution('native',{...environment,OPENCRAFT_THREAD_CLI:'wrong'}),/cliUnavailable/);
  await f.owner.configureExecution('native',environment);
  assert.equal(f.calls.filter(c=>c.method==='thread/start').length,1);
  assert.ok(!f.calls.some(c=>['turn/start','thread/settings/update','thread/unsubscribe'].includes(c.method)));
});

test('an expired preparation deadline cannot mutate or lock the initial allocation',async()=>{
  const f=fixture();await f.create();const before=f.calls.length;
  await assert.rejects(f.owner.configureExecution('native',environment,Date.now()-1),/cliUnavailable/);
  assert.equal(f.calls.length,before);
  await f.owner.configureExecution('native',environment);
});

test('an initial MCP configuration must match the already-installed reservation',async()=>{
  const f=fixture();await f.create();
  await assert.rejects(f.owner.configureExecution('native',environment,undefined,{url:'http://127.0.0.1:1/mcp',http_headers:{Authorization:'uninstalled'}}),/cliUnavailable/);
  await f.owner.configureExecution('native',environment,undefined,null);
  assert.ok(!f.calls.some(c=>c.method==='thread/resume'||c.method==='thread/settings/update'));
});


test('first-Turn preparation never rewrites a named permission profile',async()=>{
  const f=fixture();
  await f.owner.request('thread/start',{cwd:'/workspace',permissions:'restricted-profile',config:{'shell_environment_policy.set':environment}});
  await f.owner.configureExecution('native',environment);
  assert.equal(f.calls[0].params.permissions,'restricted-profile');
  assert.ok(!f.calls.some(c=>['thread/settings/update','thread/resume','thread/unsubscribe','thread/delete'].includes(c.method)));
});

test('an explicitly refused native first input keeps its known configuration for a safe retry',async()=>{
  const f=fixture();await f.create();
  const write=(f.owner as any).write;
  (f.owner as any).write=(frame:any)=>frame.method==='turn/start'
    ?queueMicrotask(()=>(f.owner as any).receive({id:frame.id,error:{code:-32602,message:'invalid input'}}))
    :write(frame);
  await assert.rejects(f.owner.request('turn/start',{threadId:'native',input:[]}));
  await f.owner.configureExecution('native',environment);
  assert.equal(f.calls.filter(c=>c.method==='thread/start').length,1);
  assert.ok(!f.calls.some(c=>c.method==='thread/resume'));
});


test('installing the initial launcher preserves unrelated explicit shell environment settings',async()=>{
  const f=fixture();await f.create({'shell_environment_policy.set':{EXPLICIT_SETTING:'kept'}});
  await f.owner.configureExecution('native',environment);
  assert.equal(f.calls.find(c=>c.method==='thread/start')!.params.config['shell_environment_policy.set'].EXPLICIT_SETTING,'kept');
  assert.ok(!f.calls.some(c=>c.method==='thread/resume'));
});

test('busy and unrelated native history failures cannot authorize a first Turn',async()=>{
  for(const mode of ['busy','unknown'] as const){
    const f=fixture();await f.create();const write=(f.owner as any).write;
    (f.owner as any).write=(frame:any)=>{
      if(frame.method!=='thread/read')return write(frame);
      queueMicrotask(()=>(f.owner as any).receive(mode==='busy'
        ?{id:frame.id,result:{thread:{status:{type:'active'}}}}
        :{id:frame.id,error:{code:-32000,message:'history unavailable'}}));
    };
    await assert.rejects(f.owner.configureExecution('native',environment));
    assert.ok(!f.calls.some(c=>['turn/start','thread/resume','thread/settings/update','thread/unsubscribe'].includes(c.method)));
  }
});

test('closing an empty session removes its creation evidence',async()=>{
  const f=fixture();await f.create();await f.runtime.handle({jsonrpc:'2.0',id:'close',method:'session/close',params:{threadId:'canonical'}});
  assert.equal(f.frames.find(r=>r.id==='close').error,undefined);
  await assert.rejects(f.owner.configureExecution('native',environment));
  assert.equal(f.calls.filter(c=>c.method==='thread/resume').length,1);
});

test('a preauthorized platform tool keeps its creation-installed first-Turn approval policy',async()=>{
  const f=fixture(),configuration={url:'http://127.0.0.1:1/mcp',http_headers:{Authorization:'reserved'},tools:{approved_read:{approval_mode:'approve'}}};
  await f.create({'mcp_servers.opencraft_session':configuration});
  await f.owner.configureExecution('native',environment,undefined,configuration);
  assert.deepEqual(f.calls.find(c=>c.method==='thread/start')!.params.config['mcp_servers.opencraft_session'],configuration);
  assert.ok(!f.calls.some(c=>['thread/resume','thread/settings/update'].includes(c.method)));
});
