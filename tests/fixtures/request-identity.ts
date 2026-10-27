import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { parsePrincipal, type Principal } from '@opencraft/identity-core';
import type { IdentityProvider } from '@opencraft/identity-core/node';
import type { WorkbenchRequestIdentity } from '@opencraft/app-host-server';

// Synthetic proof for generic gateway tests. No product verifier, routes or credentials.
const key = Buffer.alloc(32, 91);
type Request = Pick<IncomingMessage, 'headers'>;
export function signedFixtureIdentity(subject = 123, displayName = 'employee.one', expiresAt = Date.now() + 60_000) {
  const proof = Buffer.from(JSON.stringify({ provider: 'fixture', subject: String(subject), displayName, expiresAt })).toString('base64url');
  return { 'x-fixture-proof': proof, 'x-fixture-signature': createHmac('sha256', key).update(proof).digest('hex') };
}
export class FixtureRequestIdentity implements WorkbenchRequestIdentity {
  constructor(private readonly resolve: (request: Request) => Principal | null = request => {
    try {
      const proof = request.headers['x-fixture-proof'], signature = request.headers['x-fixture-signature'];
      if (typeof proof !== 'string' || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return null;
      const expected = createHmac('sha256', key).update(proof).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return null;
      return parsePrincipal(JSON.parse(Buffer.from(proof, 'base64url').toString()));
    } catch { return null; }
  }) {}
  authenticate(request: Request): Principal | null {
    const principal = this.resolve(request);
    return principal && principal.expiresAt > Date.now() ? principal : null;
  }
  identityProvider(): IdentityProvider { return { authenticate: request => this.authenticate(request) }; }
  admissionStatus(request: Request): 204 | 401 { return this.authenticate(request) ? 204 : 401; }
  connectionContext(request: Request) {
    const principal = this.authenticate(request);
    return principal ? { sender: null, validUntil: principal.expiresAt } : null;
  }
  handle: WorkbenchRequestIdentity['handle'] = (request, response) => {
    if (request.url !== '/__opencraft_fixture/session') return false;
    const principal = this.authenticate(request);
    response.writeHead(principal ? 200 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ principal }));
    return true;
  };
  close() {}
}
