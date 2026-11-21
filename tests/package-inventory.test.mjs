import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../', import.meta.url));
const script = await readFile(join(source, 'scripts/build/package-container.mjs'), 'utf8');
const inventorySource = script.slice(script.indexOf('async function inventory('), script.indexOf('await inventory(root);'));
async function run(root) {
  const files = [];
  const invoke = new Function('readdir', 'join', 'relative', 'createHash', 'createReadStream', 'root', 'files',
    `${inventorySource}; return inventory(root);`);
  await invoke(readdir, join, relative, createHash, createReadStream, root, files);
  return files;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'container-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('actual container inventory preserves nested/empty digests and excludes its manifest', async t => {
  const root = await fixture(t); await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'manifest.json'), '{}');
  await writeFile(join(root, 'empty'), ''); await writeFile(join(root, 'nested/data'), 'payload');
  const files = await run(root);
  assert.deepEqual(files.sort((a,b)=>a.path.localeCompare(b.path)), ['', 'payload'].map((value,i)=>({
    path: i ? 'nested/data' : 'empty', sha256: createHash('sha256').update(value).digest('hex') })));
});
test('actual container inventory hashes a sparse file larger than Node readFile limit', { timeout: 120000 }, async t => {
  const root = await fixture(t); const size = 2 ** 31 + 1;
  const file = await open(join(root, 'large'), 'wx'); await file.truncate(size); await file.close();
  const files = await run(root);
  const reference = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024);
  for (let left = size; left > 0; left -= chunk.length) reference.update(chunk.subarray(0, Math.min(left, chunk.length)));
  assert.deepEqual(files, [{ path: 'large', sha256: reference.digest('hex') }]);
});
test('container packaging executes the selected product builder with its actual runtime destination', async t => {
  const root = await fixture(t), repository = await fixture(t);
  await mkdir(join(root, 'runtime'));
  const builder = join(repository, 'fixture-builder.mjs');
  await writeFile(builder, "import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2], 'product gateway');writeFileSync(process.argv[2]+'.sidecar','worker');");
  const start = script.indexOf('if (process.env.OPENCRAFT_CONTAINER_GATEWAY_BUILD_SCRIPT)');
  assert(start >= 0);
  const hook = script.slice(start, script.indexOf("await writeFile(join(root, 'bin/opencraft-host')", start));
  const { execFileSync } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const execute = new Function('process','execFileSync','resolve','repository','join','root',hook);
  execute({execPath:process.execPath,env:{...process.env,OPENCRAFT_CONTAINER_GATEWAY_BUILD_SCRIPT:'fixture-builder.mjs'}},execFileSync,resolve,repository,join,root);
  assert.equal(await readFile(join(root,'runtime/container-gateway.mjs'),'utf8'),'product gateway');
  assert.equal(await readFile(join(root,'runtime/container-gateway.mjs.sidecar'),'utf8'),'worker');
  execute({env:{}},()=>assert.fail('default packaging must not launch a product builder'),resolve,repository,join,root);
});
