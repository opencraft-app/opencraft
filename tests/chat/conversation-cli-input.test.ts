import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareSend } from '../../apps/opencraft-cli/src/send';

test('file input preserves UTF-8 text and rejects unreadable, malformed and oversized messages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cli-input-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'message.txt');
  const prepare = () => prepareSend(undefined, path, 'synthetic-key', 'queue', undefined, undefined);
  const content = '合成消息 🦉\nsecond line';
  await writeFile(path, content);
  assert.equal((await prepare()).content, content);
  await writeFile(path, 'x'.repeat(16384)); assert.equal((await prepare()).content.length, 16384);
  await writeFile(path, 'x'.repeat(16385)); await assert.rejects(prepare(), /Invalid message/);
  await writeFile(path, Buffer.from([0xc3, 0x28])); await assert.rejects(prepare(), /Use UTF-8 text/);
  await writeFile(path, Buffer.alloc(65537, 0x61)); await assert.rejects(prepare(), /Message is too long/);
  await writeFile(path, ' \n'); await assert.rejects(prepare(), /Give a message/);
  await rm(path); await assert.rejects(prepare(), /Cannot read message file/);
});
test('piped stdin and explicit stdin preserve text; malformed and oversized streams fail before sending', async () => {
  const module = new URL('../../apps/opencraft-cli/src/send.ts', import.meta.url).href;
  const invoke = async (input: Buffer | string, file?: string) => {
    const script = `import {prepareSend} from ${JSON.stringify(module)};
      try { const result = await prepareSend(undefined, ${file === undefined ? 'undefined' : JSON.stringify(file)}, 'key', 'queue', undefined, undefined);
        process.stdout.write(JSON.stringify({content:result.content,operationKey:result.operationKey}));
      } catch(error) { process.stdout.write(JSON.stringify({code:error.code,message:error.message})); process.exitCode=error.exitCode; }`;
    const pending = promisify(execFile)(process.execPath, ['--import','tsx','--input-type=module','--eval',script]);
    pending.child.stdin!.end(input);
    return JSON.parse((await pending).stdout);
  };
  assert.equal((await invoke('合成管道 🦉\n')).content, '合成管道 🦉\n');
  assert.equal((await invoke('explicit stdin', '-')).content, 'explicit stdin');
  for (const [bytes, message] of [[Buffer.from([0xff]), 'Use UTF-8 text.'], [Buffer.alloc(65537, 0x61), 'Message is too long.']] as const) {
    await assert.rejects(invoke(bytes), (error: any) => {
      assert.equal(error.code, 2); assert.equal(JSON.parse(error.stdout).message, message); return true;
    });
  }
});
