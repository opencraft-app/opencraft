import { pullBridgeInbox } from './gateway-session.js';
import { Storage } from './storage.js';
import type { BridgeHistorySelection, OutboxEvent } from './types.js';
import type { BridgeInboxIdentity, BridgeInboxPendingInteraction } from './inbox-store.js';
/** Server-owned durable projection log. Commit before ack; never reapply duplicates.
 * Consumers rebuild from this log, not an external side effect between commit/ack.
 */
export class GatewayInbox {
  readonly storage: Storage;
  private knownCursor?: number;
  private acknowledgedCursor?: number;
  constructor(path: string) { this.storage = new Storage(path, 'inbox'); }
  async pull(url: string, token: string): Promise<OutboxEvent[]> {
    await this.storage.ready;
    const headers = { authorization: `Bearer ${token}` };
    return pullBridgeInbox((path, body) => fetch(url + path, {
      headers, signal: AbortSignal.timeout(10_000),
      ...(body === undefined ? {} : {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
      }),
    }), {
      cursor: () => this.knownCursor ?? this.cursor(),
      apply: async batch => {
        this.knownCursor = undefined;
        const result = await this.storage.call<{ cursor: number; inserted: OutboxEvent[] }>('inbox', { batch });
        this.knownCursor = result.cursor;
        return result;
      },
    }, {
      fragmentOversized: true,
      acknowledgedCursor: this.acknowledgedCursor,
      onAcknowledged: cursor => { this.acknowledgedCursor = cursor; },
      isReadInterrupted: error => error instanceof TypeError ||
        (error instanceof DOMException && error.name === 'TimeoutError'),
    });
  }
  read(cursor = 0): Promise<OutboxEvent[]> { return this.storage.call('inboxRead', { cursor }); }
  async cursor(): Promise<number> {
    const value = await this.storage.call<number>('cursor');
    this.knownCursor = value;
    return value;
  }
  readIdentities(route: string, after: number, through: number, selection?: BridgeHistorySelection): Promise<BridgeInboxIdentity[]> {
    return this.storage.call('inboxReadIdentities', { route, after, through, selection });
  }
  readPendingInteractions(route: string, after: number, through: number, ids: readonly string[]): Promise<BridgeInboxPendingInteraction[]> {
    return this.storage.call('inboxReadPendingInteractions', { route, after, through, ids });
  }
  close(): Promise<void> { return this.storage.close(); }
}
