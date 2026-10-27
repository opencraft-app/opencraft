#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream, constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, writeFile, lstat, readlink, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { headlessWebHostDefinitions } from './package-headless-linux.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const scenarios = ['install', 'self-upgrade', 'all'];
const usage = 'Usage: npm run gate:server-updates -- [--scenario all|install|self-upgrade] [--profile daemon|headless] [--output <report-parent>]';
function options(args) {
  const result = { scenario: 'all', profile: 'daemon', output: join(repository, '.local/server-update-gate') };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') return null;
    if (args[i] === '--scenario' && scenarios.includes(args[i + 1])) result.scenario = args[++i];
    else if (args[i] === '--profile' && ['daemon', 'headless'].includes(args[i + 1])) result.profile = args[++i];
    else if (args[i] === '--output' && args[i + 1] && !args[i + 1].startsWith('--')) result.output = resolve(args[++i]);
    else throw new Error(usage);
  }
  return result;
}
async function sourceSnapshot() {
  const git = async args => (await exec('git', args, { cwd: repository, maxBuffer: 32 * 1024 * 1024 })).stdout;
  const commit = (await git(['rev-parse', 'HEAD'])).trim();
  const status = await git(['status', '--porcelain']);
  const hash = createHash('sha256').update(commit).update(await git(['diff', '--binary', 'HEAD']));
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort();
  for (const name of untracked) {
    const path = join(repository, name);
    const bytes = (await lstat(path)).isSymbolicLink() ? await readlink(path) : await readFile(path);
    hash.update(name).update('\0').update(bytes).update('\0');
  }
  return { commit, dirty: status.length > 0, status, fingerprint: hash.digest('hex') };
}
async function prerequisites() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('This gate requires Linux and root access for its isolated systemd units');
  await access('/run/systemd/system', constants.W_OK);
  await exec('systemctl', ['show', '--property=Version', '--value'], { timeout: 5000 });
  const versions = { node: process.version, codex: (await exec('codex', ['--version'], { timeout: 10_000 })).stdout.trim() };
  for (const command of ['npm', 'setfacl', 'runuser']) await exec(command, ['--version'], { timeout: 5000 });
  const { chromium } = await import('@playwright/test');
  await access(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE || chromium.executablePath(), constants.X_OK);
  await access(join(repository, 'node_modules/tsx/dist/loader.mjs'));
  return versions;
}
async function gate(config) {
  await mkdir(config.output, { recursive: true });
  const directory = await mkdtemp(join(config.output, `${new Date().toISOString().replaceAll(':', '-')}-`));
  const reportPath = join(directory, 'report.json');
  const report = { schemaVersion: 1, status: 'running', scenario: config.scenario, model: 'gpt-6-luna', startedAt: new Date().toISOString(),
    source: null, versions: null, stages: [], proofs: [], error: null };
  const save = async () => {
    const temporary = `${reportPath}.tmp`;
    await writeFile(temporary, JSON.stringify(report, null, 2));
    await rename(temporary, reportPath);
  };
  let interrupted = false; let child = null;
  const interrupt = signal => { interrupted = true; child?.kill(signal); };
  const onInt = () => interrupt('SIGINT'); const onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const run = async (name, args, extra = {}) => {
    if (interrupted) throw new Error('Gate interrupted');
    const stage = { name, status: 'running', startedAt: new Date().toISOString(), log: `${name}.log`, exitCode: null, signal: null };
    report.stages.push(stage); await save();
    console.log(`[server-update gate] ${name}`);
    const log = createWriteStream(join(directory, stage.log));
    log.on('error', () => child?.kill('SIGTERM'));
    try {
      const result = await new Promise((accept, reject) => {
        child = spawn(process.execPath, args, { cwd: repository, env: { ...process.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', bytes => { log.write(bytes); process.stdout.write(bytes); });
        child.stderr.on('data', bytes => { log.write(bytes); process.stderr.write(bytes); });
        child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal }));
      });
      stage.exitCode = result.code; stage.signal = result.signal;
      stage.status = result.code === 0 && !interrupted ? 'passed' : 'failed';
      if (stage.status !== 'passed') throw new Error(interrupted ? 'Gate interrupted' : `${name} failed (${result.signal || result.code})`);
    } catch (error) { stage.status = 'failed'; throw error; }
    finally {
      child = null; stage.finishedAt = new Date().toISOString();
      log.end(); if (!log.closed) await once(log, 'close');
      await save();
    }
  };
  try {
    await save(); report.source = await sourceSnapshot(); report.versions = await prerequisites(); await save();
    const loader = join(repository, 'node_modules/tsx/dist/loader.mjs');
    await run('regression', ['--import', loader, '--test', 'tests/server/web-deployment-config.test.mjs', 'tests/server/web-deployment-lock.test.mjs',
      'tests/server/web-deployment-source.test.mjs', 'tests/server/web-deployment.test.mjs', 'tests/server/server-deployment.test.mjs',
      'tests/execution/opencraft-daemon.test.ts', 'tests/execution/codex-core.test.ts', 'tests/storage/opencraft-host-state-database.test.ts', 'tests/tooling/controlled-release-registry.test.mjs', 'tests/server/ssh-http-ingress.test.mjs', 'tests/execution/daemon-token.test.ts']);
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error('Run this gate using npm run gate:server-updates');
    await run('build', [npm, 'run', 'build:web:release'], { OPENCRAFT_SOURCE_REVISION: report.source.commit + (report.source.dirty ? '-dirty' : ''), ...(config.profile === 'headless' ? { OPENCRAFT_HEADLESS_SERVER_BUILD: 'true', VITE_HYPERNODE_PLUGIN: 'disabled', VITE_APPSERVER_HOSTS_JSON: JSON.stringify(headlessWebHostDefinitions()) } : {}) });
    for (const scenario of config.scenario === 'all' ? ['install', 'self-upgrade'] : [config.scenario]) {
      const evidence = join(directory, scenario); await mkdir(evidence);
      await run(scenario, ['--import', loader, config.profile === 'headless' ? 'scripts/smoke/server/smoke-headless-server-updates.ts' : 'scripts/smoke/server/smoke-server-updates.ts'], {
        OPENCRAFT_SERVER_SMOKE_SYSTEMD: '1', OPENCRAFT_SERVER_SMOKE_SELF_UPGRADE: scenario === 'self-upgrade' ? '1' : '0',
        OPENCRAFT_SERVER_UPDATE_EVIDENCE_DIRECTORY: evidence,
      });
      const file = join(evidence, scenario === 'self-upgrade' ? 'self-upgrade-proof.json' : 'systemd-proof.json');
      const proof = JSON.parse(await readFile(file, 'utf8'));
      if ((config.profile === 'headless' && (proof.profile !== 'headless' || proof.samePortHttpWsSsh !== true || proof.executionFailureRolledBack !== true || proof.bootstrapRestartRecovered !== true || proof.pendingApprovalRestoredAndCompleted !== true)) || proof.model !== report.model || proof.sourceSelfUpgrade !== (scenario === 'self-upgrade') || proof.browserRollback !== true
        || proof.toolCalls !== 1 || proof.shellExecutions !== 1 || proof.before.pid !== proof.after.pid || proof.before.codexPid !== proof.after.codexPid)
        throw new Error(`${scenario} did not produce valid continuity evidence`);
      report.proofs.push({ scenario, file: `${scenario}/${file.split('/').pop()}`, sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
    }
    if (interrupted) throw new Error('Gate interrupted');
    const finalSource = await sourceSnapshot();
    if (interrupted) throw new Error('Gate interrupted');
    if (report.source.fingerprint !== finalSource.fingerprint) throw new Error('Source changed during the gate; rerun against the final source');
    report.status = 'passed';
  } catch (error) { report.status = interrupted ? 'interrupted' : 'failed'; report.error = error.message; }
  finally {
    report.finishedAt = new Date().toISOString();
    // Keep signal handlers until the final write has settled. If interrupted
    // while writing a tentative pass, replace it before releasing the handlers.
    do {
      if (interrupted) { report.status = 'interrupted'; report.error = 'Gate interrupted'; }
      await save();
    } while (interrupted && report.status !== 'interrupted');
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  }
  console.log(`[server-update gate] ${report.status}: ${reportPath}`);
  if (report.error) console.error(report.error);
  return report.status === 'passed' ? 0 : interrupted ? 130 : 1;
}
try {
  const config = options(process.argv.slice(2));
  if (!config) console.log(usage);
  else process.exitCode = await gate(config);
} catch (error) { console.error(error.message); process.exitCode = 1; }
