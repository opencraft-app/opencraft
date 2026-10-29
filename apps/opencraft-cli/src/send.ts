import { open, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CollaborationClient } from '@opencraft/appserver-client/collaboration';
import type { ConversationRef, ConversationReceipt } from '@opencraft/appserver-protocol/collaboration';
import { CliError, classify } from './errors';

export interface SendInput { content: string; operationKey: string; generated: boolean; timeoutMs: number | null }
function invalid(message: string): never { throw new CliError(2, 'INVALID_INPUT', message); }
async function readInput(source: AsyncIterable<Buffer | string>) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of source) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 65_536) invalid('Message is too long.');
    chunks.push(bytes);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { return invalid('Use UTF-8 text.'); }
}
export async function prepareSend(text: string | undefined, file: string | undefined, key: string | undefined,
  mode: string | undefined, wait: string | undefined, timeout: string | undefined): Promise<SendInput> {
  if (mode !== undefined && mode !== 'queue') invalid('Use --mode queue.');
  if (wait !== undefined && wait !== 'delivered') invalid('Use --wait delivered.');
  if (timeout !== undefined && wait === undefined) invalid('--timeout needs --wait delivered.');
  if (!key && !process.stdin.isTTY) invalid('Non-interactive send needs --key.');
  if (key !== undefined && (!key.trim() || key.length > 128 || /[\x00-\x1f]/u.test(key))) invalid('Invalid --key.');
  if (text !== undefined && file !== undefined) invalid('Choose text, --message-file or stdin.');
  let timeoutMs: number | null = null;
  if (wait) {
    const match = /^(\d+)(ms|s|m)$/u.exec(timeout ?? '30s');
    if (!match) invalid('Use a timeout such as 30s.');
    timeoutMs = Number(match[1]) * ({ ms: 1, s: 1000, m: 60000 }[match[2]!]!);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) invalid('Timeout must be 1ms to 1h.');
  }
  let content = text;
  if (file !== undefined && file !== '-') {
    let handle;
    try { handle = await open(file, 'r'); content = await readInput(handle.createReadStream()); }
    catch (error) { if (error instanceof CliError) throw error; invalid('Cannot read message file.'); }
    finally { await handle?.close(); }
  } else if (file === '-' || content === undefined && !process.stdin.isTTY) content = await readInput(process.stdin);
  if (content === undefined || !content.trim()) invalid('Give a message.');
  if (content.length > 16384 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(content)) invalid('Invalid message.');
  return { content, operationKey: key ?? randomUUID(), generated: key === undefined, timeoutMs };
}

export async function sendMessage(client: CollaborationClient, ref: ConversationRef, input: SendInput,
  scope: { instanceId: string; actorId: string; recordsDirectory: string }) {
  // Reject missing capabilities before persisting a generated key or issuing a mutation.
  client.require('queue');
  client.require('lookup');
  if (input.timeoutMs !== null) client.require('deliveryMetadata');
  if (input.generated) {
    try {
      await mkdir(scope.recordsDirectory, { recursive: true, mode: 0o700 });
      await writeFile(join(scope.recordsDirectory, input.operationKey + '.json'), JSON.stringify({ schemaVersion: 1,
        instanceId: scope.instanceId, actorId: scope.actorId, ref, operationKey: input.operationKey, createdAt: Date.now() }) + '\n', { flag: 'wx', mode: 0o600 });
    } catch { throw new CliError(2, 'OPERATION_RECORD_FAILED', 'Cannot save operation key.'); }
  }
  let receipt: ConversationReceipt | undefined;
  try {
    // Exactly one invocation. Disconnection never retries this mutation.
    const sent = await client.send(ref, input.content, input.operationKey, { mode: 'queue' });
    receipt = { ref, operationKey: input.operationKey, messageId: sent.messageId, requestId: sent.requestId,
      mode: 'queue', deliveryState: 'accepted', targetTurnId: null, observedAt: Date.now(), taskOutcome: 'unknown' };
    if (input.timeoutMs === null) return { ...receipt, replayed: sent.replayed };
    const deadline = performance.now() + input.timeoutMs;
    while (performance.now() < deadline) {
      receipt = await client.delivery(ref, sent.requestId, Math.max(1, Math.min(15000, deadline - performance.now())));
      if (['submitted', 'injected'].includes(receipt.deliveryState)) return receipt;
      if (['rejected', 'cancelled'].includes(receipt.deliveryState)) throw new CliError(8, 'DELIVERY_REJECTED', 'Delivery rejected.', false, { receipt });
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - performance.now()))));
    }
    throw new CliError(7, 'DELIVERY_TIMEOUT', 'Delivery wait timed out.', true, { receipt });
  } catch (error) {
    const fault = classify(error);
    if (fault.exitCode !== 7) throw fault;
    throw new CliError(7, fault.code === 'DELIVERY_TIMEOUT' ? fault.code : 'OUTCOME_UNKNOWN',
      fault.code === 'DELIVERY_TIMEOUT' ? fault.message : 'Outcome unknown. Use lookup.', true,
      { ref, operationKey: input.operationKey, instanceId: scope.instanceId, actorId: scope.actorId, ...(receipt ? { receipt } : {}) });
  }
}
