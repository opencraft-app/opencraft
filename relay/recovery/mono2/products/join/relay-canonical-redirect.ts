import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/** The legacy browser entry moves domains; instance and Hub identities do not. */
export function redirectLegacyJoinEntry(request: IncomingMessage, response: ServerResponse): boolean {
  if (!/^join\.devcloud\.woa\.com(?::(?:80|443))?$/iu.test(request.headers.host ?? '')) return false;
  const target = request.url ?? '/';
  if (!target.startsWith('/') || /[\x00-\x20\x7f]/u.test(target)) return false;
  response.writeHead(308, { location: `https://join.woa.com${target}`, 'cache-control': 'max-age=3600' });
  response.end();
  return true;
}

/** Wrap the product listener without changing the shared Relay or its upgrades. */
export function installJoinCanonicalRedirect(server: Server): void {
  const listeners = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    if (redirectLegacyJoinEntry(request, response)) return;
    for (const listener of listeners) listener.call(server, request, response);
  });
}
