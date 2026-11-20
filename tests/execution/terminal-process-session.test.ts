import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalProcessSession, drainTerminalProcessSessions, type TerminalSessionSystem } from '../../apps/local-agent-host/src/terminal-process-session.js';
function fixture() {
  const entries = new Map<number, {pid:number;state:string;session:number;born:bigint}>();
  const signals: {pid:number;force:boolean}[] = [];
  const system: TerminalSessionSystem = { platform:'linux', stat:pid=>entries.get(pid)??null,
    pids:()=>entries.keys(), signal:(pid,force)=>{signals.push({pid,force});} };
  return {entries,signals,system};
}
test('fresh PTY birth is captured before setsid, without adopting the inherited parent session',()=>{
  const f=fixture();f.entries.set(20,{pid:20,state:'R',session:10,born:50n});
  const session=terminalProcessSession(20,f.system)!;
  assert.deepEqual(session,{id:20,born:50n});
  f.entries.set(10,{pid:10,state:'S',session:10,born:1n});
  assert.equal(drainTerminalProcessSessions([{session,force:false}],f.system),0);
  assert.deepEqual(f.signals,[]);
  f.entries.set(20,{pid:20,state:'S',session:20,born:50n});
  f.entries.set(21,{pid:21,state:'S',session:20,born:51n});
  assert.equal(drainTerminalProcessSessions([{session,force:true}],f.system),2);
  assert.deepEqual(f.signals,[{pid:20,force:true},{pid:21,force:true}]);
});
test('a reaped leader does not hide retained session jobs; zombies and other sessions are not signalled',()=>{
  const f=fixture(),session={id:20,born:50n};
  f.entries.set(21,{pid:21,state:'S',session:20,born:51n});
  f.entries.set(22,{pid:22,state:'Z',session:20,born:52n});
  f.entries.set(23,{pid:23,state:'S',session:99,born:53n});
  assert.equal(drainTerminalProcessSessions([{session,force:false}],f.system),1);
  assert.deepEqual(f.signals,[{pid:21,force:false}]);
});
test('a known reused leader PID cannot authorize signals against its replacement session',()=>{
  const f=fixture();f.entries.set(20,{pid:20,state:'S',session:20,born:500n});
  f.entries.set(21,{pid:21,state:'S',session:20,born:501n});
  assert.equal(drainTerminalProcessSessions([{session:{id:20,born:50n},force:true}],f.system),0);
  assert.deepEqual(f.signals,[]);
});
test('missing birth evidence neither signals guessed ownership nor reports successful release while jobs remain',()=>{
  const f=fixture(),session=terminalProcessSession(20,f.system)!;
  assert.deepEqual(session,{id:20,born:null});
  f.entries.set(21,{pid:21,state:'S',session:20,born:51n});
  assert.equal(drainTerminalProcessSessions([{session,force:true}],f.system),1);
  assert.deepEqual(f.signals,[]);
  f.entries.clear();assert.equal(drainTerminalProcessSessions([{session,force:true}],f.system),0);
});
test('non-Linux hosts never inspect proc or invent Linux session ownership',()=>{
  const f=fixture();f.system.platform='win32';f.system.stat=()=>{throw Error('must not inspect proc');};
  assert.equal(terminalProcessSession(20,f.system),undefined);
  assert.equal(drainTerminalProcessSessions([{session:{id:20,born:50n},force:true}],f.system),0);
});
