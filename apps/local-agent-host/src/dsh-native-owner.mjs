import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, lstatSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reads = new Set(['session.list','session.search','session.history','session.models','session.attachment','subagent.list','subagent.history','host.describe','host.listDirectory','workspace.list','skill.list','agentPreset.list','agentPreset.read','settings.describe','credentials.describe','llm.providers','llm.models']);
const reconciliation = new Set(['session.cancel','subagent.interrupt']);

/** Native authority, installed inside the pinned DSH graph before it accepts
 * input. Ledger contains identities/digests only, never prompts or tool data. */
export function createDshNativeOwner(ctx, directory, bootstrapToken) {
  mkdirSync(directory, {recursive:true, mode:0o700});
  const path = join(directory, 'native-owner-custody.json');
  let ledger = {schemaVersion:1, calls:{}};
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error('Private native custody required');
    ledger = JSON.parse(readFileSync(path,'utf8'));
    if (ledger.schemaVersion !== 1 || !ledger.calls || typeof ledger.calls !== 'object' || Array.isArray(ledger.calls)) throw new Error('Invalid DSH custody');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (Object.values(ledger.calls).some(row=>!row || typeof row.owner !== 'string' || typeof row.method !== 'string'
    || !['unknown','receipt','effect-receipt','private-receipt'].includes(row.state) || typeof row.identity !== 'string'
    || row.state !== 'unknown' && typeof row.receipt !== 'string')) throw new Error('Invalid native custody row');
  ledger.calls = Object.assign(Object.create(null), ledger.calls);
  let admission = false, failed = false, active = 0, bootstrap = true, releasing = false;
  const owner = randomUUID();
  const save = () => {
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify(ledger), {mode:0o600,flag:'wx'});
      const fd = openSync(temporary,'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary,path);
      const root = openSync(directory,'r'); try { fsyncSync(root); } finally { closeSync(root); }
    } catch (error) { failed = true; admission = false; throw error; }
  };
  const open = () => admission && !failed;
  const receipt = input => {
    const row = ledger.calls[input?.rpcId];
    if (!row || row.state !== 'receipt' || row.receipt !== input.receipt) throw new Error('Exact live native receipt required');
    delete ledger.calls[input.rpcId]; save(); return {accepted:true};
  };
  const rpc = async (method, message, operation, suppliedToken) => {
    const payload = message.payload;
    const configuration = bootstrap && bootstrapToken && suppliedToken === bootstrapToken &&
      (method === 'settings.mutate' && ['llm-deepseek','llm-pi-ai','agent-default-model'].includes(payload?.ns)
        || ['credentials.set','credentials.unset'].includes(method) && /^OPENCRAFT_EXEC_[A-F0-9]{64}$/.test(payload?.ref));
    if (releasing || failed || !open() && !reads.has(method) && !reconciliation.has(method) && !configuration) return new Response('DSH owner fenced',{status:409});
    // Reads and cancellation remain possible after a fence. Cancellation itself
    // is not proof that a prior input or private side effect did not happen.
    const tracked = !reads.has(method);
    const id = message.rpcId;
    if (tracked) {
      if (Object.hasOwn(ledger.calls,id)) return new Response('DSH input already has custody',{status:409});
      ledger.calls[id] = {owner,method,identity:digest(message),state:'unknown'}; save();
    }
    active++;
    try {
      const response = await operation();
      if (tracked) {
        const proof = digest({id,method,status:response.status,body:await response.clone().text()});
        ledger.calls[id] = {...ledger.calls[id],state:'receipt',receipt:proof}; save();
        response.headers.set('x-opencraft-dsh-receipt',proof);
      }
      return response;
    } finally { active--; }
  };
  const inspect = async () => {
    const agents = ctx.agents.list();
    for (const agent of agents) await ctx.sessions.flush(agent.session);
    const headers = await ctx.sessionPersistence.list();
    const records = [];
    const unownedJobs = ctx.jobs.list().filter(row=>!row.ownerSession && (!["completed","failed","killed"].includes(row.status) || !row.reported)).length;
    let count = active + Object.keys(ledger.calls).length + unownedJobs;
    const ids = new Set(headers.map(row=>String(row.id)));
    for (const agent of agents) ids.add(String(agent.id));
    for (const id of [...ids].sort()) {
      const agent = ctx.agents.get(id);
      const stored = await ctx.sessionPersistence.readFrom(id,0);
      // The native detached inspection applies deterministic crash-tail recovery
      // in memory. It does not commit repairs or hide a live unfinished Turn.
      const events = agent?.session.events ?? (await ctx.sessionPersistence.inspect(id)).events;
      let lastTurn, goal, currentTurn;
      const turns = new Map(); const rpcInputs = new Map();
      const approvals = new Set();
      let unknownResults = 0;
      const unknownEvents = [], calls = new Map();
      for (const event of events) {
        if (event.type === 'turn/start') {lastTurn = 'open';currentTurn = String(event.data.turn);turns.set(String(event.data.turn),'open');}
        if (event.type === 'turn/end') {lastTurn = 'closed';turns.set(String(event.data.turn),'closed');}
        if (event.type === 'user/message' && typeof event.data?.source?.rpcId === 'string') rpcInputs.set(event.data.source.rpcId,currentTurn);
        if (event.type === 'goal/change') goal = event.data?.goal;
        if (event.type === 'tool/call') calls.set(JSON.stringify([event.data?.turn,event.data?.callId]),event);
        if (event.type === 'tool/result' && event.data?.error?.code === 'TOOL_OUTCOME_UNKNOWN') { unknownResults++; unknownEvents.push(event); }
        if (event.type === 'approval/asked') approvals.add(event.data?.id);
        if (event.type === 'approval/decided') approvals.delete(event.data?.id);
      }
      const liveGoal = agent ? ctx.goals.get(agent) : goal;
      const inbox = agent ? agent.inbox.nextTurn.length + agent.inbox.nextStep.length : pendingInbox(events.slice(stored.meta?.seedLength ?? 0));
      const jobs = agent ? ctx.jobs.list(agent).filter(row=>!['completed','failed','killed'].includes(row.status) || !row.reported).length : 0;
      const row = {id,turns:[...turns],rpcInputs:[...rpcInputs],events:events.length,digest:digest(events),running:agent?.status === 'running' ? 1 : 0,
        openTurn:lastTurn === 'open' ? 1 : 0,inbox,jobs,approvals:approvals.size,goal:liveGoal && liveGoal.phase !== 'complete' ? 1 : 0,
        storedEvents:stored.events.length,storedDigest:digest(stored.events),unknownResults};
      // An ended logical crash tail can transfer its unresolved responsibility;
      // live Turns and custody are independent and continue to block release.
      row.transferableUnknown = unknownEvents.flatMap(event => {
        const call = calls.get(JSON.stringify([event.data?.turn,event.data?.message?.source?.callId]));
        if (agent || row.openTurn || turns.get(String(event.data?.turn)) !== 'closed'
          || !call || call.data?.turn !== event.data?.turn || !Number.isSafeInteger(call.seq) || !Number.isSafeInteger(event.seq) || call.seq >= event.seq) return [];
        return [{sessionId:id,resultSeq:event.seq,toolCallSeq:call.seq,storedEvents:row.storedEvents,storedDigest:row.storedDigest}];
      });
      // Goals are durable intent. The fence gates execution; a cold restart
      // preserves their phase without arming automatic continuation.
      count += row.running + row.openTurn + inbox + jobs + row.approvals + unknownResults;
      records.push(row);
    }
    return {configuration:digest(ctx.settings.describe()),coverage:failed ? 'unknown':'complete', activeCount:failed ? null:count,owner,pid:process.pid,records,custody:Object.entries(ledger.calls).map(([id,row])=>({id,...row}))};
  };
  const effectKey = coordinates => 'effect:' + digest(coordinates);
  return {open,rpc,receipt,inspect,
    sealBootstrap() { bootstrap = false; },
    sealRelease() { releasing = true; admission = false; },
    abortRelease() { releasing = false; },
    bridgeLease() { if(releasing) throw new Error("Native writer is releasing");active++;let ended=false;return () => {if(!ended){ended=true;active--;}}; },
    beginPrivateEffect(coordinates) {
      const id=effectKey({...coordinates,kind:'private'});
      if(failed||Object.hasOwn(ledger.calls,id))throw new Error('Private DSH custody conflict');
      ledger.calls[id]={owner,method:'private-tool',identity:digest(coordinates),state:'unknown',sessionId:coordinates.sessionId,turn:String(coordinates.turn)};save();return id;
    },
    privateResult(id,result,aborted) {
      if (!id || !ledger.calls[id]) throw new Error('Private DSH custody missing');
      if (!aborted && result?.success === true) {ledger.calls[id].state='private-receipt';ledger.calls[id].receipt=digest(result);save();}
    },
    commitPrivateTurn(sessionId,turn) {
      let changed=false;
      for(const [id,row] of Object.entries(ledger.calls))if(row.method==='private-tool'&&row.state==='private-receipt'&&row.sessionId===sessionId&&row.turn===String(turn)){delete ledger.calls[id];changed=true;}
      if(changed)save();
    },
    beginEffect(coordinates) {
      const id = effectKey(coordinates);
      if (failed || Object.hasOwn(ledger.calls,id)) throw new Error('DSH effect custody conflict');
      ledger.calls[id] = {owner,method:'tool',identity:digest(coordinates),state:'unknown'}; save(); return id;
    },
    effectResult(id,result,aborted) {
      if (!id || !ledger.calls[id]) throw new Error('DSH effect custody missing');
      if (!aborted && result.isError === false) { ledger.calls[id].state = 'effect-receipt'; ledger.calls[id].receipt = digest(result); save(); }
    },
    commitEffect(coordinates) {
      const id = effectKey(coordinates);
      if (ledger.calls[id]?.state === 'effect-receipt') { delete ledger.calls[id]; save(); }
    },
    fence() { admission = false; },
    resume() { if (failed || releasing) throw new Error('Native persistence unknown or releasing'); admission = true; },
  };
}
function pendingInbox(events) {
  const state = {'next-turn':[], 'next-step':[]};
  for (const event of events) if (event.type === 'agent/inbox/spliced') {
    const row = event.data, target = state[row.target];
    if (!target || !Number.isSafeInteger(row.start) || row.start < 0 || row.start > target.length) throw new Error('Unknown native inbox');
    target.splice(row.start,row.removedCount ?? 0,...row.inserted);
  }
  return state['next-turn'].length + state['next-step'].length;
}
