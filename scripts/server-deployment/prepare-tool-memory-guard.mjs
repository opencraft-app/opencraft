#!/usr/bin/env node
// Offline staging only. Host mutation belongs to the serialized deployment owner.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
const absolute = value => typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f\x7f]/u.test(value);
export function validateToolMemoryPolicy(policy) {
  if (policy?.schemaVersion !== 1 || ![policy.toolMemoryHighMiB, policy.toolMemoryMaxMiB].every(value => Number.isSafeInteger(value) && value > 0)
    || (policy.toolPidsMax !== 'max' && !(Number.isSafeInteger(policy.toolPidsMax) && policy.toolPidsMax > 0))
    || policy.toolMemoryHighMiB > policy.toolMemoryMaxMiB || !/^[A-Za-z0-9_.@*?-]+\.service$/u.test(policy.generationUnitPattern ?? '')
    || !Array.isArray(policy.nativeExecutableNames) || policy.nativeExecutableNames.length === 0
    || !policy.nativeExecutableNames.every(value => typeof value === 'string' && /^[A-Za-z0-9_.-]+$/u.test(value))) throw new Error('Invalid tool memory policy');
  return policy;
}
export function renderToolMemoryGuard({ unit, highMiB, maxMiB, payload, policy, stateDirectory = '/var/lib/opencraft/tool-memory-guard', deploymentLock = '/run/opencraft-deploy.lock' }) {
  if (!/^[A-Za-z0-9_.@-]+\.service$/u.test(unit ?? '') || ![highMiB, maxMiB].every(value => Number.isSafeInteger(value) && value > 0) || highMiB > maxMiB
    || !absolute(stateDirectory) || !absolute(deploymentLock) || !Buffer.isBuffer(payload) || payload.length === 0) throw new Error('Invalid new generation guard staging request');
  validateToolMemoryPolicy(policy);
  const digest = createHash('sha256').update(payload).digest('hex');
  // Independent, versioned regular file: release GC cannot remove a running guard.
  const installedPayload = join(stateDirectory, `guard-${digest}.py`), installedPolicy = join(stateDirectory, 'policy.json');
  const service = `[Unit]\nDescription=OpenCraft delegated tool memory guard\nAfter=dbus.service\n\n[Service]\nType=simple\nUser=root\nExecStart=/usr/bin/python3 ${quote(installedPayload)} --watch-generations --config ${quote(installedPolicy)}\nRestart=always\nRestartSec=1\nKillMode=control-group\nOOMScoreAdjust=-500\nMemoryHigh=256M\nMemoryMax=512M\nMemorySwapMax=0\nLimitNOFILE=65536\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`;
  const dropin = `[Unit]\nWants=opencraft-tool-memory-guard.service\n\n[Service]\nDelegate=yes\nDelegateSubgroup=app\nOOMPolicy=continue\nOOMScoreAdjust=-1000\nMemoryHigh=${highMiB}M\nMemoryMax=${maxMiB}M\nMemorySwapMax=0\n`;
  return { schemaVersion: 1, unit, payloadSha256: digest, activationPreconditions: [
    `Hold ${deploymentLock}; wait for the deployment owner, never remove or replace the lock.`,
    'Target generation must be new: MainPID=0 and ActiveState inactive/failed/not-found. Never apply to a running legacy owner.',
    'Back up every existing target and prepare rollback before copying; preserve an existing operator policy.',
    'Copy staged files with declared modes, daemon-reload only; start the new generation through its existing migration owner.',
    'Enable only through the deployment environment migration and approval policy; preserve existing running generations.',
  ], files: [
    { source: 'guard.py', target: installedPayload, mode: 0o600, content: payload.toString('utf8') },
    { source: 'policy.json', target: installedPolicy, mode: 0o600, content: JSON.stringify(policy, null, 2) + '\n' },
    { source: 'opencraft-tool-memory-guard.service', target: '/etc/systemd/system/opencraft-tool-memory-guard.service', mode: 0o644, content: service },
    { source: '99-delegated-tool-memory.conf', target: `/etc/systemd/system/${unit}.d/99-delegated-tool-memory.conf`, mode: 0o644, content: dropin },
  ] };
}
async function main() {
  const option = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
  const output = option('--output');
  if (!absolute(output)) throw new Error('An absolute private --output staging directory is required');
  const payloadPath = option('--payload', join(import.meta.dirname, 'tool-memory-guard.py'));
  const policyPath = option('--policy', join(import.meta.dirname, 'tool-memory-guard.sample.json'));
  const plan = renderToolMemoryGuard({ unit: option('--unit'), highMiB: Number(option('--owner-high-mib')), maxMiB: Number(option('--owner-max-mib')),
    payload: await readFile(payloadPath), policy: JSON.parse(await readFile(policyPath, 'utf8')), stateDirectory: option('--state-directory', '/var/lib/opencraft/tool-memory-guard'), deploymentLock: option('--deployment-lock', '/run/opencraft-deploy.lock') });
  await mkdir(output, { mode: 0o700 }); // Refuse reuse/overwrite of an old review artifact.
  for (const file of plan.files) await writeFile(join(output, file.source), file.content, { mode: file.mode, flag: 'wx' });
  await writeFile(join(output, 'plan.json'), JSON.stringify({ ...plan, files: plan.files.map(({ content, ...file }) => file) }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ stagingDirectory: resolve(output), unit: plan.unit, hostChanged: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(error => { console.error(error.message); process.exitCode = 1; });
