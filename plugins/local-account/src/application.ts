import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HumanAuth } from '@opencraft/access-control/human-auth';
import { AccountManagementError, type HumanAccountManagement } from '@opencraft/access-control/account-management';
import type { IdentityRequest } from '@opencraft/identity-core/node';
import type { Principal } from '@opencraft/identity-core';
import type { ActorContext } from '@opencraft/identity-core/actors';
import { accountPage } from './page.js';
import { remoteServerOrigin } from './connections.js';
import { serverDocumentStyles } from '@opencraft/design-system/document.web';

export const ACCOUNT_BASE = '/__opencraft_account';
const checksum = (text: string) => createHash('sha256').update(text).digest();
function error(code: string, status = 400): never { throw new AccountManagementError(code, status); }
export interface AccountApplicationOptions {
  readonly auth: HumanAuth;
  readonly management: HumanAccountManagement;
  readonly setupToken?: string;
  /** Set only by a compiled native host using a private browser-session proof. */
  readonly nativeOwner?: (request: IncomingMessage) => boolean;
  readonly openRemote?: (origin: string) => Promise<void>;
}
/** First-party trusted server entry; the same plugin supplies the client Settings entry. */
export class LocalAccountApplication {
  readonly #attempts = new Map<string, { until: number; count: number }>();
  #attemptWindow = { until: 0, count: 0 };
  #closed = false;
  constructor(readonly options: AccountApplicationOptions) {
    if (options.setupToken !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(options.setupToken)) throw new Error('Invalid private setup proof');
  }
  get origin() { return this.options.auth.configuration.origin; }
  authenticate(request: IdentityRequest): Principal | null { return this.options.auth.authenticate(request); }
  trustedOrigin(request: IdentityRequest) { return this.options.auth.trustedOrigin(request); }
  isCurrent(principal: Principal) { return this.options.auth.isCurrent(principal); }
  invalidSession(request: IdentityRequest) { return this.options.auth.invalidSession(request); }
  hasSessionCookie(request: IdentityRequest) { return this.options.auth.hasSessionCookie(request); }
  #owner(request: IncomingMessage, recent = false): ActorContext {
    const login = this.options.auth.currentLogin(request);
    if (!login || (recent && login.createdAt < Date.now() - 600_000)) error('recent_login_required', 401);
    return login.context;
  }
  #rateLimit(request: IncomingMessage) {
    const now = Date.now();
    for (const [key, value] of this.#attempts) if (value.until <= now) this.#attempts.delete(key);
    if (this.#attemptWindow.until <= now) this.#attemptWindow = { until: now + 60_000, count: 0 };
    const address = request.socket.remoteAddress ?? 'unknown';
    const state = this.#attempts.get(address) ?? { until: now + 60_000, count: 0 };
    if (++this.#attemptWindow.count > 60 || ++state.count > 12 || (!this.#attempts.has(address) && this.#attempts.size >= 1024)) error('try_later', 429);
    this.#attempts.set(address, state);
  }
  async #body(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (request.headers.authorization !== undefined || request.headers.origin !== this.origin
      || request.headers['content-type']?.split(';')[0] !== 'application/json') error('same_origin_json_required', 403);
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
      if (size > 16_384) error('too_large', 413); chunks.push(bytes);
    }
    let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { error('invalid_request'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) error('invalid_request');
    return value as Record<string, unknown>;
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? '/', this.origin), path = url.pathname;
    if (path !== '/setup' && path !== ACCOUNT_BASE && !path.startsWith(ACCOUNT_BASE + '/')) return false;
    if (request.method === 'GET' && path === ACCOUNT_BASE + '/styles.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
      response.end(serverDocumentStyles); return true;
    }
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)); };
    try {
      if (this.#closed) error('account_service_retired', 503);
      if (request.headers.host !== new URL(this.origin).host || request.headers.authorization !== undefined) error('origin_required', 403);
      const native = this.options.nativeOwner?.(request) === true;
      if (request.method === 'GET' && (path === '/setup' || path === ACCOUNT_BASE || path === ACCOUNT_BASE + '/')) {
        if (path === '/setup' && this.options.management.status().state === 'complete') {
          response.writeHead(303, { location: ACCOUNT_BASE + '/', 'cache-control': 'no-store' }); response.end(); return true;
        }
        const nonce = randomBytes(24).toString('base64url');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff', 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` });
        response.end(await accountPage({ nonce, native, setup: path === '/setup',
          locale: url.searchParams.get('locale') ?? request.headers['accept-language']?.split(',')[0]?.split(';')[0] })); return true;
      }
      if (request.method === 'GET' && path === ACCOUNT_BASE + '/status') {
        const login = this.options.auth.currentLogin(request), setup = this.options.management.status();
        let administrator = false;
        if (login) { try { this.options.management.requireAdministrator(login.context); administrator = true; } catch { /* ordinary member */ } }
        const admitted = !!login && this.options.management.members.actorMembership(login.context.actorId)?.enabled === true;
        send(200, { setup, setupAvailable: !!this.options.setupToken || native, native,
          authority: this.options.management.actors.authority,
          desktopOwner: !!login && this.options.management.isDesktopOwner(login.context.actorId),
          actor: login && admitted ? { id: login.context.actorId, name: login.principal.displayName } : null, administrator }); return true;
      }
      if (request.method === 'GET' && path === ACCOUNT_BASE + '/members') {
        send(200, this.options.management.list(this.#owner(request))); return true;
      }
      if (request.method !== 'POST') { send(404, { error: 'missing' }); return true; }
      const fields: Record<string, readonly string[]> = {
        '/setup': ['mode', 'username', 'password', 'proof'], '/native': [], '/connect': ['origin'],
        '/invitations': [], '/accept': ['code', 'username', 'password'], '/password': ['username', 'password'],
        '/members': ['actorId', 'role', 'enabled'],
      };
      const suffix = path.slice(ACCOUNT_BASE.length), allowed = fields[suffix];
      if (!allowed) { send(404, { error: 'missing' }); return true; }
      if (['/setup', '/accept'].includes(suffix)) this.#rateLimit(request);
      const body = await this.#body(request);
      if (Object.keys(body).some(key => !allowed.includes(key))) error('invalid_request_fields');
      if (suffix === '/setup') {
        const proof = this.options.setupToken;
        if (!native && !(proof && typeof body.proof === 'string' && timingSafeEqual(checksum(proof), checksum(body.proof)))) error('setup_proof_required', 403);
        if (body.mode !== 'web' && !(native && body.mode === 'desktop')) error('invalid_setup_mode');
        const principal = await this.options.management.initialize({ mode: body.mode,
          username: body.username as string, password: body.password as string });
        if (this.#closed) error('account_service_retired', 503);
        this.options.auth.issueSession(principal, request, response); send(200, { ok: true }); return true;
      }
      if (suffix === '/connect') {
        if (!native || !this.options.openRemote) error('native_owner_required', 403);
        await this.options.openRemote(remoteServerOrigin(body.origin));
        if (this.#closed) error('account_service_retired', 503);
        send(200, { ok: true }); return true;
      }
      if (suffix === '/native') {
        if (!native) error('native_owner_required', 403);
        const principal = this.options.management.desktopIdentity();
        this.options.auth.issueSession(principal, request, response); send(200, { ok: true }); return true;
      }
      if (suffix === '/accept') {
        if (typeof body.code !== 'string' || typeof body.username !== 'string' || typeof body.password !== 'string') error('invalid_request');
        const principal = await this.options.management.accept({ code: body.code, username: body.username, password: body.password });
        if (this.#closed) error('account_service_retired', 503);
        this.options.auth.issueSession(principal, request, response); send(201, { ok: true }); return true;
      }
      const owner = this.#owner(request, true);
      if (suffix === '/invitations') { send(201, this.options.management.invite(owner)); return true; }
      if (suffix === '/members') {
        this.options.management.setMember(owner, body.actorId as string, body.role as 'admin' | 'member', body.enabled as boolean);
        send(200, { ok: true }); return true;
      }
      if (suffix === '/password') {
        if (typeof body.username !== 'string' || typeof body.password !== 'string') error('invalid_request');
        await this.options.management.password(owner, body.username, body.password); send(200, { ok: true }); return true;
      }
      send(404, { error: 'missing' });
    } catch (cause) {
      const known = cause instanceof AccountManagementError;
      if (!response.headersSent) send(known ? cause.status : 400, { error: known ? cause.code : 'invalid_request' }); else response.destroy();
    }
    return true;
  }
  close() { this.#closed = true; this.#attempts.clear(); }
}
