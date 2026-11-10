import { Storage } from './storage.js';
import type { OutboxEvent } from './types.js';
/** Server-owned durable projection log. Commit before ack; never reapply duplicates.
 * Consumers rebuild from this log, not an external side effect between commit/ack.
 */
export class GatewayInbox {
  readonly storage: Storage;
  constructor(path: string) { this.storage = new Storage(path, 'inbox'); }
  async pull(url: string, token: string): Promise<OutboxEvent[]> {
    await this.storage.ready;
    const headers = { authorization: `Bearer ${token}` };
    const cursor = await this.storage.call<number>('cursor');
    const response = await fetch(`${url}/events?cursor=${cursor}`, { headers });
    if (!response.ok) throw Error('Outbox read failed');
    const batch = await response.json() as OutboxEvent[];
    if (!Array.isArray(batch) || batch.some(row => !Number.isSafeInteger(row.seq) || typeof row.route !== 'string' || typeof row.generation !== 'string' || !('payload' in row))) throw Error('Invalid outbox batch');
    const committed = await this.storage.call<{ cursor: number; inserted: OutboxEvent[] }>('inbox', { batch });
    const ack = await fetch(`${url}/ack`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ cursor: committed.cursor }) });
    if (!ack.ok) throw Error('Outbox ack failed; committed projection remains queryable');
    return committed.inserted;
  }
  read(cursor = 0): Promise<OutboxEvent[]> { return this.storage.call('inboxRead', { cursor }); }
  close(): Promise<void> { return this.storage.close(); }
}
