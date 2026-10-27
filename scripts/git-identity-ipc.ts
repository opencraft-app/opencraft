import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import type { GitIdentityBroker } from './git-identity-broker.js';

/** Only the bridge can write this inherited pipe; requests cannot supply their own peer identity. */
export async function serveGitIdentityBroker(broker: GitIdentityBroker, socket: string, bridgePath: string) {
  const child = spawn('python3', [bridgePath, socket], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Git broker bridge readiness timeout')); }, 10_000);
    const ready = (line: string) => { if (line === '{"ready":true}') { clearTimeout(timeout); resolve(); return; } };
    child.once('error', error => { clearTimeout(timeout); reject(error); }); child.once('exit', () => { clearTimeout(timeout); reject(new Error('Git broker bridge unavailable')); });
    lines.on('line', line => {
      if (line.length > 65_536) { child.kill(); return; }
      let packet;
      try { packet = JSON.parse(line); } catch { child.kill(); return; }
      if (packet.ready) { ready(line); return; }
      if (!Number.isSafeInteger(packet.id) || !Number.isSafeInteger(packet.peer?.pid) || !Number.isSafeInteger(packet.peer?.uid)) { child.kill(); return; }
      void broker.request(packet.peer, packet.request).then(response => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ id: packet.id, response })}\n`); });
    });
  });
  return { exited, async close() { lines.close(); child.stdin.end(); child.kill(); await exited; await broker.close(); } };
}
export async function queryGitIdentityBroker(socket: string, request: unknown, timeout = 2_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socket); let pending = '';
    const timer = setTimeout(() => { client.destroy(); reject(new Error('Git identity broker unavailable')); }, timeout);
    const finish = (error?: Error) => { clearTimeout(timer); client.destroy(); if (error) reject(error); };
    client.once('error', error => finish(error));
    client.once('connect', () => client.write(`${JSON.stringify(request)}\n`));
    client.on('data', data => {
      pending += data.toString('utf8');
      if (pending.length > 32768) { finish(new Error('Git identity response too large')); return; }
      if (!pending.includes('\n')) return;
      try { const result = JSON.parse(pending.slice(0, pending.indexOf('\n'))); finish(); resolve(result); }
      catch { finish(new Error('Git identity response invalid')); }
    });
    client.once('end', () => { if (!pending.includes('\n')) finish(new Error('Git identity broker disconnected')); });
  });
}
