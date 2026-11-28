import { isAbsolute } from 'node:path';
import { BridgeGatewaySession } from './gateway-session.js';
import { GatewayInbox } from './inbox.js';
import type { BridgeStreamMessage, EphemeralEvent } from './types.js';

export interface BridgeGatewayOptions { url: string; token: string; serverId: string; inboxPath: string }

function subscribeBridgeStream(
  url: string,
  token: string,
  handlers: {
    cursor(): number;
    onMessage(message: BridgeStreamMessage): void;
    onDisconnect?(): void;
  },
): () => void {
  let stopped = false;
  let controller: AbortController | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const parseBlock = (block: string) => {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/u)) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    try {
      const parsed = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
      if (eventName === 'hello' && typeof parsed.streamId === 'string' && typeof parsed.highStreamSeq === 'number') {
        handlers.onMessage({ kind: 'hello', streamId: parsed.streamId, highStreamSeq: parsed.highStreamSeq });
      } else if (eventName === 'ephemeral' && typeof parsed.streamSeq === 'number' && typeof parsed.route === 'string') {
        handlers.onMessage({ kind: 'ephemeral', event: parsed as unknown as EphemeralEvent });
      } else if (eventName === 'outbox') {
        handlers.onMessage({ kind: 'outbox', high: typeof parsed.high === 'number' ? parsed.high : 0 });
      } else if (eventName === 'command' && typeof parsed.commandId === 'string') {
        handlers.onMessage({ kind: 'command', commandId: parsed.commandId });
      }
    } catch {
      /* ignore malformed SSE frame */
    }
  };

  const connect = async (backoffMs = 50): Promise<void> => {
    if (stopped) return;
    controller = new AbortController();
    let nextBackoff = backoffMs;
    try {
      const response = await fetch(`${url}/events/stream?after=${handlers.cursor()}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (response.status === 404) {
        // Older Host without SSE endpoint: keep polling fallback without tight reconnect loop.
        await response.body?.cancel().catch(() => {});
        return;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw Error(`SSE unavailable: ${response.status}`);
      }
      nextBackoff = 50;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          parseBlock(block);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* reconnect below unless stopped */
    }
    handlers.onDisconnect?.();
    if (stopped) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect(Math.min(nextBackoff * 2, 1_000));
    }, nextBackoff);
    reconnectTimer.unref();
  };

  void connect();
  return () => {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    controller?.abort();
  };
}

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
      subscribeStream: (handlers) => subscribeBridgeStream(options.url, options.token, handlers),
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
