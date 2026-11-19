import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { OpenRelayHubStream } from '../apps/relay-server/src/application.js';
import type { RelayIngress } from '../apps/relay-server/src/server.js';
import { publicOrigin, validHubId } from '../packages/hub-network/src/contract.js';

const CALLBACK_PATH = '/wecom_callback';
const RECEIVER_PATH = '/__opencraft_im/shadow-callback/wecom';
const CALLBACK_TIMEOUT_MS = 4_500;

type CallbackGuard = {
  path: string;
  handle(req: IncomingMessage, res: ServerResponse, forward: (body: string) => Promise<void>): Promise<void>;
};

export function parseWeComCallbackTarget(input: unknown): { hubId: string; origin: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid WeCom callback target');
  const { hubId, origin, ...extra } = input as Record<string, unknown>;
  if (!validHubId(hubId) || Object.keys(extra).length) {
    throw new Error('Invalid WeCom callback target');
  }
  return { hubId, origin: publicOrigin(origin) };
}

export function createWeComCallbackIngress(target: ReturnType<typeof parseWeComCallbackTarget>, openHubStream: OpenRelayHubStream, guard?: CallbackGuard): RelayIngress {
  const host = new URL(target.origin).host;

  async function forward(req: IncomingMessage, res: ServerResponse, query: string, body?: string) {
    const lifecycle = new AbortController();
    const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(CALLBACK_TIMEOUT_MS)]);
    const cancel = () => lifecycle.abort();
    let stream: Duplex | undefined;
    const fail = () => {
      stream?.destroy();
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(503, { 'cache-control': 'no-store' });
      res.end();
    };
    req.once('aborted', cancel);
    res.once('close', () => { req.off('aborted', cancel); cancel(); stream?.destroy(); });
    try {
      stream = await openHubStream(target, signal);
      signal.throwIfAborted();
      const headers: Record<string, string> = { host, connection: 'close' };
      for (const name of ['content-type', 'content-length']) {
        const value = req.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
      const upstream = request({
        method: 'POST', path: RECEIVER_PATH + query, headers, signal, createConnection: () => stream!,
      }, incoming => {
        if (res.destroyed) { incoming.destroy(); return; }
        res.writeHead(incoming.statusCode ?? 502, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
        incoming.once('error', fail);
        incoming.once('aborted', fail);
        incoming.pipe(res);
      });
      upstream.once('error', fail);
      if (body === undefined) req.pipe(upstream);
      else upstream.end(body);
    } catch {
      fail();
    }
  }

  return (req, res) => {
    const url = req.url ?? '';
    if ((req.method !== 'POST' && !(guard && req.method === 'GET')) || url.split('?', 1)[0] !== CALLBACK_PATH) return false;
    const time = new Date().toISOString();
    res.once('close', () => console.info(JSON.stringify({ time, path: CALLBACK_PATH, status: res.headersSent ? res.statusCode : null })));
    const query = url.slice(CALLBACK_PATH.length);
    if (guard) {
      req.url = guard.path + query;
      void guard.handle(req, res, body => forward(req, res, query, body)).catch(() => {
        if (!res.headersSent) res.writeHead(503, { 'cache-control': 'no-store' });
        res.end();
      });
    } else {
      // The receiver validates WeCom's signature and recipient. Preserve the signed query and raw XML.
      void forward(req, res, query);
    }
    return true;
  };
}
