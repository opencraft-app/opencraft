import { sandboxMessage } from "@opencraft/sandbox-node/command";
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
// Runs inside CreateSandbox. Use exactly the executing DSH SDK's PTY primitive.
const sdk = process.argv[2];
const require = createRequire(pathToFileURL(sdk));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const { LocalSubprocessRuntime } = await import(pathToFileURL(sdk).href);
const context = new Context(), runtime = new LocalSubprocessRuntime(context);
let terminal, closing = false;
const send = message => {
  if (process.stdout.writableLength > 8 * 1024 * 1024) { void close(); return; }
  process.stdout.write(sandboxMessage(message));
};
const close = async () => {
  if (closing) return; closing = true;
  try { await terminal?.terminate(); } finally { await context.fiber.dispose(); process.exitCode = 0; process.stdin.destroy(); }
};
let bytes = 0;
process.stdin.on('data', data => { bytes += data.length; if (bytes > 1024 * 1024) void close(); });
const lines = createInterface({ input: process.stdin });
lines.on('line', text => {
  bytes = 0;
  void (async () => {
    const message = JSON.parse(text);
    if (message.method === 'start') {
      if (terminal || closing) throw Error();
      terminal = await runtime.spawnTerminal(message.spec);
      terminal.output.on('data', data => send({ type: 'output', data: Buffer.from(data).toString('base64') }));
      terminal.output.on('error', () => { void close(); });
      terminal.done.then(outcome => { send({ type: 'exit', outcome }); void close(); }, () => { send({ type: 'fault' }); void close(); });
      send({ type: 'ready', pid: terminal.pid }); return;
    }
    if (!terminal || closing) throw Error();
    let value;
    if (message.method === 'write') await terminal.write(message.data);
    else if (message.method === 'inspect') value = await terminal.inspectForeground();
    else if (message.method === 'signal') value = await terminal.signalForeground(message.signal);
    else if (message.method === 'close') { await close(); return; }
    else throw Error();
    send({ type: 'result', id: message.id, value });
  })().catch(() => { send({ type: 'fault' }); void close(); });
});
lines.on('close', () => { void close(); });
process.on('SIGTERM', () => { void close(); }); process.on('SIGHUP', () => { void close(); });
process.stdout.on('error', () => { void close(); });
