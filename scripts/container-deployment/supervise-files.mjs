import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

// Online adoption for existing Hands installations. The immutable owner runs
// inside Hands; a controller restart never replaces its execution container.
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(config.container) || !/^\d+:\d+$/.test(config.user)
  || !isAbsolute(config.entry) || !/^[a-f0-9]{64}$/.test(config.sha256)) throw Error('Invalid filesystem supervisor definition');
const digest = () => createHash('sha256').update(readFileSync(config.entry)).digest('hex');
const node = '/opt/opencraft/bin/node';
let stopped = false, child, wake;
const pause = milliseconds => new Promise(resolve => { const timer = setTimeout(resolve, milliseconds); wake = () => { clearTimeout(timer); resolve(); }; });
const stop = () => { stopped = true; wake?.(); child?.stdin.end(); };
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, stop);
while (!stopped) {
  try {
    if (digest() !== config.sha256) throw Error('Filesystem owner artifact changed');
    const result = spawnSync('docker', ['inspect', config.container], { encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) throw Error('Hands is unavailable');
    const container = JSON.parse(result.stdout)[0];
    if (!container.State.Running || container.Config.User !== config.user
      || container.Config.Labels['com.docker.compose.service'] !== 'hands') throw Error('Hands identity changed');
    const args = ['exec', '--user', config.user, container.Id, node, config.entry];
    const probe = spawnSync('docker', [...args, '--probe'], { stdio: 'ignore', timeout: 7000 });
    if (stopped) break;
    if (probe.status === 0) { await pause(10000); continue; }
    // A newer image owns its startup ordering. Never race its integrated child.
    const integrated = spawnSync('docker', ['exec', container.Id, node, '-e',
      'process.exit(require("node:fs").existsSync("/opt/opencraft/runtime/hands-files-owner.mjs") ? 0 : 1)'], { stdio: 'ignore', timeout: 5000 });
    if (integrated.status === 0) { await pause(10000); continue; }
    child = spawn('docker', ['exec', '-i', '--user', config.user, container.Id, node, config.entry, '--supervised'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdout.pipe(process.stdout, { end: false }); child.stderr.pipe(process.stderr, { end: false });
    await new Promise(resolve => { child.once('error', resolve); child.once('close', resolve); });
    child = undefined;
  } catch { if (!stopped) process.stderr.write('Hands filesystem owner is unavailable; retrying.\n'); }
  if (!stopped) await pause(2000);
}
