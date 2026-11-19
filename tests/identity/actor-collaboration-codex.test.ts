import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorStore } from "../../packages/access-control/src/actors";
import { Collaboration } from "../../packages/access-control/src/collaboration";
import { AppHostServer } from "../../packages/app-host-server/src/index";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter";
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import { createConversationExecution } from "../../scripts/conversation-execution.mjs";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'actor-codex-'));
  const actors = new ActorStore(join(root, 'actors.sqlite'));
  const a = actors.createSession('source', 'operator'), b = actors.createSession('target', 'operator');
  const credential = actors.issueCredential(a.id, Date.now() + 60_000, 'operator');
  const context = actors.authenticateSession(credential.token)!;
  let service!: Collaboration;
  const frames: any[] = [];
  const adapter = new CodexEngineAdapter({ executable: process.execPath, runtimeDirectory: root, dataDirectory: join(root, 'data'), nativeCodexHomeDirectory: join(root, 'native'),
    upstreamBaseUrl: 'http://127.0.0.1:9/backend-api/codex', fetch: async () => Response.json({ ok: true }),
    spawnAppServer: ({ cwd, env }) => spawn(process.execPath, [new URL("../fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).pathname], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }),
    createMaintenanceClient: async () => { throw new Error('not used'); }, logDiagnostic: () => {},
    collaboration: {
      queuedContext: (thread,inputId,input)=>service.queuedReferenceContext(thread,inputId,input),
      continued: (thread,previous,turn)=>service.executionContinued(thread,previous,turn),
      prepare: (context,input)=>service.referenceContext(context,input),
      canCancel: (context,id)=>service.canCancel(context,id),
      command: (context,body)=>service.command(context,body), authorize:(context,thread,input)=>service.authorizeExecution(context,thread,input), started:(thread,input,turn)=>service.executionStarted(thread,input,turn), tool:(thread,turn,name,args)=>service.tool(thread,turn,name,args),
    },
    collaborationInput: { available: () => service.available, mode: id => service.inputMode(id), authorize: (thread, id, mode, turn) => service.authorizeInput(thread, id, mode, turn) },
  });
  adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  const host = new AppHostServer({ physicalHostLifetime: 'server', logicalClientRouting: true, createTransport: () => adapter });
  service = new Collaboration(join(root, 'collaboration.sqlite'), actors, createConversationExecution(() => host, {serverId:"fixture",hostId:"local-codex"}));
  t.after(async () => { await service.close(); await host.close(); actors.close(); await rm(root, { recursive: true, force: true }); });
  await host.ensureHostConnected('local-codex');
  let next = 0;
  const rpc = async (method: string, params: any = {}, trusted?: string, raw = false, actor?: any) => {
    const id = `controller-${next++}`, frame = JSON.stringify({ id, method, params, collaborationRequestId: trusted, [LOGICAL_CLIENT_FIELD]: 'controller' });
    if (raw || (!trusted && !actor)) await adapter.send(frame);
    else await adapter.sendWithContext(frame, { sender: null, collaborationRequestId: trusted, actorContext:actor });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) { const result = frames.find(f => f.id === id); if (result) return result; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error('RPC timeout: ' + method);
  };
  assert.ok((await rpc('initialize')).result);
  const started = await rpc('thread/start', { cwd: root, testNoServerRequest: true });
  const threadId = started.result.thread.id;
  await service.bind(b.id, threadId, 0, () => {});
  for (const action of ['message.send', 'execution.queue', 'execution.steer']) actors.setGrant(a.id, b.id, action, true, 'operator');
  let key = 0;
  const send = (mode: 'queue' | 'steer', expectedTurnId?: string) => service.send(context, { targetActorId: b.id, content: 'review the tests', idempotencyKey: `key-${key++}`, execution: { mode, ...(expectedTurnId ? { expectedTurnId } : {}) } });
  const settle = async (id: string, state: string) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) { await service.pump(); if (service.getRequest(context, id).state === state) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(service.getRequest(context, id).state, state);
  };
  return { root, actors, a, b, context, service, host, rpc, threadId, send, settle };
}

test('real AppHost lane dispatches once, waits behind a busy Turn, and fences revocation before queue claim', async t => {
  const f = await fixture(t), first = f.send('queue');
  await f.settle(first.requestId!, 'injected');
  const queued = f.send('queue'); await f.service.pump();
  assert.equal(f.service.getRequest(f.context, queued.requestId!).state, 'queued');
  f.actors.setGrant(f.a.id, f.b.id, 'execution.queue', false, 'operator');
  await f.rpc('test/completeTurn', { threadId: f.threadId });
  await f.settle(queued.requestId!, 'rejected');
  const items = (await f.rpc('thread/items/list', { threadId: f.threadId })).result.data;
  assert.equal(items.length, 1); assert.equal(items[0].item.clientId, 'actor-input:' + first.requestId);
});

test('real steer is exact-Turn input; stale Turn is rejected and never auto-starts later', async t => {
  const f = await fixture(t);
  const initial = await f.rpc('turn/start', { threadId: f.threadId, input: [{ type: 'text', text: 'initial' }] });
  const turnId = initial.result.turn.id;
  const good = f.send('steer', turnId); await f.settle(good.requestId!, 'injected');
  const bad = f.send('steer', 'ended-turn'); await f.settle(bad.requestId!, 'rejected');
  await f.rpc('test/completeTurn', { threadId: f.threadId });
  const queued = f.send('queue'); await f.settle(queued.requestId!, 'injected');
  const items = (await f.rpc('thread/items/list', { threadId: f.threadId })).result.data;
  assert.equal(items.filter((i: any) => i.item.clientId === 'actor-input:' + good.requestId).length, 1);
  assert.equal(items.some((i: any) => i.item.clientId === 'actor-input:' + bad.requestId), false);
});

test('wire fields cannot forge trusted Actor queue admission or mutate a managed input', async t => {
  const f = await fixture(t);
  await f.rpc('turn/start', { threadId: f.threadId, input: [] });
  const sent = f.send('queue'); await f.service.pump();
  const queueId = f.service.getRequest(f.context, sent.requestId!).queue_id;
  for (const method of ['thread/queue/delete', 'thread/queue/update', 'thread/queue/start', 'thread/queue/steer']) {
    const reply = await f.rpc(method, { threadId: f.threadId, queuedSubmissionId: queueId, input: [], expectedTurnId: 'turn-1' }, sent.requestId!, true);
    assert.equal(reply.error.code, -32600, method);
  }
  assert.equal((await f.rpc('thread/queue/collaborationReceipt', { threadId: f.threadId }, sent.requestId!, true)).error.code, -32600);
  assert.equal((await f.rpc('thread/start',{__opencraftOrchestrationOperation:'forged',__opencraftOrchestrationSourceThreadId:f.threadId,__opencraftOrchestrationIncarnation:'forged'})).error.code,403);
  assert.ok((await f.rpc('thread/queue/add', { threadId: f.threadId, clientUserMessageId: 'actor-input:forged', input: [] }, 'forged', true)).error);
  assert.ok((await f.rpc('turn/start', { threadId: f.threadId, clientUserMessageId: 'actor-input:forged', input: [] })).error);
  await f.service.cancel(f.context, sent.requestId!, () => {});
  assert.equal(f.service.getRequest(f.context, sent.requestId!).state, 'cancelled');
});

test('actual Headless bundle persists authenticated messages, binds execution and recovers request status', { timeout: 30_000 }, async t => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const { buildHeadlessBundle } = await import("../../scripts/package-headless-linux.mjs");
  const runtime = new URL("../../.runtime/", import.meta.url).pathname; await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, 'actor-collaboration-artifact-'));
  let app: any;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  const bundle = join(root, 'server.mjs'); await buildHeadlessBundle(bundle);
  const { startHeadlessServer } = await import(pathToFileURL(bundle).href);
  const webRoot = join(root, 'web'), dataDirectory = join(root, 'data'); await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Actor fixture</title>');
  await writeFile(join(webRoot, 'version.json'), JSON.stringify({ schemaVersion: 1, buildId: 'actor-loop-test', headlessServer: true, headlessHostId: 'opencraft-server' }));
  const wrapper = join(root, 'codex');
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  await writeFile(wrapper, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(new URL("../fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).pathname) + '\n', { mode: 0o700 });
  const store = new ActorStore(join(dataDirectory, 'actors.sqlite'));
  const a = store.createSession('A', 'operator'), b = store.createSession('B', 'operator');
  const ca = store.issueCredential(a.id, Date.now() + 60_000, 'operator'), cb = store.issueCredential(b.id, Date.now() + 60_000, 'operator');
  for (const action of ['message.send', 'execution.queue']) store.setGrant(a.id, b.id, action, true, 'operator');
  const seed = new Collaboration(join(dataDirectory, 'actor-collaboration.sqlite'), store, { hostId: "local-codex", validate: async () => {}, receipt: async () => null, add: async () => { throw new Error('not used'); }, steer: async () => {}, cancel: async () => false });
  await seed.bind(b.id, 'durable-thread', 0, () => {}); await seed.close(); store.close();
  const options = { root, webRoot, dataDirectory, port: 0, codexExecutable: wrapper, runtimeDirectory: root,
    startAgentHost: async () => ({ websocketUrl: 'ws://127.0.0.1:9/rpc', async close() {} }) };
  app = await startHeadlessServer(options);
  const call = async (path: string, token?: string, body?: any) => fetch(app.url + '/__opencraft_actors/collaboration/' + path, { headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  assert.equal((await call('inbox')).status, 401);
  const sentResponse = await call('messages', ca.token, { targetActorId: b.id, content: 'review from another Session', idempotencyKey: 'one', execution: { mode: 'queue' } });
  assert.equal(sentResponse.status, 200); const sent = await sentResponse.json() as any;
  let request: any;
  for (let i = 0; i < 100; i++) { request = (await (await call('requests?id=' + sent.requestId, ca.token)).json() as any).request; if (request.state === 'injected') break; await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.equal(request.state, 'injected');
  assert.equal((await (await call('inbox', cb.token)).json() as any).messages[0].author_id, a.id);
  const health = await (await fetch(app.url + '/__opencraft_health')).json() as any; assert.equal(health.ok, true);
  const pending = await (await call('messages', ca.token, { targetActorId: b.id, content: 'after current task', idempotencyKey: 'two', execution: { mode: 'queue' } })).json() as any;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal((await (await call('requests?id=' + pending.requestId, ca.token)).json() as any).request.state, 'queued');
  await app.close(); app = await startHeadlessServer(options);
  assert.equal((await (await call('requests?id=' + sent.requestId, ca.token)).json() as any).request.state, 'injected');
  for (let i = 0; i < 100; i++) { request = (await (await call('requests?id=' + pending.requestId, ca.token)).json() as any).request; if (request.state === 'injected') break; await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.equal(request.state, 'injected', 'pending queue survives graceful shutdown and restarts with the same claim');
  assert.equal((await (await call('inbox', cb.token)).json() as any).messages.length, 2);
  const replay = await (await call('messages', ca.token, { targetActorId: b.id, content: 'review from another Session', idempotencyKey: 'one', execution: { mode: 'queue' } })).json() as any;
  assert.equal(replay.replayed, true); assert.equal(replay.requestId, sent.requestId);
});


test('conversation tools execute in the server after the source viewer disconnects, with native history and the real target Host queue',async t=>{
  const f=await fixture(t);
  const human=f.actors.resolveHuman({provider:'local',subject:'source-user',displayName:'User',expiresAt:Date.now()+60000})!;
  const reference={serverId:'fixture',threadId:'fixture-fork-1'};
  await f.rpc('thread/fork',{threadId:f.threadId});
  await f.rpc('test/setHistory',{threadId:reference.threadId,turns:[{id:'saved',items:[{type:'agentMessage',id:'answer',text:'Verified target history'}]}]});
  const started=await f.rpc('turn/start',{threadId:f.threadId,input:[{type:'text',text:'inspect target opencraft://conversation/v1/fixture/fixture-fork-1'}],clientUserMessageId:'source-input'},undefined,false,human);
  const turnId=started.result.turn.id;
  const initial=(await f.rpc('test/readAcceptedInputs')).result.data.find((r:any)=>r.params.clientUserMessageId==='source-input');
  assert.equal(initial.params.additionalContext['opencraft.conversations'].kind,'untrusted');
  assert.match(initial.params.additionalContext['opencraft.conversations'].value,/Verified target history/);
  const encoded='opencraft://conversation/v1/fixture/fixture-fork-1';
  await f.rpc('test/emitTool',{threadId:f.threadId,turnId,tool:'read_thread',arguments:{reference:encoded}});
  const waitResult=async(count:number)=>{for(let i=0;i<100;i++){const r=await f.rpc('test/readToolResults');if(r.result.data.length>=count)return r.result.data;await new Promise(r=>setTimeout(r,10));}throw Error('tool result timeout');};
  const reads=await waitResult(1);assert.equal(reads[0].result.success,true);assert.match(reads[0].result.contentItems[0].text,/Verified target history/);
  // No logical viewer owns the following tool request. The same persistent delegation remains authoritative.
  await f.rpc('thread/unsubscribe',{threadId:f.threadId});
  await f.rpc('test/emitTool',{threadId:f.threadId,turnId,tool:'send_message_to_thread',arguments:{reference:encoded,message:'Review this change',idempotencyKey:'detached-send'}});
  const results=await waitResult(2);assert.equal(results[1].result.success,true);
  const receipt=JSON.parse(results[1].result.contentItems[0].text);
  for(let i=0;i<100 && f.service.getRequest(human,receipt.requestId).state!=='injected';i++){await f.service.pump();await new Promise(r=>setTimeout(r,10));}
  assert.equal(f.service.getRequest(human,receipt.requestId).state,'injected');
  const accepted=(await f.rpc('test/readAcceptedInputs')).result.data;
  assert.equal(accepted.filter((r:any)=>r.params.threadId===reference.threadId).length,1);
  const delivered=accepted.find((r:any)=>r.params.threadId===reference.threadId).params.input.map((p:any)=>p.text).join('\n');
  assert.match(delivered,/<opencraft_thread_message from="opencraft:\/\/conversation\/v1\/fixture\//);assert.match(delivered,/Review this change/);
  assert.equal((await f.rpc('opencraft/collaboration',{action:'reference',threadId:reference.threadId})).error.code,-32070);
  f.actors.setEnabled(human.actorId,false,'operator');
  await f.rpc('test/emitTool',{threadId:f.threadId,turnId,tool:'read_thread',arguments:{reference:encoded}});
  assert.equal((await waitResult(3))[2].result.success,false);
});

test('authenticated queue delete cancels managed delivery through collaboration and projects actual permissions', async t => {
  const f = await fixture(t);
  await f.rpc('turn/start', { threadId: f.threadId, input: [] });
  const sent = f.send('queue'); await f.service.pump();
  const queueId = f.service.getRequest(f.context, sent.requestId!).queue_id;
  const listed = await f.rpc('thread/queue/list', { threadId: f.threadId }, undefined, false, f.context);
  const item = listed.result.data.find((row: any) => row.id === queueId);
  assert.deepEqual(item.actions, { edit: false, delete: true, start: false, reorder: false });
  const receiver = f.actors.issueCredential(f.b.id, Date.now() + 60_000, 'operator');
  const receiverContext = f.actors.authenticateSession(receiver.token)!;
  const receiverList = await f.rpc('thread/queue/list', { threadId: f.threadId }, undefined, false, receiverContext);
  assert.equal(receiverList.result.data.find((row: any) => row.id === queueId).actions.delete, false);
  const denied = await f.rpc('thread/queue/delete', { threadId: f.threadId, queuedSubmissionId: queueId }, undefined, false, receiverContext);
  assert.ok(denied.error, 'receiving a message does not grant cancellation');
  assert.notEqual(f.service.getRequest(f.context, sent.requestId!).state, 'cancelled');
  const result = await f.rpc('thread/queue/delete', { threadId: f.threadId, queuedSubmissionId: queueId }, undefined, false, f.context);
  assert.equal(result.result?.deleted, true, JSON.stringify(result));
  assert.equal(f.service.getRequest(f.context, sent.requestId!).state, 'cancelled');
  assert.equal((await f.rpc('thread/queue/list', { threadId: f.threadId })).result.data.length, 0);
});

test('Human receiving a message in a shared conversation cancels through the real queue lane', async t => {
  const f=await fixture(t);
  const sender=f.actors.resolveHuman({provider:'local',subject:'sender-human',displayName:'Sender',expiresAt:Date.now()+60000})!;
  const receiver=f.actors.resolveHuman({provider:'local',subject:'receiver-human',displayName:'Receiver',expiresAt:Date.now()+60000})!;
  await f.rpc('turn/start',{threadId:f.threadId,input:[]});
  const sent=f.service.sendConversation(sender,{reference:{serverId:'fixture',threadId:f.threadId},content:'incoming shared message',idempotencyKey:'shared-incoming'});
  await f.service.pump();
  const queueId=f.service.getRequest(sender,sent.requestId!).queue_id;
  const list=await f.rpc('thread/queue/list',{threadId:f.threadId},undefined,false,receiver);
  assert.equal(list.result.data.find((row:any)=>row.id===queueId).actions.delete,true);
  const deleted=await f.rpc('thread/queue/delete',{threadId:f.threadId,queuedSubmissionId:queueId},undefined,false,receiver);
  assert.equal(deleted.result?.deleted,true,JSON.stringify(deleted));
  assert.equal(f.service.getRequest(sender,sent.requestId!).state,'cancelled');
  assert.equal((await f.rpc('thread/queue/list',{threadId:f.threadId})).result.data.length,0);
});
