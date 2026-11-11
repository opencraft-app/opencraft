import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { decodeFrame, encodeFrame, isRequest, splitLines, type BridgeWireMessage } from '@opencraft/agent-bridge-protocol';
import { CodexOwnerConnection } from './codex-owner.js';
import { CodexBridgeRuntime } from './codex-runtime.js';

async function main() {
const path = process.argv[2];
if (!path || !isAbsolute(path)) throw Error('Absolute private Core attachment configuration required');
const metadata = await lstat(path);
if (!metadata.isFile() || metadata.size > 65536 || metadata.mode & 0o077 || process.getuid && metadata.uid !== process.getuid()) throw Error('Private owned Core attachment configuration required');
const config = JSON.parse(await readFile(path, 'utf8'));
if (!isAbsolute(config.endpoint) || typeof config.token !== 'string') throw Error('Invalid Core attachment configuration');
let runtime: CodexBridgeRuntime;
let outputBytes = 0;
let output = Promise.resolve();
const send = (message: BridgeWireMessage) => {
  const frame = encodeFrame(message) + '\n', bytes = Buffer.byteLength(frame);
  if (bytes > 1_048_576 || outputBytes + bytes > 8 * 1024 ** 2) { owner.close(); process.stdin.destroy(); throw Error('Bridge output capacity exceeded'); }
  outputBytes += bytes;
  output = output.then(() => new Promise<void>((resolve, reject) => process.stdout.write(frame, error => error ? reject(error) : resolve()))).finally(() => { outputBytes -= bytes; });
  void output.catch(() => { owner.close(); process.stdin.destroy(); process.exitCode = 1; });
};
const owner = new CodexOwnerConnection(config.endpoint, config.token,
  (method, params) => runtime.notification(method, params),
  (id, method, params) => runtime.interaction(id, method, params),
  fault => {
    if (fault) process.stderr.write(`codex-native-fault:${fault.method}:${fault.reason}\n`);
    runtime.lost(); process.stdin.destroy(); process.exitCode = 1;
  });
runtime = new CodexBridgeRuntime(owner, send);
const tasks = new Set<Promise<void>>();
try {
await owner.connect();
const decoder = new StringDecoder('utf8');
let lines = { carry: '', discarding: false };
for await (const chunk of process.stdin) {
  const batch = splitLines(decoder.write(Buffer.from(chunk)), lines); lines = batch;
  if (batch.oversized.length) { owner.close(); throw Error('Bridge input frame too large'); }
  for (const line of batch.lines) {
    const decoded = decodeFrame(line);
    if (decoded.kind === 'error') { send({ jsonrpc: '2.0', id: null, error: decoded.error }); continue; }
    if (!isRequest(decoded.message)) continue; // durable callback acknowledgements
    if (tasks.size >= 256) { send({ jsonrpc: '2.0', id: decoded.message.id, error: { code: -32006, kind: 'explicit-reject', message: 'Bridge request capacity reached' } }); continue; }
    const task = runtime.handle(decoded.message);
    tasks.add(task); void task.finally(() => tasks.delete(task));
  }
}
} finally {
  owner.close();
  await Promise.allSettled(tasks);
  await output;
}

}
void main().catch(() => { process.stderr.write("Codex bridge failed; inspect owner status\n"); process.exitCode = 1; });
