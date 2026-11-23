// Run inside Hands, Brain (shared execution directory) or the Gateway, whose
// workspace endpoint `files` is passed as OPENCRAFT_FILES_SMOKE_SOCKET/_TOKEN.
// Uses the real authenticated file service, not direct fs writes to workspace.
import assert from 'node:assert/strict';
import { readFile, stat, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
const execution = process.env.OPENCRAFT_EXECUTION_DIR;
const workspace = process.env.OPENCRAFT_WORKSPACE_DIR;
assert(execution?.startsWith('/') && workspace?.startsWith('/'));
const socketPath = process.env.OPENCRAFT_FILES_SMOKE_SOCKET ?? join(execution, 'files.sock');
const tokenPath = process.env.OPENCRAFT_FILES_SMOKE_TOKEN ?? join(execution, 'files.token');
const info = await stat(tokenPath);
assert.equal(info.uid, process.getuid());
assert.equal(info.mode & 0o077, 0);
const token = (await readFile(tokenPath, 'utf8')).trim();
function call(path, body, authorized = true) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path,
      method: body ? 'POST' : 'GET', headers: authorized ? { authorization: 'Bearer ' + token } : {},
    }, res => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', part => { data += part; });
      res.on('end', () => resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject); req.setTimeout(10_000, () => req.destroy(new Error('Files RPC timeout')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function rpc(method, params) {
  const response = await call('/rpc', { method, params });
  assert.equal(response.status, 200, 'Files RPC rejected: ' + method);
  return response.data.result;
}
assert.equal((await call('/health', null, false)).status, 401);
assert.deepEqual((await call('/health')).data, { ok: true, protocol: 1 });
// The files owner creates entries as its own identity (root for root Hands), so a
// client run may keep its directory for the Hands run to remove (deploy.py verify).
const prefix = join(workspace, '.deployment-smoke-');
const directory = process.env.OPENCRAFT_FILES_SMOKE_DIRECTORY ?? prefix + process.pid;
const remove = [directory, ...JSON.parse(process.env.OPENCRAFT_FILES_SMOKE_REMOVE ?? '[]')];
assert(remove.every(path => typeof path === 'string' && path.startsWith(prefix) && !path.slice(prefix.length).includes('/')));
try {
  await rpc('fs/createDirectory', { path: directory, recursive: true });
  const file = join(directory, 'portable.txt'), value = Buffer.from('OpenCraft portable 文件服务\n').toString('base64');
  await rpc('fs/writeFile', { path: file, dataBase64: value });
  assert.equal((await rpc('fs/readFile', { path: file })).dataBase64, value);
  assert((await rpc('fs/readDirectory', { path: directory })).entries.some(item => item.fileName === 'portable.txt' && item.isFile));
  assert.equal((await rpc('fs/getMetadata', { path: file })).isFile, true);
} finally {
  if (process.env.OPENCRAFT_FILES_SMOKE_KEEP !== '1') for (const path of remove) await rm(path, { recursive: true, force: true });
}
console.log('Files RPC: authentication, mkdir, write, read, list, metadata passed.');
