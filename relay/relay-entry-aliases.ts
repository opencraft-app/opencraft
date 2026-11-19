import type { IncomingMessage } from 'node:http';

/** Only approved product entry authorities become request-local browser origins. */
export function joinEntryOrigin(authenticationOrigin: string) {
  const canonical = new URL(authenticationOrigin);
  if (canonical.origin !== authenticationOrigin || !['http:', 'https:'].includes(canonical.protocol)) throw new Error('Invalid Join entry origin');
  const port = canonical.protocol === 'https:' ? '443' : '80';
  const authority = new RegExp('^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)*join\\.woa\\.com(?::' + port + ')?$', 'iu');
  return (request: IncomingMessage): string | null => {
    const host = request.headers.host ?? '';
    return authority.test(host) && host.length <= 253 + port.length + 1 ? new URL(canonical.protocol + '//' + host).origin : null;
  };
}
