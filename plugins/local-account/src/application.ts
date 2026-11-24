import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpBodyTooLarge, HttpExchangeAborted, decodeUtf8, jsonResponse, setCookies, type HttpExchangeRequest, type HttpExchangeResponse, type HttpHeaderList } from '@opencraft/identity-core/http-exchange';
import type { HumanAuth } from '@opencraft/access-control/human-auth';
import { AccountManagementError, type HumanAccountManagement } from '@opencraft/access-control/account-management';
import type { IdentityRequest } from '@opencraft/identity-core/node';
import type { Principal } from '@opencraft/identity-core';
import type { ActorContext } from '@opencraft/identity-core/actors';
import { loginRequestKeys, memoryLoginAttemptLimiter, type LoginAttemptLimiter } from '@opencraft/identity-core/login-attempts';
import { accountPage } from './page.js';
import { remoteServerOrigin } from './connections.js';
import { serverDocumentStyles } from '@opencraft/design-system/document.web';

export const ACCOUNT_BASE = '/__opencraft_account';
const JSON_HEADERS: HttpHeaderList = [['content-type', 'application/json; charset=utf-8'], ['cache-control', 'private, no-store'], ['x-content-type-options', 'nosniff']];
const checksum = (text: string) => createHash('sha256').update(text).digest();
function error(code: string, status = 400): never { throw new AccountManagementError(code, status); }
export interface AccountApplicationOptions {
  readonly auth: HumanAuth;
  readonly management: HumanAccountManagement;
  readonly setupToken?: string;
  /** Set only by a compiled native host using a private browser-session proof. */
  readonly nativeOwner?: (request: IdentityRequest) => boolean;
  readonly openRemote?: (origin: string) => Promise<void>;
  /** Where setup and invitation attempts are counted; defaults to this process's memory. */
  readonly attempts?: LoginAttemptLimiter;
}
/** First-party trusted server entry; the same plugin supplies the client Settings entry. */
export class LocalAccountApplication {
  readonly #attempts: LoginAttemptLimiter;
  #closed = false;
  constructor(readonly options: AccountApplicationOptions) {
    if (options.setupToken !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(options.setupToken)) throw new Error('Invalid private setup proof');
    this.#attempts = options.attempts ?? memoryLoginAttemptLimiter();
  }
  get origin() { return this.options.auth.configuration.origin; }
  authenticate(request: IdentityRequest): Principal | null { return this.options.auth.authenticate(request); }
  trustedOrigin(request: IdentityRequest) { return this.options.auth.trustedOrigin(request); }
  isCurrent(principal: Principal) { return this.options.auth.isCurrent(principal); }
  invalidSession(request: IdentityRequest) { return this.options.auth.invalidSession(request); }
  hasSessionCookie(request: IdentityRequest) { return this.options.auth.hasSessionCookie(request); }
  #owner(request: IdentityRequest, recent = false): ActorContext {
    const login = this.options.auth.currentLogin(request);
    if (!login || (recent && login.createdAt < Date.now() - 600_000)) error('recent_login_required', 401);
    return login.context;
  }
  /** Setup and invitation acceptance derive a password; refused before the body is read. Fails closed. */
  async #rateLimit(request: HttpExchangeRequest) {
    let admitted = false;
    try { admitted = await this.#attempts.take(loginRequestKeys('account', request.clientAddress), Date.now()); } catch { /* refuse */ }
    if (!admitted) error('try_later', 429);
  }
  async #body(request: HttpExchangeRequest): Promise<Record<string, unknown>> {
    if (request.headers.authorization !== undefined || request.headers.origin !== this.origin
      || request.headers['content-type']?.split(';')[0] !== 'application/json') error('same_origin_json_required', 403);
    let bytes: Uint8Array;
    try { bytes = await request.readBody(16_384); }
    catch (cause) { if (cause instanceof HttpBodyTooLarge) error('too_large', 413); throw cause; }
    let value: unknown; try { value = JSON.parse(decodeUtf8(bytes)); } catch { error('invalid_request'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) error('invalid_request');
    return value as Record<string, unknown>;
  }
  /** Account routes (`/setup`, `/__opencraft_account`); null for any other path. */
  async handle(request: HttpExchangeRequest): Promise<HttpExchangeResponse | null> {
    const url = new URL(request.path, this.origin), path = url.pathname, identity = request.identity;
    if (path !== '/setup' && path !== ACCOUNT_BASE && !path.startsWith(ACCOUNT_BASE + '/')) return null;
    if (request.method === 'GET' && path === ACCOUNT_BASE + '/styles.css') {
      return { status: 200, headers: [['content-type', 'text/css; charset=utf-8'], ['cache-control', 'private, no-store'], ['x-content-type-options', 'nosniff']],
        body: serverDocumentStyles };
    }
    const send = (status: number, value: unknown, before: HttpHeaderList = []) => jsonResponse(status, value, JSON_HEADERS, before);
    try {
      if (this.#closed) error('account_service_retired', 503);
      if (request.headers.host !== new URL(this.origin).host || request.headers.authorization !== undefined) error('origin_required', 403);
      const native = this.options.nativeOwner?.(identity) === true;
      if (request.method === 'GET' && (path === '/setup' || path === ACCOUNT_BASE || path === ACCOUNT_BASE + '/')) {
        if (path === '/setup' && this.options.management.status().state === 'complete')
          return { status: 303, headers: [['location', ACCOUNT_BASE + '/'], ['cache-control', 'no-store']], body: null };
        const nonce = randomBytes(24).toString('base64url');
        let page: string;
        // The page response is already committed: a rendering failure drops the connection.
        try { page = await accountPage({ nonce, native, setup: path === '/setup',
          locale: url.searchParams.get('locale') ?? request.headers['accept-language']?.split(',')[0]?.split(';')[0] }); }
        catch (cause) { throw new HttpExchangeAborted({ cause }); }
        return { status: 200, headers: [['content-type', 'text/html; charset=utf-8'], ['cache-control', 'private, no-store'], ['referrer-policy', 'no-referrer'],
          ['x-content-type-options', 'nosniff'], ['content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`]],
          body: page };
      }
      if (request.method === 'GET' && path === ACCOUNT_BASE + '/status') {
        const login = this.options.auth.currentLogin(identity), setup = this.options.management.status();
        let administrator = false;
        if (login) { try { this.options.management.requireAdministrator(login.context); administrator = true; } catch { /* ordinary member */ } }
        const admitted = !!login && this.options.management.members.actorMembership(login.context.actorId)?.enabled === true;
        return send(200, { setup, setupAvailable: !!this.options.setupToken || native, native,
          authority: this.options.management.actors.authority,
          desktopOwner: !!login && this.options.management.isDesktopOwner(login.context.actorId),
          actor: login && admitted ? { id: login.context.actorId, name: login.principal.displayName } : null, administrator });
      }
      if (request.method === 'GET' && path === ACCOUNT_BASE + '/members')
        return send(200, this.options.management.list(this.#owner(identity)));
      if (request.method !== 'POST') return send(404, { error: 'missing' });
      const fields: Record<string, readonly string[]> = {
        '/setup': ['mode', 'username', 'password', 'proof'], '/native': [], '/connect': ['origin'],
        '/invitations': [], '/accept': ['code', 'username', 'password'], '/password': ['username', 'password'],
        '/members': ['actorId', 'role', 'enabled'],
      };
      const suffix = path.slice(ACCOUNT_BASE.length), allowed = fields[suffix];
      if (!allowed) return send(404, { error: 'missing' });
      if (['/setup', '/accept'].includes(suffix)) await this.#rateLimit(request);
      const body = await this.#body(request);
      if (Object.keys(body).some(key => !allowed.includes(key))) error('invalid_request_fields');
      if (suffix === '/setup') {
        const proof = this.options.setupToken;
        if (!native && !(proof && typeof body.proof === 'string' && timingSafeEqual(checksum(proof), checksum(body.proof)))) error('setup_proof_required', 403);
        if (body.mode !== 'web' && !(native && body.mode === 'desktop')) error('invalid_setup_mode');
        const principal = await this.options.management.initialize({ mode: body.mode,
          username: body.username as string, password: body.password as string });
        if (this.#closed) error('account_service_retired', 503);
        return send(200, { ok: true }, setCookies(await this.options.auth.issueSession(principal, identity)));
      }
      if (suffix === '/connect') {
        if (!native || !this.options.openRemote) error('native_owner_required', 403);
        await this.options.openRemote(remoteServerOrigin(body.origin));
        if (this.#closed) error('account_service_retired', 503);
        return send(200, { ok: true });
      }
      if (suffix === '/native') {
        if (!native) error('native_owner_required', 403);
        const principal = this.options.management.desktopIdentity();
        return send(200, { ok: true }, setCookies(await this.options.auth.issueSession(principal, identity)));
      }
      if (suffix === '/accept') {
        if (typeof body.code !== 'string' || typeof body.username !== 'string' || typeof body.password !== 'string') error('invalid_request');
        const principal = await this.options.management.accept({ code: body.code, username: body.username, password: body.password });
        if (this.#closed) error('account_service_retired', 503);
        return send(201, { ok: true }, setCookies(await this.options.auth.issueSession(principal, identity)));
      }
      const owner = this.#owner(identity, true);
      if (suffix === '/invitations') return send(201, this.options.management.invite(owner));
      if (suffix === '/members') {
        await this.options.management.setMember(owner, body.actorId as string, body.role as 'admin' | 'member', body.enabled as boolean);
        return send(200, { ok: true });
      }
      if (suffix === '/password') {
        if (typeof body.username !== 'string' || typeof body.password !== 'string') error('invalid_request');
        await this.options.management.password(owner, body.username, body.password); return send(200, { ok: true });
      }
      return send(404, { error: 'missing' });
    } catch (cause) {
      if (cause instanceof HttpExchangeAborted) throw cause;
      const known = cause instanceof AccountManagementError;
      return send(known ? cause.status : 400, { error: known ? cause.code : 'invalid_request' });
    }
  }
  close() { this.#closed = true; }
}
