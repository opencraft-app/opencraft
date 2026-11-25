import { pullBridgeInbox } from './gateway-session.js';
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
    return pullBridgeInbox((path, body) => fetch(url + path, body === undefined ? { headers } : {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), {
      cursor: () => this.storage.call<number>('cursor'),
      apply: batch => this.storage.call('inbox', { batch }),
    });
  }
  read(cursor = 0): Promise<OutboxEvent[]> { return this.storage.call('inboxRead', { cursor }); }
  close(): Promise<void> { return this.storage.close(); }
}
