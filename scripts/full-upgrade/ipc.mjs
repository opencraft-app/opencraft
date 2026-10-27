import { createServer, createConnection } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { invariant } from './durable.mjs';
export async function serve(socketPath, handler, mode = 0o600) {
  try {
    const s = await lstat(socketPath);
    invariant(s.isSocket() && s.uid === process.getuid(), 'unsafe-socket');
    await unlink(socketPath);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let queue = Promise.resolve();
  const server = createServer(connection => {
    connection.setTimeout(15000, () => connection.destroy());
    let buffer = '', received = false;
    connection.on('data', bytes => {
      if (received) return;
      buffer += bytes;
      if (buffer.length > 16384) { received = true; connection.destroy(); return; }
      if (!buffer.includes('\n')) return;
      received = true; connection.setTimeout(0);
      queue = queue.then(async () => {
        try { const value = await handler(JSON.parse(buffer.trim())); connection.end(JSON.stringify({ ok: true, value }) + '\n'); }
        catch { connection.end(JSON.stringify({ ok: false, code: 'operation-rejected' }) + '\n'); }
      });
    });
    connection.on('error', () => {});
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, mode);
  return server;
}
export async function request(socketPath, input, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socketPath); let data = '';
    connection.setTimeout(timeout, () => connection.destroy(new Error('ipc-timeout')));
    connection.once('connect', () => connection.write(JSON.stringify(input) + '\n'));
    connection.on('data', bytes => { data += bytes; if (data.length > 4 * 1024 ** 2) connection.destroy(new Error('ipc-limit')); });
    connection.once('error', reject);
    connection.once('end', () => {
      try { const result = JSON.parse(data); invariant(result.ok, 'ipc-rejected'); resolve(result.value); } catch (e) { reject(e); }
    });
  });
}
