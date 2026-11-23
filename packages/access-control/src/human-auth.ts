import { randomBytes, createHash } from 'node:crypto';
import { HttpBodyTooLarge, decodeUtf8, jsonResponse, setCookies, type HttpExchangeRequest, type HttpExchangeResponse, type HttpHeaderList } from '@opencraft/identity-core/http-exchange';
import * as oidc from 'openid-client';
import { parsePrincipal, principalKey, type Principal } from '@opencraft/identity-core';
import { readPrivateJson, type IdentityProvider, type IdentityRequest } from '@opencraft/identity-core/node';
import type { ActorContext } from '@opencraft/identity-core/actors';
import { HumanAccounts, type HumanLogin } from './human-accounts.js';
import type { ActorStore } from './actors.js';
import type { IdentityWrites } from './identity-writes.js';

const BASE = '/__opencraft_auth';
const SESSION = 'oc_human', TRANSACTION = 'oc_human_flow';
const JSON_HEADERS: HttpHeaderList = [['content-type', 'application/json; charset=utf-8'], ['cache-control', 'private, no-store'], ['x-content-type-options', 'nosniff']];
const random = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export interface OidcProviderConfiguration {
  readonly id: string; readonly label: string; readonly issuer: string; readonly clientId: string;
  readonly clientSecret?: string; readonly tokenEndpointAuthMethod?: 'client_secret_basic' | 'client_secret_post' | 'none';
}
export interface HumanAuthConfiguration {
  readonly origin: string; readonly local: boolean; readonly oidc: readonly OidcProviderConfiguration[];
  /** Optional operator-owned bootstrap proof; existing installations remain closed. */
  readonly setupTokenFile?: string;
}
function secureUrl(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('Authentication URL required');
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:'
    && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Authentication URLs require HTTPS (or HTTP loopback)');
  return url;
}
export function parseHumanAuthConfiguration(input: unknown): HumanAuthConfiguration {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid human authentication configuration');
  const v = input as Record<string, unknown>;
  if (Object.keys(v).some(key => !['origin', 'local', 'oidc', 'setupTokenFile'].includes(key))) throw new Error('Unknown authentication option');
  if (v.setupTokenFile !== undefined && (v.local !== true || typeof v.setupTokenFile !== 'string'
    || !v.setupTokenFile.startsWith('/') || v.setupTokenFile.includes('\0'))) throw new Error('Setup requires local accounts and an absolute private token file');
  const origin = secureUrl(v.origin);
  if (origin.origin !== v.origin || typeof v.local !== 'boolean' || !Array.isArray(v.oidc) || v.oidc.length > 16) throw new Error('Invalid authentication origin/providers');
  const ids = new Set<string>();
  const providers = v.oidc.map((item: unknown): OidcProviderConfiguration => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid OIDC provider');
    const p = item as Record<string, unknown>;
    if (Object.keys(p).some(key => !['id', 'label', 'issuer', 'clientId', 'clientSecret', 'tokenEndpointAuthMethod'].includes(key))
      || typeof p.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(p.id) || ids.has(p.id)
      || typeof p.label !== 'string' || !p.label.trim() || p.label.length > 80 || /[\x00-\x1f]/u.test(p.label)
      || typeof p.clientId !== 'string' || !p.clientId || p.clientId.length > 256
      || (p.clientSecret !== undefined && (typeof p.clientSecret !== 'string' || !p.clientSecret || p.clientSecret.length > 4096))
      || (p.tokenEndpointAuthMethod !== undefined && !['none', 'client_secret_basic', 'client_secret_post'].includes(p.tokenEndpointAuthMethod as string))) throw new Error('Invalid OIDC provider');
    secureUrl(p.issuer); ids.add(p.id);
    if ((p.tokenEndpointAuthMethod === 'none' && p.clientSecret !== undefined)
      || (p.tokenEndpointAuthMethod?.toString().startsWith('client_secret_') && p.clientSecret === undefined)) throw new Error('OIDC client authentication mismatch');
    return { id: p.id, label: p.label, issuer: p.issuer as string, clientId: p.clientId,
      ...(typeof p.clientSecret === 'string' ? { clientSecret: p.clientSecret } : {}),
      ...(p.tokenEndpointAuthMethod ? { tokenEndpointAuthMethod: p.tokenEndpointAuthMethod as OidcProviderConfiguration['tokenEndpointAuthMethod'] } : {}) };
  });
  if (!v.local && !providers.length) throw new Error('At least one login method is required');
  return { origin: origin.origin, local: v.local, oidc: providers,
    ...(typeof v.setupTokenFile === 'string' ? { setupTokenFile: v.setupTokenFile } : {}) };
}
export async function readHumanAuthConfiguration(path: string) { return parseHumanAuthConfiguration(await readPrivateJson(path)); }
function cookie(request: IdentityRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header.length > 16_384) return null;
  const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : null;
}
interface Owner { context: ActorContext; binding: string; loginDigest: string | null; }
interface Flow {
  browser: string; provider: OidcProviderConfiguration; verifier: string; nonce: string;
  expiresAt: number; returnTo: string; owner: Owner | null; used: boolean;
}
export class HumanAuth implements IdentityProvider {
  readonly #proofs = new WeakMap<Principal, HumanLogin>();
  readonly #flows = new Map<string, Flow>();
  readonly #clients = new Map<string, Promise<oidc.Configuration>>();
  readonly #attempts = new Map<string, { until: number; count: number }>();
  #globalAttempts = { until: 0, count: 0 };
  #writes: IdentityWrites | null = null;
  /** Login, logout and identity binding writes go to the Server owner from now on. */
  useOwnerWrites(writes: IdentityWrites): void { this.#writes = writes; }
  constructor(readonly accounts: HumanAccounts, readonly actors: ActorStore, readonly configuration: HumanAuthConfiguration,
    readonly renderPage: (nonce: string) => string,
    readonly externalHuman: (request: IdentityRequest) => Principal | null = () => null, readonly now = Date.now) {
    if (configuration.local && !accounts.localAccounts) throw new Error('Local account plugin required by authentication configuration');
  }
  authenticate(request: IdentityRequest): Principal | null {
    const token = cookie(request, SESSION), login = token ? this.accounts.authenticate(token) : null;
    if (!login) return null;
    this.#proofs.set(login.principal, login); return login.principal;
  }
  /** Trusted account application only; authentication proof stays server-owned. */
  currentLogin(request: IdentityRequest): HumanLogin | null {
    const value = cookie(request, SESSION); return value ? this.accounts.authenticate(value) : null;
  }
  /** Resolves after the login committed with the `set-cookie` values the response must carry. */
  issueSession(principal: Principal, request: IdentityRequest): Promise<string[]> {
    return this.#issue(principal, request);
  }
  hasSessionCookie(request: IdentityRequest): boolean {
    return typeof request.headers.cookie === 'string' && request.headers.cookie.split(';').some(part => part.trim().startsWith(SESSION + '='));
  }
  invalidSession(request: IdentityRequest): boolean { return this.hasSessionCookie(request) && this.authenticate(request) === null; }
  isCurrent(principal: Principal): boolean {
    const login = this.#proofs.get(principal);
    return !!login && this.accounts.byDigest(login.digest) !== null;
  }
  /** Private, non-bearer reference for durable device consent. Never sent to a browser. */
  notificationLoginDigest(request: IdentityRequest): string | undefined {
    const token = cookie(request, SESSION);
    return token ? this.accounts.authenticate(token)?.digest : undefined;
  }
  trustedOrigin(request: IdentityRequest): string | null { return this.authenticate(request) ? this.configuration.origin : null; }
  #owner(request: IdentityRequest): Owner | null {
    if (request.headers.authorization !== undefined) return null;
    const token = cookie(request, SESSION), login = token ? this.accounts.authenticate(token) : null;
    if (login) return this.now() - login.createdAt <= 10 * 60_000
      ? { context: login.context, binding: principalKey(login.principal), loginDigest: login.digest } : null;
    // An invalid/old browser cookie must not fall back to another identity.
    if (token !== null) return null;
    const principal = this.externalHuman(request);
    const context = principal && this.actors.resolveHuman(principal);
    return context && principal ? { context, binding: principalKey(principal), loginDigest: null } : null;
  }
  #sameOwner(request: IdentityRequest, owner: Owner): boolean {
    const current = this.#owner(request);
    return !!current && this.actors.isCurrent(owner.context) && current.context.actorId === owner.context.actorId
      && current.context.generation === owner.context.generation && current.binding === owner.binding && current.loginDigest === owner.loginDigest;
  }
  #cookie(name: string, value: string, maxAge: number) {
    return `${name}=${value}; Path=${name === TRANSACTION ? BASE : '/'}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.configuration.origin.startsWith('https:') ? '; Secure' : ''}`;
  }
  #cancel(request: IdentityRequest) {
    const browser = cookie(request, TRANSACTION);
    if (browser) for (const [state, flow] of this.#flows) if (flow.browser === digest(browser)) this.#flows.delete(state);
  }
  #limit(request: HttpExchangeRequest): boolean {
    const now = this.now();
    if (this.#globalAttempts.until <= now) this.#globalAttempts = { until: now + 60_000, count: 0 };
    if (++this.#globalAttempts.count > 60) return false;
    for (const [key, value] of this.#attempts) if (value.until <= now) this.#attempts.delete(key);
    const address = request.clientAddress ?? 'unknown';
    const entry = this.#attempts.get(address) ?? { until: now + 60_000, count: 0 };
    if (!this.#attempts.has(address) && this.#attempts.size >= 1024) return false;
    this.#attempts.set(address, entry); return ++entry.count <= 12;
  }
  async #client(provider: OidcProviderConfiguration): Promise<oidc.Configuration> {
    let pending = this.#clients.get(provider.id);
    if (!pending) {
      const authentication = provider.tokenEndpointAuthMethod === 'none' || !provider.clientSecret ? oidc.None()
        : provider.tokenEndpointAuthMethod === 'client_secret_basic' ? oidc.ClientSecretBasic(provider.clientSecret) : oidc.ClientSecretPost(provider.clientSecret);
      pending = oidc.discovery(new URL(provider.issuer), provider.clientId, undefined, authentication,
        { timeout: 10, execute: [...(provider.issuer.startsWith('http:') ? [oidc.allowInsecureRequests] : []), oidc.enableNonRepudiationChecks] })
        .then(client => {
          const metadata = client.serverMetadata();
          for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) secureUrl(endpoint);
          return client;
        });
      this.#clients.set(provider.id, pending);
      pending.catch(() => { if (this.#clients.get(provider.id) === pending) this.#clients.delete(provider.id); });
    }
    return pending;
  }
  async #issue(principal: Principal, request: IdentityRequest): Promise<string[]> {
    const token = cookie(request, SESSION);
    const issued = this.#writes ? await this.#writes.issueLogin(principal) : this.accounts.issue(principal);
    if (token) await this.#revoke(token);
    return [this.#cookie(SESSION, issued.token, Math.max(1, Math.floor((issued.login.context.expiresAt - this.now()) / 1000))),
      this.#cookie(TRANSACTION, '', 0)];
  }
  #revoke(token: string): Promise<void> | void {
    return this.#writes ? this.#writes.revokeLogin(token) : this.accounts.revoke(token);
  }
  #bind(owner: ActorContext, principal: Principal): Promise<void> | void {
    if (this.#writes) return this.#writes.bindHuman(owner, principal);
    this.actors.bindHuman(owner, principal);
  }
  /** Login routes under `/__opencraft_auth`; null for any other path. */
  async handle(request: HttpExchangeRequest): Promise<HttpExchangeResponse | null> {
    const url = new URL(request.path, this.configuration.origin), path = url.pathname, identity = request.identity;
    if (path !== BASE && !path.startsWith(BASE + '/')) return null;
    const send = (status: number, value: unknown, before: HttpHeaderList = []) => jsonResponse(status, value, JSON_HEADERS, before);
    if (url.origin !== this.configuration.origin || request.headers.host !== new URL(this.configuration.origin).host || request.headers.authorization !== undefined) return send(403, { error: 'origin_required' });
    for (const [state, flow] of this.#flows) if (flow.expiresAt <= this.now()) this.#flows.delete(state);
    if (request.method === 'GET' && (path === BASE || path === BASE + '/')) {
      const nonce = random();
      return { status: 200, headers: [['content-type', 'text/html; charset=utf-8'], ['cache-control', 'private, no-store'],
        ['x-content-type-options', 'nosniff'], ['referrer-policy', 'no-referrer'],
        ['content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`]],
        body: this.renderPage(nonce) };
    }
    if (request.method === 'GET' && path === BASE + '/session') {
      const p = this.hasSessionCookie(identity) ? this.authenticate(identity) : this.externalHuman(identity), a = p && this.actors.findHuman(p);
      return send(200, { local: this.configuration.local && !!this.accounts.localAccounts,
        localPlugin: this.configuration.local && this.accounts.localAccounts ? { id: this.accounts.localAccounts.id, label: this.accounts.localAccounts.label } : null, providers: this.configuration.oidc.map(p => ({ id: p.id, label: p.label })),
        actor: a?.enabled ? { id: a.id, displayName: a.displayName } : null,
        bindings: a?.enabled ? this.actors.bindings(a.id).map(binding => ({ ...binding, label: this.accounts.bindingLabel(binding) })) : [],
        recent: this.#owner(identity) !== null });
    }
    if (request.method === 'GET' && path.startsWith(BASE + '/oidc/callback/')) {
      const state = url.searchParams.get('state') ?? '', flow = this.#flows.get(state), browser = cookie(identity, TRANSACTION);
      if (!flow || flow.used || !browser || digest(browser) !== flow.browser || path !== `${BASE}/oidc/callback/${flow.provider.id}`) return send(400, { error: 'login_expired' });
      flow.used = true;
      try {
        if (flow.owner && !this.#sameOwner(identity, flow.owner)) throw new Error('Owner changed');
        const client = await this.#client(flow.provider);
        const tokens = await oidc.authorizationCodeGrant(client, url,
          { pkceCodeVerifier: flow.verifier, expectedState: state, expectedNonce: flow.nonce, idTokenExpected: true,
            ...(flow.owner ? { maxAge: 300 } : {}) });
        const claims = tokens.claims()!;
        if (claims.iss !== flow.provider.issuer || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new Error('Invalid OIDC identity');
        if (this.#flows.get(state) !== flow || flow.expiresAt <= this.now() || request.signal.aborted
          || (flow.owner && !this.#sameOwner(identity, flow.owner))) throw new Error('Login cancelled');
        const subject = digest(JSON.stringify([claims.iss, claims.sub]));
        const displayName = typeof claims.name === 'string' && claims.name.trim() && claims.name.length <= 256 && !/[\x00-\x1f]/u.test(claims.name) ? claims.name : flow.provider.label;
        const principal = parsePrincipal({ provider: 'oidc', subject, displayName, expiresAt: Math.min(claims.exp * 1000, this.now() + 8 * 3600_000) });
        if (flow.owner) await this.#bind(flow.owner.context, principal);
        const cookies = await this.#issue(principal, identity);
        const username = typeof claims.preferred_username === 'string' && claims.preferred_username.trim()
          && claims.preferred_username.length <= 256 && !/[\x00-\x1f]/u.test(claims.preferred_username) ? claims.preferred_username : displayName;
        const label = flow.provider.label + ' · ' + username;
        if (this.#writes) await this.#writes.rememberLabel(principal, label); else this.accounts.rememberLabel(principal, label);
        return { status: 303, headers: [...setCookies(cookies), ['location', flow.returnTo], ['cache-control', 'no-store'], ['referrer-policy', 'no-referrer']], body: null };
      } catch {
        // A failure after issue still answers with only the transaction reset.
        return { status: 303, headers: [...setCookies([this.#cookie(TRANSACTION, '', 0)]), ['location', BASE + '/?error=login_failed'],
          ['cache-control', 'no-store'], ['referrer-policy', 'no-referrer']], body: null };
      } finally { this.#flows.delete(state); }
    }
    if (request.method !== 'POST') return send(404, { error: 'missing' });
    if (request.headers.origin !== this.configuration.origin || request.headers['content-type']?.split(';')[0] !== 'application/json') return send(403, { error: 'same_origin_json_required' });
    if (['/local', '/local/create', '/oidc/start'].some(suffix => path === BASE + suffix) && !this.#limit(request))
      return send(429, { error: 'try_later' }, [['retry-after', '60']]);
    try {
      const body = JSON.parse(decodeUtf8(await request.readBody(16_384)));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request');
      const fields: Record<string, readonly string[]> = {
        '/logout': [], '/cancel': [], '/local': ['mode', 'username', 'password'], '/local/create': ['mode', 'username', 'password'],
        '/unbind': ['provider', 'subject'], '/oidc/start': ['mode', 'provider'],
      };
      const allowed = fields[path.slice(BASE.length)];
      if (!allowed || Object.keys(body).length !== allowed.length || Object.keys(body).some(key => !allowed.includes(key))) throw new Error('Invalid request fields');
      if (path === BASE + '/logout' || path === BASE + '/cancel') {
        this.#cancel(identity);
        const token = cookie(identity, SESSION);
        if (path.endsWith('/logout') && token) await this.#revoke(token);
        return send(200, { ok: true }, setCookies([this.#cookie(TRANSACTION, '', 0), ...(path.endsWith('/logout') ? [this.#cookie(SESSION, '', 0)] : [])]));
      }
      if (path === BASE + '/local' || path === BASE + '/local/create') {
        const localAccounts = this.configuration.local ? this.accounts.localAccounts : null;
        if (!localAccounts) return send(404, { error: 'missing' });
        const linking = path.endsWith('/create') || body.mode === 'link';
        if (!['login', 'link'].includes(body.mode) || (path.endsWith('/create') && body.mode !== 'link')
          || typeof body.username !== 'string' || typeof body.password !== 'string') throw new Error('Invalid local login');
        const owner = linking ? this.#owner(identity) : null;
        if (linking && !owner) return send(401, { error: 'recent_login_required' });
        const principal = path.endsWith('/create')
          ? await localAccounts.create(body.username, body.username, body.password) : await localAccounts.verify(body.username, body.password);
        if (!principal) return send(401, { error: 'invalid_credentials' });
        if (this.accounts.localAccounts !== localAccounts || localAccounts.verifiedVersion(principal) === null) throw new Error('Local account plugin changed');
        if (owner) {
          if (!this.#sameOwner(identity, owner)) throw new Error('Owner changed');
          await this.#bind(owner.context, principal);
        }
        this.#cancel(identity); return send(200, { ok: true }, setCookies(await this.#issue(principal, identity)));
      }
      if (path === BASE + '/unbind') {
        const owner = this.#owner(identity);
        if (!owner) return send(401, { error: 'recent_login_required' });
        const binding = parsePrincipal({ provider: body.provider, subject: body.subject, displayName: 'binding', expiresAt: this.now() + 1000 });
        if (this.#writes) await this.#writes.unbindHuman(owner.context, binding); else this.actors.unbindHuman(owner.context, binding);
        const token = cookie(identity, SESSION); if (token) await this.#revoke(token);
        this.#cancel(identity);
        return send(200, { ok: true }, setCookies([this.#cookie(SESSION, '', 0), this.#cookie(TRANSACTION, '', 0)]));
      }
      if (path === BASE + '/oidc/start') {
        const provider = this.configuration.oidc.find(p => p.id === body.provider);
        if (!provider || !['login', 'link'].includes(body.mode)) throw new Error('Invalid provider');
        const owner = body.mode === 'link' ? this.#owner(identity) : null;
        if (body.mode === 'link' && !owner) return send(401, { error: 'recent_login_required' });
        const client = await this.#client(provider);
        if (owner && !this.#sameOwner(identity, owner)) throw new Error('Owner changed');
        this.#cancel(identity);
        if (this.#flows.size >= 1024) throw new Error('Too many pending logins');
        const state = random(), browser = random(), verifier = oidc.randomPKCECodeVerifier(), nonce = oidc.randomNonce();
        const redirectTo = oidc.buildAuthorizationUrl(client, { redirect_uri: `${this.configuration.origin}${BASE}/oidc/callback/${provider.id}`,
          scope: 'openid profile', state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
          ...(owner ? { prompt: 'login', max_age: '0' } : {}) });
        const returnTo = owner ? BASE + '/' : '/';
        this.#flows.set(state, { browser: digest(browser), provider, verifier, nonce, expiresAt: this.now() + 10 * 60_000, returnTo, owner, used: false });
        return send(200, { redirectTo: redirectTo.href }, setCookies([this.#cookie(TRANSACTION, browser, 600)]));
      }
      return send(404, { error: 'missing' });
    } catch (error) {
      return error instanceof HttpBodyTooLarge ? send(413, { error: 'too_large' }) : send(400, { error: 'login_failed' });
    }
  }
  close() { this.#flows.clear(); this.#clients.clear(); }
}
