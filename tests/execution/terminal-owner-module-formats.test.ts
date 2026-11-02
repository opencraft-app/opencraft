import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import { buildTerminalOwnerRuntime } from '../../scripts/package-terminal-runtime.mjs';
import { executionModuleOptions } from '../../scripts/package-web-server.mjs';
import { terminalOwnerLocation } from '../../apps/local-agent-host/src/terminal-owner-runtime.js';
import { readOwnerFrames, sendOwnerFrame, TERMINAL_OWNER_PROTOCOL } from '../../apps/local-agent-host/src/terminal-owner-wire.js';
const run = promisify(execFile), require = createRequire(import.meta.url);
for (const format of ['esm', 'cjs']) test(`packaged ${format} Host locates and launches its independent PTY owner`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-format-')), data = join(root, 'data');
  const location = await terminalOwnerLocation(data);
  t.after(async () => {
    await new Promise<void>(resolve => {
      const socket = connect(location.endpoint), timer = setTimeout(() => { socket.destroy(); resolve(); }, 2000);
      socket.once('error', () => { clearTimeout(timer); resolve(); });
      socket.once('connect', () => sendOwnerFrame(socket, { type: 'attach', protocol: TERMINAL_OWNER_PROTOCOL }));
      readOwnerFrames(socket, message => { clearTimeout(timer); socket.destroy(); if (message.pid) process.kill(message.pid, 'SIGTERM'); resolve(); });
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    await rm(root, { recursive: true, force: true });
  });
  await buildTerminalOwnerRuntime(root);
  await cp(dirname(require.resolve('node-pty/package.json')), join(root, 'node_modules/node-pty'), { recursive: true });
  const file = join(root, 'host.' + (format === 'esm' ? 'mjs' : 'cjs'));
  await build({ stdin: { contents: `
    import {DurableHostProcessService} from './apps/local-agent-host/src/durable-process-service.ts';
    const service = new DurableHostProcessService(process.argv[2]);
    (async()=>{
      await service.dispatch('process/spawn',{processHandle:'test',tty:true,command:['/bin/sh','-c','printf FORMAT_OK'],cwd:'/tmp',size:{cols:80,rows:24}});
      const end=Date.now()+5000;
      for(;;){
        const s=await service.dispatch('process/attach',{processHandle:'test',afterSequence:0});
        if(s.phase==='exited'){console.log(JSON.stringify(s));break;}
        if(Date.now()>end)throw new Error('shell timeout');await new Promise(r=>setTimeout(r,20));
      }
    })().catch(()=>{process.exitCode=1}).finally(()=>service.close());
    `, resolveDir: process.cwd() }, outfile: file, bundle: true, platform: 'node', format, external: ['node-pty'], ...executionModuleOptions(format) });
  const { stdout } = await run(process.execPath, [file, data], { timeout: 20_000, env: { ...process.env, INVOCATION_ID: '' } });
  const snapshot = JSON.parse(stdout);
  assert.equal(snapshot.phase, 'exited');
  assert.match(snapshot.output.map((chunk: any) => Buffer.from(chunk.deltaBase64, 'base64').toString()).join(''), /FORMAT_OK/);
});
