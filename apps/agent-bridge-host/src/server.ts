import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { BridgeHost } from './host.js';
import { BRIDGE_MAX_FRAME_BYTES } from '@opencraft/agent-bridge-protocol';
import { BRIDGE_HISTORY_SELECTION_LIMIT, object, identifier, isOutboxId, oversizedBridgeRequest, type Generation } from './types.js';

function gatewayServer(host: BridgeHost, token: string): Server {
  if (Buffer.byteLength(token) < 32) throw Error('Private Host requires a token of at least 32 bytes');
  const server = createServer(async (request, response) => {
    if(request.url==='/thread-cli') {
      if(request.headers.origin!==undefined||request.method!=='POST'){response.writeHead(403).end();return;}
      try {
        let bytes=0;const chunks:Buffer[]=[];
        for await(const chunk of request){bytes+=chunk.length;if(bytes>64*1024)throw Error();chunks.push(chunk);}
        const auth=request.headers.authorization??'';
        if(!auth.startsWith('Bearer '))throw Error();
        const reply=await host.cli(auth.slice(7),JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(reply.status,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(reply.body));
      }catch{response.writeHead(403,{'content-type':'application/json'}).end(JSON.stringify({error:'cliUnavailable'}));}return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (request.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(401).end(); return;
    }
    try {
      const url = new URL(request.url!, 'http://localhost');
      let result: unknown;
      if (request.method === 'GET') {
        switch (url.pathname) {
          case '/script/capabilities': result=host.scriptCapabilities();break;
          case '/script/show': result=await host.scriptResult(identifier(url.searchParams.get('key')));break;
          case '/health': result = { pid: process.pid, incarnation: host.incarnation, generations: host.diagnostics() }; break;
          case '/command': result = await host.query(identifier(url.searchParams.get('id'))); break;
          case '/events': {
            const fragment = url.searchParams.get('fragment');
            result = await host.events(Number(url.searchParams.get('cursor') ?? 0), undefined,
              url.searchParams.get('fenced') === '1', fragment === null ? undefined : Number(fragment));
            break;
          }
          case '/thread': result = await host.threadState(identifier(url.searchParams.get('serverId')), identifier(url.searchParams.get('threadId'))); break;
          case '/history-identities': {
            const through = url.searchParams.get('through');
            result = await host.historyIdentities(
              identifier(url.searchParams.get('serverId')), identifier(url.searchParams.get('threadId')),
              Number(url.searchParams.get('after') ?? 0), through === null ? undefined : Number(through),
            );
            break;
          }
          case '/snapshot': result = await host.snapshot(url.searchParams.get('adoptionOwnership') === '1'); break;
          case '/maintenance': result = await host.maintenance(); break;
          default: response.writeHead(404).end(); return;
        }
      } else if (request.method === 'POST') {
        let length = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) {
          length += chunk.length;
          if (length > BRIDGE_MAX_FRAME_BYTES) throw oversizedBridgeRequest(BRIDGE_MAX_FRAME_BYTES);
          chunks.push(chunk);
        }
        const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        switch (url.pathname) {
          case '/script/run': result=await host.script(body);break;
          case '/command': result = await host.accept(body); break;
          case '/observe': result = await host.observe(body); break;
          case '/history-identities': {
            const { nativeIds, publicTurnId, publicTurnIds } = object(body.selection);
            if (!Array.isArray(nativeIds) || nativeIds.length > BRIDGE_HISTORY_SELECTION_LIMIT ||
                (publicTurnIds !== undefined && (!Array.isArray(publicTurnIds) ||
                  publicTurnIds.length + nativeIds.length > BRIDGE_HISTORY_SELECTION_LIMIT)))
              throw Error('Invalid history identity selection');
            if (typeof body.after !== 'number' || (body.through !== undefined && typeof body.through !== 'number'))
              throw Error('Invalid history identity cursor');
            result = await host.historyIdentities(identifier(body.serverId), identifier(body.threadId),
              body.after, body.through, {
                nativeIds: nativeIds.map(identifier),
                ...(publicTurnId === undefined ? {} : { publicTurnId: identifier(publicTurnId) }),
                ...(publicTurnIds === undefined ? {} : { publicTurnIds: publicTurnIds.map(identifier) }),
              });
            break;
          }
          case '/queue': result = await host.queueRequest(body); break;
          case '/ack': {
            const { outboxId } = body;
            if (outboxId !== undefined && !isOutboxId(outboxId)) throw Error('Invalid outbox identity');
            result = await host.ack(Number(body.cursor), outboxId);
            break;
          }
          case '/generation/add': result = await host.add(body as unknown as Generation); break;
          case '/generation/activate': result = await host.activate(identifier(body.id), typeof body.expected === 'string' ? body.expected : ''); break;
          case '/generation/retire': result = await host.retire(identifier(body.id)); break;
          case '/thread/release': result = await host.releaseThread(identifier(body.serverId), identifier(body.threadId)); break;
          default: response.writeHead(404).end(); return;
        }
      } else { response.writeHead(405).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result ?? null));
    } catch (error) {
      const refusal = error as Error & { code?: number; kind?: string; data?: unknown };
      const typed = typeof refusal.code === 'number' && typeof refusal.kind === 'string';
      // The caller only learns to query custody; the operator sees why.
      if (!typed) process.stderr.write(`host-request-refused:${request.url}:${String(refusal?.message ?? refusal).slice(0, 300)}\n`);
      response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify(typed
        ? { error: refusal.message, code: refusal.code, kind: refusal.kind, data: refusal.data }
        : { error: 'Host request refused; query the original commandId for custody' }));
    }
  });
  server.requestTimeout = 15_000;
  return server;
}

function closeGateway(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}

function listen(server: Server, address: number | string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const ready = () => { server.off('error', reject); resolve(); };
    if (typeof address === 'number') server.listen(address, '127.0.0.1', ready);
    else server.listen(address, ready);
  });
}

/** Private attachment only. Closing it cannot close the execution owner. */
export async function attachGateway(host: BridgeHost, token: string, port = 0): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const server = gatewayServer(host, token);
  await listen(server, port);
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing Host address');
  return { server, url: `http://127.0.0.1:${address.port}`, close: () => closeGateway(server) };
}

/** Same authenticated RPC served on the workspace agent's private socket. */
export async function attachGatewaySocket(host: BridgeHost, token: string, socketPath: string) {
  if (!isAbsolute(socketPath) || socketPath.includes('\0')) throw Error('Absolute private Bridge socket required');
  const server = gatewayServer(host, token);
  await listen(server, socketPath);
  try {
    await chmod(socketPath, 0o600);
  } catch (error) {
    await closeGateway(server).catch(() => {});
    throw error;
  }
  return { server, socketPath, close: () => closeGateway(server) };
}
