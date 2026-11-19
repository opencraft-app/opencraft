import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const automation = process.argv[2] === 'automation';
const desktop = process.argv[2] === 'desktop';
const profile = await mkdtemp(join(tmpdir(), 'opencraft-cdp-owner-'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const flags = process.platform === 'linux'
  ? ['--ozone-platform=headless', '--disable-gpu', '--use-angle=swiftshader'] : [];
if (process.getuid?.() === 0) flags.push('--no-sandbox');
try {
  if (desktop) {
    const source = name => fileURLToPath(new URL(name, import.meta.url));
    await Promise.all([
      build({ entryPoints: [source('./desktop-cdp-main.ts')], outfile: join(profile, 'probe.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] }),
      build({ entryPoints: [source('../../../apps/desktop/src/preload.ts')], outfile: join(profile, 'preload.cjs'), bundle: true, platform: 'browser', format: 'cjs', external: ['electron'] }),
      build({ entryPoints: [source('./desktop-cdp-client.ts')], outfile: join(profile, 'client.js'), bundle: true, platform: 'browser' }),
      build({ entryPoints: [source('./desktop-cdp-guest.tsx')], outfile: join(profile, 'guest.js'), bundle: true, platform: 'browser' }),
    ]);
    env.OPENCRAFT_CDP_PROBE_DIR = profile;
  }
  const child = spawn(require('electron'), [
    ...flags, '--site-per-process', '--no-proxy-server',
    '--host-resolver-rules=MAP *.test 127.0.0.1', `--user-data-dir=${profile}`,
    desktop ? join(profile, 'probe.cjs') : fileURLToPath(new URL(automation ? './cdp-automation-main.cjs' : './cdp-owner-main.cjs', import.meta.url)),
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-32768); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-32768); });
  const timer = setTimeout(() => child.kill('SIGKILL'), automation || desktop ? 60000 : 30000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', resolve);
  }).finally(() => clearTimeout(timer));
  if (code !== 0 || !stdout.includes(desktop ? 'DESKTOP_CDP_SMOKE_OK' : automation ? 'CDP_AUTOMATION_SMOKE_OK' : 'CDP_OWNER_SMOKE_OK'))
    throw new Error(`CDP owner smoke failed (${code}): ${stdout}\n${stderr}`);
  process.stdout.write(stdout);
} finally { await rm(profile, { recursive: true, force: true }); }
