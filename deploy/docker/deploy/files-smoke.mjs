// Run inside Hands (or another role with the same execution + workspace mounts).
// Uses the real authenticated file service, not direct fs writes to workspace.
import assert from 'node:assert/strict';
import { readFile, stat, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
const execution = process.env.OPENCRAFT_EXECUTION_DIR;
const workspace = process.env.OPENCRAFT_WORKSPACE_DIR;
assert(execution?.startsWith('/') && workspace?.startsWith('/'));
const tokenPath = join(execution, 'files.token');
const info = await stat(tokenPath);
assert.equal(info.uid, process.getuid());
assert.equal(info.mode & 0o077, 0);
const token = (await readFile(tokenPath, 'utf8')).trim();
function call(path, body, authorized = true) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: join(execution, 'files.sock'), path,
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
const directory = join(workspace, '.deployment-smoke-' + process.pid);
try {
  await rpc('fs/createDirectory', { path: directory, recursive: true });
  const file = join(directory, 'portable.txt'), value = Buffer.from('OpenCraft portable 文件服务\n').toString('base64');
  await rpc('fs/writeFile', { path: file, dataBase64: value });
  assert.equal((await rpc('fs/readFile', { path: file })).dataBase64, value);
  assert((await rpc('fs/readDirectory', { path: directory })).entries.some(item => item.fileName === 'portable.txt' && item.isFile));
  assert.equal((await rpc('fs/getMetadata', { path: file })).isFile, true);
} finally { await rm(directory, { recursive: true, force: true }); }
console.log('Files RPC: authentication, mkdir, write, read, list, metadata passed.');
