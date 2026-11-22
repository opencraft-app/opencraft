#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  connection: { type: 'string' }, 'health-url': { type: 'string' },
  output: { type: 'string' }, baseline: { type: 'string' }, expected: { type: 'string' },
} });
if (!values.output) throw new Error('--output is required');
const read = path => path ? JSON.parse(readFileSync(path, 'utf8')) : null;
const baseline = read(values.baseline);
const expected = read(values.expected);
const checks = {};
function record(id, status, evidence) { checks[id] = { status, evidence }; }
function cli(...args) {
  let output;
  try {
    output = execFileSync('opencraft', ['--json', '--connection', values.connection, ...args],
      { encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    output = error.stdout;
  }
  try { return JSON.parse(output); } catch { return { ok: false, error: { code: 'CLI_UNAVAILABLE' } }; }
}
function safeCode(result) {
  const code = result.error?.code;
  return typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'INVALID_RESPONSE';
}
if (values.connection) {
  const result = cli('server', 'list');
  const list = result.data?.servers;
  if (result.ok && Array.isArray(list) && list.length) {
    const servers = list.map(({ serverId, engine, connectionState, capabilities }) => ({
      serverId, engine, connectionState,
      capabilities: Object.fromEntries(Object.entries(capabilities ?? {}).filter(([, value]) => typeof value === 'boolean')),
    }));
    const prior = baseline?.checks?.servers?.evidence ?? [];
    const preserved = Array.isArray(prior) && prior.every(old => servers.some(current =>
      current.serverId === old.serverId && Object.entries(old.capabilities).every(([key, value]) =>
        value !== true || current.capabilities[key] === true)));
    const matches = (expected?.capabilities ?? []).every(({ engine, capabilities }) =>
      servers.some(server => server.engine === engine && Object.entries(capabilities).every(([key, value]) =>
        server.capabilities[key] === value)));
    record('servers', preserved && matches && servers.every(server => server.connectionState === 'ready')
      ? 'pass' : 'fail', servers);
  } else record('servers', 'fail', { code: safeCode(result) });
} else record('servers', 'blocked', { reason: 'No admitted CLI connection' });

if (values['health-url']) {
  try {
    const response = await fetch(values['health-url'], { redirect: 'error', signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    const evidence = { httpStatus: response.status, buildId: data.buildId, version: data.version };
    record('health', response.ok && data.ok === true ? 'pass' : 'fail', evidence);
    if (expected?.buildId) record('headless-build', data.buildId === expected.buildId ? 'pass' : 'fail', evidence);
  } catch {
    record('health', 'fail', { reason: 'Health endpoint did not return JSON within the probe window' });
  }
} else record('health', 'blocked', { reason: 'No health URL' });

const summary = { pass: 0, fail: 0, blocked: 0 };
for (const { status } of Object.values(checks)) summary[status]++;
writeFileSync(values.output, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), checks, summary }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(`Upgrade smoke: ${summary.pass} passed, ${summary.fail} failed, ${summary.blocked} blocked`);
process.exitCode = summary.fail || summary.blocked ? 1 : 0;
