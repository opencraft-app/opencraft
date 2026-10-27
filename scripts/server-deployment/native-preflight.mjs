import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Probe the copied payload with the deployment Node, before changing pointers or services. */
export async function assertExecutionNativePayload(releaseRoot) {
  const probeRoot = await mkdtemp(join(tmpdir(), 'opencraft-native-preflight-'));
  try {
    const modulePath = resolve(releaseRoot, 'execution/native/node-pty/lib/index.js');
    const script = `
      const pty = require(process.argv[1]);
      const windows = process.platform === 'win32';
      const terminal = pty.spawn(windows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
        windows ? ['/d', '/c', 'echo opencraft-native-ok'] : ['-c', 'printf opencraft-native-ok'],
        { cwd: process.cwd(), cols: 80, rows: 24 });
      let output = '';
      terminal.onData(data => output += data);
      terminal.onExit(({ exitCode }) => {
        if (exitCode !== 0 || !output.includes('opencraft-native-ok')) process.exitCode = 1;
        else console.log('native-ok');
      });
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', script, modulePath], {
      cwd: probeRoot, timeout: 10_000, maxBuffer: 64 * 1024,
      env: { PATH: process.env.PATH, HOME: probeRoot, TMPDIR: probeRoot,
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, TEMP: probeRoot } : {}) },
    });
    if (stdout.trim() !== 'native-ok') throw new Error('PTY did not pass the spawn probe');
  } catch (cause) {
    throw new Error('Execution native preflight failed: packaged node-pty must load and spawn with this Node ABI. Rebuild node-pty in the source checkout with node-gyp, then repackage; no services were switched.', { cause });
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}
