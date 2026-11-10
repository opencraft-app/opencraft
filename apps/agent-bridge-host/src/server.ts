import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { BridgeHost } from './host.js';
import { object, identifier, type Generation } from './types.js';
/** Private attachment only. Closing it cannot close the execution owner. */
export async function attachGateway(host: BridgeHost, token: string, port = 0): Promise<{ server: Server; url: string; close(): Promise<void> }> {
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
          case '/health': result = { pid: process.pid, incarnation: host.incarnation, generations: host.diagnostics() }; break;
          case '/command': result = await host.query(identifier(url.searchParams.get('id'))); break;
          case '/events': result = await host.events(Number(url.searchParams.get('cursor') ?? 0)); break;
          case '/thread': result = await host.threadState(identifier(url.searchParams.get('serverId')), identifier(url.searchParams.get('threadId'))); break;
          case '/snapshot': result = await host.snapshot(); break;
          default: response.writeHead(404).end(); return;
        }
      } else if (request.method === 'POST') {
        let length = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) {
          length += chunk.length; if (length > 600 * 1024) throw Error('Request too large'); chunks.push(chunk);
        }
        const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        switch (url.pathname) {
          case '/command': result = await host.accept(body); break;
          case '/ack': result = await host.ack(Number(body.cursor)); break;
          case '/generation/add': result = await host.add(body as unknown as Generation); break;
          case '/generation/activate': result = await host.activate(identifier(body.id), typeof body.expected === 'string' ? body.expected : ''); break;
          case '/generation/retire': result = await host.retire(identifier(body.id)); break;
          case '/thread/release': result = await host.releaseThread(identifier(body.serverId), identifier(body.threadId)); break;
          default: response.writeHead(404).end(); return;
        }
      } else { response.writeHead(405).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result ?? null));
    } catch (error) {
      const refusal = error as Error & { code?: number; kind?: string };
      const typed = typeof refusal.code === 'number' && typeof refusal.kind === 'string';
      response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify(typed
        ? { error: refusal.message, code: refusal.code, kind: refusal.kind }
        : { error: 'Host request refused; query the original commandId for custody' }));
    }
  });
  server.requestTimeout = 15_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing Host address');
  return { server, url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
