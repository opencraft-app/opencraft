import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const output = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
let sequence = 0;
const callback = (threadId, deltas) => output({ id: `callback:${++sequence}`, method: 'thread/delta', params: { threadId, deltas } });
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (!request.method) return;
  const p = request.params;
  if (request.method === 'initialize') { output({ id: request.id, result: JSON.parse(process.env.HANDSHAKE) }); return; }
  if (request.method === 'session/create') output({ id: `identity:${++sequence}`, method: 'thread/identity', params: { threadId: p.threadId, providerThreadId: `native-${p.threadId}`, sessionRestorable: true } });
  if (request.method === 'session/create' && p.unsettled) {
    const scope = { threadId: p.threadId };
    const deltas = [{ op: 'turn.open', nativeTurnId: 'old-turn', scope }];
    if (p.unsettled === 'stream') deltas.push({ op: 'item.open', nativeKey: 'late-stream', shape: { kind: 'agentMessage', text: 'unfinished' }, scope });
    deltas.push({ op: 'turn.close', nativeTurnId: 'old-turn', status: 'completed', scope });
    if (p.unsettled === 'queue') deltas.push({ op: 'input.accepted', inputId: 'late-input', clientRequestId: 'late-client', expectedTurnId: 'old-turn', scope },
      { op: 'input.evidence', inputId: 'late-input', evidenceKind: 'echo', version: 1, scope });
    callback(p.threadId, deltas);
  }
  if (request.method === 'turn/stop' && p.settle) {
    const scope = { threadId: p.threadId };
    callback(p.threadId, [p.settle === 'stream' ? { op: 'item.textClose', nativeKey: 'late-stream', channel: 'agentMessage', scope }
      : { op: 'input.withdrawal', inputId: 'late-input', state: 'withdrawn', version: 2, scope }]);
  }
  if (request.method === 'turn/start') {
    appendFileSync(process.env.EXECUTIONS, request.id + '\n');
    if (p.crashWindow) { process.kill(Number(process.env.HOST_PID), 'SIGKILL'); return; }
    const scope = { threadId: p.threadId };
    callback(p.threadId, [{ op: 'turn.open', nativeTurnId: 'native-turn-1', scope }, { op: 'item.open', nativeKey: 'message-1', shape: { kind: 'agentMessage', text: '' }, scope }]);
    let tick = 0;
    const timer = setInterval(() => {
      callback(p.threadId, [{ op: 'item.textDelta', nativeKey: 'message-1', channel: 'agentMessage', text: `${++tick},`, scope }]);
      if (tick === 15) {
        clearInterval(timer);
        callback(p.threadId, [{ op: 'item.textClose', nativeKey: 'message-1', channel: 'agentMessage', scope }, { op: 'item.close', nativeKey: 'message-1', shape: { kind: 'agentMessage', text: Array.from({ length: 15 }, (_, i) => `${i + 1},`).join('') }, scope }, { op: 'turn.close', nativeTurnId: 'native-turn-1', status: 'completed', scope }]);
      }
    }, 100);
  }
  if (p?.spawnDescendant) {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    output({ id: request.id, result: { pid: process.pid, descendant: child.pid } }); return;
  }
  output({ id: request.id, result: { pid: process.pid } });
});
process.stdin.on('end', () => process.exit(0));
