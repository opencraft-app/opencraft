// Run inside the isolated smoke Gateway, using only its private owner socket.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const execution = process.env.OPENCRAFT_EXECUTION_DIR;
const token = (await readFile(join(execution, 'terminal.token'), 'utf8')).trim();
const socket = createConnection(join(execution, 'terminal.sock'));
const pending = new Map(); let sequence = 0, buffer = '';
let admit;
const admitted = new Promise(resolve => { admit = resolve; });
socket.setEncoding('utf8');
socket.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf('\n'); if (end < 0) break;
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (message.type === 'attached') admit();
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(new Error(message.error)) : request.resolve(message.result); }
  }
});
socket.once('connect', () => socket.write(JSON.stringify({ type: 'attach', protocol: 1, token }) + '\n'));
const failed = error => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); };
socket.on('error', failed); socket.on('close', () => failed(new Error('Owner disconnected')));
const deadline = setTimeout(() => { socket.destroy(); throw new Error('Terminal container probe timed out'); }, 15000);
const identity = { owner: 'container-smoke', quotaOwner: 'container-smoke', env: {},
  scope: { account: 'container-smoke', hostId: 'smoke', threadId: null, projectId: null } };
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Terminal operation timed out')); }, 5000);
  pending.set(id, { resolve, reject, timer }); socket.write(JSON.stringify({ id, method, params, identity }) + '\n');
});
const decode = result => result.output.map(chunk => Buffer.from(chunk.deltaBase64, 'base64').toString()).join('');
const wait = async (id, after, pattern) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await call('process/attach', { processHandle: id, afterSequence: after });
    if (pattern.test(decode(value))) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Terminal output marker missing');
};
try {
  await admitted;
  const previous = process.argv[4] ? JSON.parse(process.argv[4]) : null;
  const id = previous?.id ?? 'container-smoke:' + randomUUID();
  if (!previous) {
    await call('process/spawn', { processHandle: id, command: ['/bin/bash', '--noprofile', '--norc'], cwd: process.argv[3], tty: true, size: { cols: 80, rows: 24 } });
    await call('process/writeStdin', { processHandle: id, deltaBase64: Buffer.from("export PTY_SMOKE=preserved; printf 'OWNER_PID=%s\\n' $$; cat /proc/self/cgroup\n").toString('base64') });
    const result = await wait(id, 0, /OWNER_PID=\d+[\s\S]*docker/), text = decode(result);
    assert.match(text, /docker/);
    console.log(JSON.stringify({ id, pid: text.match(/OWNER_PID=(\d+)/)[1], cursor: result.nextSequence, output: text }));
  } else {
    const listed = await call('process/list', {}); assert.ok(listed.processes.some(process => process.processHandle === id));
    await call('process/resizePty', { processHandle: id, size: { cols: 103, rows: 31 } });
    await call('process/writeStdin', { processHandle: id, deltaBase64: Buffer.from("printf 'RECOVERED_PID=%s VALUE=%s\\n' $$ \"$PTY_SMOKE\"; stty size\n").toString('base64') });
    const result = await wait(id, previous.cursor, /31 103/);
    assert.match(decode(result), new RegExp(`RECOVERED_PID=${previous.pid} VALUE=preserved`));
    await call('process/kill', { processHandle: id });
    console.log(JSON.stringify({ ok: true, pid: previous.pid, preserved: true, resized: true, terminated: true }));
  }
} finally { clearTimeout(deadline); socket.destroy(); }
