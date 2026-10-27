import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/** Local example server: exposes only the example module, never the checkout. */
export function createExtensionExampleServer() {
  return createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    response.setHeader('Cache-Control', 'no-store');
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path !== '/hello.mjs') { response.writeHead(404).end(); return; }
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' }).end(); return;
    }
    readFile(new URL('./hello.mjs', import.meta.url)).then(code => {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : code);
    }).catch(() => { response.writeHead(500).end('Example module unavailable'); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 5174);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Expected a TCP port (0–65535)');
  const server = createExtensionExampleServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Install http://127.0.0.1:${server.address().port}/hello.mjs in the local HTTP Workbench`);
  });
}
