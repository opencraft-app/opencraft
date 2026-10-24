import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { isAbsolute } from 'node:path';

const proofHeader = 'x-opencraft-local-machine-proof';
const normalize = address => address?.startsWith('::ffff:') ? address.slice(7) : address;
const loopback = address => address === '::1' || /^127\./u.test(address ?? '');
const forwarded = request => Object.keys(request.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-'));

/** Operator opt-in for the anonymous workspace on this machine, independent of human identity. */
export async function loadLocalMachineAccess(path) {
  if (path === undefined || path === null) return null;
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Local machine access requires an absolute private file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let key;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 256 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('Invalid local machine access file');
    const text = (await handle.readFile('utf8')).trim();
    if (!/^[a-f0-9]{64}$/u.test(text)) throw new Error('Invalid local machine access file');
    key = Buffer.from(text, 'hex');
  } finally { await handle.close(); }
  const addresses = new Set(Object.values(networkInterfaces()).flatMap(entries => (entries ?? []).map(entry => normalize(entry.address))));
  const origin = request => {
    try {
      const host = request.headers.host;
      if (typeof host !== 'string') return null;
      const url = new URL('http://' + host);
      const address = normalize(url.hostname.replace(/^\[|\]$/gu, ''));
      if ((url.host !== host && host !== url.hostname + ':80') || url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || (!isIP(address) && address !== 'localhost') || (address !== 'localhost' && !addresses.has(address))) return null;
      if (request.headers.origin !== undefined && request.headers.origin !== url.origin) return null;
      if (request.headers['sec-fetch-site'] === 'cross-site' || forwarded(request)) return null;
      return url.origin;
    } catch { return null; }
  };
  const sign = (request, browserOrigin, timestamp, probe = false) => createHmac('sha256', key)
    .update(JSON.stringify([timestamp, probe ? request.headers['x-opencraft-relay-probe-method'] : request.method,
      probe ? request.headers['x-opencraft-relay-probe-path'] : request.url, browserOrigin])).digest('hex');
  return {
    /** Runs before any public ingress proxy: never infer provenance at a downstream loopback hop. */
    forward(request) {
      delete request.headers[proofHeader];
      // Enrollment and relay control/data sockets retain their separate credential authority.
      if (request.url?.startsWith('/__opencraft_relay/')) return false;
      const browserOrigin = origin(request);
      const peer = normalize(request.socket.remoteAddress), target = normalize(request.socket.localAddress);
      if (!browserOrigin || !addresses.has(peer) || !addresses.has(target) || !(peer === target || loopback(peer))) return false;
      const url = new URL(browserOrigin), host = normalize(url.hostname.replace(/^\[|\]$/gu, ''));
      if ((host === 'localhost' ? !loopback(target) : host !== target) || Number(url.port || 80) !== request.socket.localPort) return false;
      const timestamp = String(Date.now());
      request.headers[proofHeader] = timestamp + '.' + sign(request, browserOrigin, timestamp);
      return true;
    },
    /** Only the protected local hop can convey this proof; the browser never receives it. */
    origin(request) {
      const browserOrigin = origin(request), proof = request.headers[proofHeader];
      if (!browserOrigin || !loopback(normalize(request.socket.remoteAddress)) || typeof proof !== 'string') return null;
      const match = /^(\d{13})\.([a-f0-9]{64})$/u.exec(proof);
      if (!match || Math.abs(Date.now() - Number(match[1])) > 15_000) return null;
      const probe = request.method === 'GET' && request.url === '/__opencraft_access/admission'
        && typeof request.headers['x-opencraft-relay-probe-method'] === 'string'
        && typeof request.headers['x-opencraft-relay-probe-path'] === 'string';
      return timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(sign(request, browserOrigin, match[1], probe), 'hex')) ? browserOrigin : null;
    },
  };
}
