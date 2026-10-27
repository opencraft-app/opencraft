import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { build } from 'esbuild';
import { buildPiShellRuntime } from '../../scripts/package-pi-shell-runtime.mjs';
import { copyAllServerRuntime } from '../../scripts/package-mcp-app-runtime.mjs';

test('packaged Pi dependencies resolve in isolation and keep all symlinks inside the archive', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pi-packaged-runtime-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const versions = await copyAllServerRuntime(join(directory, 'node_modules'));
  for (const name of ['@earendil-works/pi-coding-agent','@earendil-works/pi-durable','@earendil-works/pi-ai','@earendil-works/chord']) assert.equal(versions[name], '1.3.0');
  assert.equal(versions['pi-interactive-shell'], '0.17.1');
  async function inspect(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        const target = relative(directory, await realpath(file));
        assert.ok(!isAbsolute(target) && target !== '..' && !target.startsWith('../'), `Escaping runtime link: ${file}`);
      } else if (entry.isDirectory()) await inspect(file);
    }
  }
  await inspect(directory);
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    'import {Harness} from "@earendil-works/pi-durable"; import {ModelRuntime} from "@earendil-works/pi-coding-agent"; console.log(typeof Harness.open, typeof ModelRuntime.create);'],
    { cwd: directory, env: { ...process.env, NODE_PATH: '' } });
  assert.equal(stdout.trim(), 'function function');
});


test('packaged interactive shell runs a real PTY and exits without source checkout or retained timers', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-shell-packaged-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const versions = await copyAllServerRuntime(join(directory, 'node_modules'));
  assert.equal(versions['pi-interactive-shell'], '0.17.1');
  assert.equal(versions['@earendil-works/pi-tui'], '1.3.0');
  await buildPiShellRuntime(join(directory, 'execution'));
  await build({ entryPoints: ['plugins/pi-engine/src/shell.ts'], outfile: join(directory, 'execution/client.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['@earendil-works/*'] });
  const program = `
    import assert from 'node:assert/strict';
    import {PiShellWorker} from './execution/client.mjs';
    let complete;
    const completed=new Promise(resolve=>complete=resolve);
    const worker=new PiShellWorker({cwd:process.cwd(),directory:process.cwd()+'/profile',threadId:'packaged',onNotification:complete,onLost:()=>{throw new Error('worker lost')}});
    const result=await worker.call({command:"printf packaged-shell-success",mode:'dispatch',background:true,handsFree:{autoExitOnQuiet:false}});
    assert.ok(!result.isError);assert.ok(result.details.sessionId);
    const event=await completed;assert.match(event.message.content,/packaged-shell-success/);
    await worker.stop();console.log('packaged shell passed');
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', program],
    { cwd: directory, timeout: 20000, env: { ...process.env, NODE_PATH: '', HOME: directory } });
  assert.equal(stdout.trim(), 'packaged shell passed');
});
