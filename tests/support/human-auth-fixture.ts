import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes, createHash, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorStore } from '../../packages/access-control/src/actors';
import { HumanAccounts } from '../../packages/access-control/src/human-accounts';
import { LocalAccountServerPlugin } from '../../plugins/local-account/src/server';
import { HumanAuth } from '../../packages/access-control/src/human-auth';
import { ActorAccess } from '../../packages/access-control/src/actor-access';
import { InstanceAccess, MembershipStore } from '../../packages/access-control/src/index';
import { humanLoginPage } from '../../scripts/human-login-page';
import { createWorkbenchWebServer } from '../../scripts/serve-workbench-web.mjs';

export async function mockIssuer() {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'RS256' };
  const codes = new Map<string, URLSearchParams>();
  let origin = '', subject = 'person-one', patch: Record<string, unknown> = {}, badSignature = false;
  let blocked: { entered: () => void; resume: Promise<void> } | null = null;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin);
      const json = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/.well-known/openid-configuration') return json({ issuer: origin, authorization_endpoint: origin + '/authorize',
        token_endpoint: origin + '/token', jwks_uri: origin + '/jwks', response_types_supported: ['code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'] });
      if (url.pathname === '/jwks') return json({ keys: [publicKey] });
      if (url.pathname === '/authorize') {
        const code = randomBytes(20).toString('hex'); codes.set(code, url.searchParams);
        const redirect = new URL(url.searchParams.get('redirect_uri')!); redirect.searchParams.set('code', code); redirect.searchParams.set('state', url.searchParams.get('state')!);
        res.writeHead(302, { location: redirect.href }); res.end(); return;
      }
      if (url.pathname === '/token') {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const form = new URLSearchParams(Buffer.concat(chunks).toString()), request = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!request || form.get('client_id') !== 'fixture-client' || form.get('client_secret') !== 'fixture-client-secret'
          || form.get('redirect_uri') !== request.get('redirect_uri') || request.get('code_challenge_method') !== 'S256'
          || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== request.get('code_challenge')) return json({ error: 'invalid_grant' }, 400);
        if (blocked) { const held = blocked; held.entered(); await held.resume; }
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: origin, sub: subject, aud: 'fixture-client', iat: now, exp: now + 3600, auth_time: now,
          nonce: request.get('nonce'), name: 'Example Person', email: 'same@example.test', ...patch };
        const payload = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url') + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url');
        const jwt = payload + '.' + sign('RSA-SHA256', Buffer.from(payload), badSignature ? other.privateKey : keys.privateKey).toString('base64url');
        return json({ access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 3600, id_token: jwt });
      }
      res.writeHead(404); res.end();
    } catch { res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${(server.address() as any).port}`;
  return { origin, setSubject(value: string) { subject = value; }, setClaims(value: Record<string, unknown>) { patch = value; },
    setBadSignature(value: boolean) { badSignature = value; },
    holdToken() {
      let entered!: () => void, resume!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      const resumed = new Promise<void>(resolve => { resume = resolve; }); blocked = { entered, resume: resumed };
      return { reached, resume() { blocked = null; resume(); } };
    },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

export class AuthBrowser {
  readonly cookies = new Map<string, string>();
  constructor(readonly origin: string) {}
  get cookie() { return [...this.cookies].map(([key, value]) => key + '=' + value).join('; '); }
  async call(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(this.origin + path, { redirect: 'manual',
      headers: { cookie: this.cookie, ...(body === undefined ? {} : { origin: this.origin, 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) {
      const [name, token] = value.split(';')[0]!.split('=');
      if (token) this.cookies.set(name!, token); else this.cookies.delete(name!);
    }
    return response;
  }
  async start(mode = 'login') {
    const response = await this.call('/__opencraft_auth/oidc/start', { provider: 'enterprise', mode });
    if (response.status !== 200) throw new Error('Fixture could not start login: ' + response.status + ' ' + await response.text());
    const redirect = await response.json() as any;
    const authorization = await fetch(redirect.redirectTo, { redirect: 'manual' });
    const callback = new URL(authorization.headers.get('location')!);
    return callback.pathname + callback.search;
  }
}

export async function humanAuthFixture(t: any, protectedInstance = true) {
  const directory = await mkdtemp(join(tmpdir(), 'opencraft-human-auth-'));
  const issuer = await mockIssuer();
  const actors = new ActorStore(join(directory, 'actors.sqlite'));
  const accounts = new HumanAccounts(join(directory, 'human-logins.sqlite'), actors);
  const localAccounts = new LocalAccountServerPlugin(accounts.localAccountRepository);
  const deactivateLocal = accounts.registerLocalAccounts(localAccounts);
  const members = new MembershipStore(join(directory, 'memberships.sqlite'));
  const configuration = { origin: 'http://127.0.0.1', local: true, oidc: [{ id: 'enterprise', label: '企业单点登录', issuer: issuer.origin,
    clientId: 'fixture-client', clientSecret: 'fixture-client-secret' }] };
  const auth = new HumanAuth(accounts, actors, configuration, humanLoginPage);
  const access = new InstanceAccess(members, [auth], actors);
  const actorAccess = new ActorAccess(actors, { authenticateHuman: r => access.authenticate(r), admitted: p => !protectedInstance || access.role(p) !== null,
    administrator: p => access.role(p) === 'admin', isHumanCurrent: p => auth.isCurrent(p),
    rejectHumanRequest: r => auth.invalidSession(r) || (auth.hasSessionCookie(r) && r.headers.authorization !== undefined) });
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>Workbench fixture</title>');
  const web = await createWorkbenchWebServer({ root: directory, appServerTarget: null, authService: auth, actorService: actorAccess,
    ...(protectedInstance ? { accessService: access } : {}),
    desktopAccess: 'trusted-internal', desktopService: { accept(ws: any) { ws.send('connected'); } }, onAppHostDiagnostic() {} });
  const address = await web.listen({ host: '127.0.0.1', port: 0 }); configuration.origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await web.close(); auth.close(); accounts.close(); members.close(); actors.close(); await issuer.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, issuer, actors, accounts, localAccounts, deactivateLocal, members, auth, access, actorAccess, origin: configuration.origin, browser: () => new AuthBrowser(configuration.origin) };
}
