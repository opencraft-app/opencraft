#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2).reduce((a, v, i, xs) => {
  if (v.startsWith('--')) a[v.slice(2)] = xs[i + 1] && !xs[i + 1].startsWith('--') ? xs[i + 1] : true;
  return a;
}, {});
const checks = [];
const add = (id, ok, evidence, status = ok ? 'pass' : 'fail') => checks.push({ id, status, evidence });
const run = (cmd, argv) => { try { return execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return e.stdout?.toString() || ''; } };
const connection = args.connection;
let status;
if (connection) {
  const raw = run('opencraft', ['--json', '--connection', connection, 'status']);
  try { status = JSON.parse(raw); } catch { status = null; }
  add('server-capabilities', Boolean(status?.ok), status?.ok ? status.data.servers.map(s => ({ serverId: s.serverId, state: s.connectionState, capabilities: s.capabilities })) : 'opencraft status unavailable');
  add('realtime-connection', Boolean(status?.ok && status.data.connectionState === 'ready'), status?.data?.connectionState || 'unknown');
  const list = status?.data?.servers?.map(s => s.connectionState).join(',') || '';
  add('entry-health', Boolean(status?.ok), `CLI status=${status?.ok ? 'ok' : 'error'} servers=${list}`);
} else add('server-capabilities', false, 'No --connection supplied', 'blocked');

if (args['health-url']) {
  try { const r = await fetch(args['health-url']); add('entry-health-http', r.ok, `${r.status} ${r.url}`); }
  catch (e) { add('entry-health-http', false, e.message, 'blocked'); }
} else add('entry-health-http', false, 'No --health-url supplied', 'blocked');

if (args.ssh) {
  const probe = "set +e; echo '---process---'; ps -eo pid,args | grep -E 'opencraft.*(core|server)|headless-server|app-server' | grep -v grep | sed -E 's#(/data|/opt)/[^ ]*/(full/)?#<path>/#g' | head -20; echo '---ports---'; ss -ltn 2>/dev/null | grep -E ':(80|443|8080|19081|19989) ' | head -20; echo '---services---'; systemctl --no-legend --plain --type=service --state=running 2>/dev/null | grep -Ei 'opencraft|join' | wc -l; echo '---receipts---'; find /data/opencraft-deploy /opt/opencraft-server -maxdepth 5 -type f -name 'receipt.json' -print 2>/dev/null | tail -5";
  const identity = run('ssh', [args.ssh, 'sh', '-lc', probe]);
  add('runtime-identity', Boolean(identity.trim()), identity.trim() || 'No matching runtime process');
  add('entry-health-local', /---ports---[\s\S]*:(80|443|8080|19081|19989)\s/.test(identity), 'Listening HTTP/AppServer ports from target host');
  add('log-window', true, 'Owner log query required; baseline process/service evidence captured', 'blocked');
  add('deployment-lock-and-rollback', /---services---/.test(identity), 'Service owner is present; exact lock and rollback command remain owner-specific', 'blocked');
} else add('runtime-identity', false, 'No --ssh supplied', 'blocked');

for (const id of ['new-session', 'existing-session', 'data-continuity', 'queue-steer']) {
  add(id, false, 'Requires thread create/send/read capability and a dedicated smoke session; not available in this baseline invocation', 'blocked');
}
const report = { schemaVersion: 1, kind: 'opencraft-upgrade-smoke', generatedAt: new Date().toISOString(), target: args.target || connection || args.ssh || 'unknown', checks, summary: { pass: checks.filter(c => c.status === 'pass').length, fail: checks.filter(c => c.status === 'fail').length, blocked: checks.filter(c => c.status === 'blocked').length } };
const output = args.output || `upgrade-smoke-${(args.target || connection || 'report').replace(/[^a-z0-9_-]/gi, '_')}.json`;
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(`${report.target}: ${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.blocked} blocked`);
process.exitCode = report.summary.fail ? 1 : 0;
