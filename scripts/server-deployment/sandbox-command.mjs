import { forwardSandboxCommand, readSandboxInvocation } from '@opencraft/sandbox-node/command';
import { configuredSandboxPool, readSandboxRuntimeConfiguration, sandboxPayloadEnvironment } from '@opencraft/sandbox-node/runtime';

// A transport child of the existing engine owner, not a new application service.
const args = process.argv.slice(2), separator = args.indexOf('--');
const flags = separator < 0 ? args : args.slice(0, separator);
const parsed = new Map();
let invalid = false;
for (let i = 0; i < flags.length; i++) {
  const key = flags[i];
  if (!['--config', '--owner', '--input', '--terminal'].includes(key) || parsed.has(key)) { invalid = true; break; }
  if (key === '--terminal') parsed.set(key, true);
  else { const value = flags[++i]; if (!value || value.startsWith('--')) invalid = true; parsed.set(key, value); }
}
const configuration = parsed.get('--config'), owner = parsed.get('--owner');
const input = parsed.get('--input'), terminal = parsed.has('--terminal');
let pool, raw = false, child;
const abort = new AbortController();
const cancel = () => abort.abort();
const interrupt = () => terminal && child ? void child.writeStdin(Uint8Array.of(3)).catch(cancel) : cancel();
const suspend = () => terminal && child ? void child.writeStdin(Uint8Array.of(26)).catch(cancel) : cancel();
const resize = () => { if (child?.kind === 'terminal') void child.resize({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }).catch(cancel); };
for (const name of ['SIGTERM', 'SIGHUP']) process.once(name, cancel);
process.on('SIGINT', interrupt); process.on('SIGTSTP', suspend); process.on('SIGWINCH', resize);
try {
  if (invalid || !configuration || !owner || (input ? separator >= 0 : separator < 0 || separator === args.length - 1)) throw Error();
  const config = await readSandboxRuntimeConfiguration(configuration);
  const envelope = input ? readSandboxInvocation(input) : { command: args.slice(separator + 1), cwd: process.cwd(), env: sandboxPayloadEnvironment(config, process.env) };
  const selected = { ...envelope, ...(terminal ? { terminal: { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 } } : {}) };
  pool = await configuredSandboxPool(config);
  if (terminal && process.stdin.isTTY) { process.stdin.setRawMode(true); raw = true; }
  process.exitCode = await forwardSandboxCommand({ pool, owner, command: selected, input: process.stdin, output: process.stdout, error: process.stderr,
    signal: abort.signal, onReady(value) { child = value; } });
} catch {
  process.stderr.write('Execution sandbox unavailable or command interrupted.\n');
  process.exitCode = 125;
} finally {
  if (raw) process.stdin.setRawMode(false);
  for (const name of ['SIGTERM', 'SIGHUP']) process.removeListener(name, cancel);
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTSTP', suspend); process.removeListener('SIGWINCH', resize);
  try { await pool?.close(); } catch { process.exitCode = 125; }
}
