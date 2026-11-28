import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { BRIDGE_MAX_FRAME_BYTES, decodeFrame, encodeFrame, isRequest, isSuccess, splitLines, type BridgeWireMessage } from '@opencraft/agent-bridge-protocol';
import { CodexOwnerConnection } from './codex-owner.js';
import { CodexBridgeRuntime } from './codex-runtime.js';
import { CodexBridgeError } from './codex.js';

async function main() {
const path = process.argv[2];
if (!path || !isAbsolute(path)) throw Error('Absolute private Core attachment configuration required');
const metadata = await lstat(path);
// Windows has no POSIX modes or owners on files; the stack keeps this file in the user's private profile.
if (!metadata.isFile() || metadata.size > 65536 || (process.platform !== 'win32' && (metadata.mode & 0o077 || process.getuid && metadata.uid !== process.getuid()))) throw Error('Private owned Core attachment configuration required');
const config = JSON.parse(await readFile(path, 'utf8'));
if (!isAbsolute(config.endpoint) || typeof config.token !== 'string') throw Error('Invalid Core attachment configuration');
// A Core that owns accounts only does not report the native socket; the deployment names it.
if (config.nativeSocket !== undefined && (typeof config.nativeSocket !== 'string' || !isAbsolute(config.nativeSocket))) throw Error('Invalid native socket in Core attachment configuration');
if (config.nativeProjectless !== undefined && (config.nativeProjectless !== true || !config.nativeSocket)) throw Error('Native projectless allocation requires a fixed workspace AppServer');
let runtime: CodexBridgeRuntime;
let outputBytes = 0;
let output = Promise.resolve();
const send = (message: BridgeWireMessage) => {
  const frame = encodeFrame(message), frameBytes = Buffer.byteLength(frame);
  if (frameBytes > BRIDGE_MAX_FRAME_BYTES && isSuccess(message))
    throw new CodexBridgeError('frame-too-large', 'Bridge response exceeds the frame limit');
  const bytes = frameBytes + 1; // The JSONL delimiter is outside the frame.
  if (frameBytes > BRIDGE_MAX_FRAME_BYTES || outputBytes + bytes > 4 * (BRIDGE_MAX_FRAME_BYTES + 1) + 1024 * 1024) {
    owner.close();
    process.stdin.destroy();
    throw Error('Bridge output capacity exceeded');
  }
  outputBytes += bytes;
  output = output.then(() => new Promise<void>((resolve, reject) => process.stdout.write(frame + '\n', error => error ? reject(error) : resolve()))).finally(() => { outputBytes -= bytes; });
  void output.catch(() => { owner.close(); process.stdin.destroy(); process.exitCode = 1; });
};
const owner = new CodexOwnerConnection(config.endpoint, config.token,
  (method, params) => runtime.notification(method, params),
  (id, method, params) => runtime.interaction(id, method, params),
  fault => {
    if (fault) process.stderr.write(`codex-native-fault:${fault.method}:${fault.reason}\n`);
    runtime.lost(); process.stdin.destroy(); process.exitCode = 1;
  }, config.nativeSocket);
runtime = new CodexBridgeRuntime(owner, send, config.nativeProjectless === true);
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
  runtime.close();
  owner.close();
  await Promise.allSettled(tasks);
  await output;
}

}
void main().catch(() => { process.stderr.write("Codex bridge failed; inspect owner status\n"); process.exitCode = 1; });
