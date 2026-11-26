import { isAbsolute } from 'node:path';
import { BridgeGatewaySession } from './gateway-session.js';
import { GatewayInbox } from './inbox.js';

export interface BridgeGatewayOptions { url: string; token: string; serverId: string; inboxPath: string }

/** Node's private loopback and Worker-backed SQLite assembly. */
export class BridgeGateway extends BridgeGatewaySession {
  readonly inbox: GatewayInbox;
  constructor(readonly options: BridgeGatewayOptions, event: (threadId: string, frame: unknown) => void) {
    if (typeof options.url !== 'string' || typeof options.token !== 'string' || options.token.length < 32 || typeof options.serverId !== 'string' || !options.serverId || options.serverId.length > 512 || typeof options.inboxPath !== 'string' || !isAbsolute(options.inboxPath)) throw Error('Invalid private bridge attachment configuration');
    let url: URL;
    try { url = new URL(options.url); } catch { throw Error('Invalid private bridge attachment URL'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/') throw Error('Private loopback Host attachment required');
    const inbox = new GatewayInbox(options.inboxPath);
    const request = (path: string, body?: unknown) => fetch(options.url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    super({
      serverId: options.serverId,
      request,
      inbox: {
        cursor: () => inbox.cursor(),
        readIdentities: (route, after, through, selection) => inbox.readIdentities(route, after, through, selection),
        readPendingInteractions: (route, after, through, ids) => inbox.readPendingInteractions(route, after, through, ids),
        read: (cursor) => inbox.read(cursor),
        pull: () => inbox.pull(options.url, options.token),
        close: () => inbox.close(),
      },
    }, event);
    this.inbox = inbox;
  }
}
