import { HttpBodyTooLarge, decodeUtf8, jsonResponse, type HttpExchangeRequest, type HttpExchangeResponse } from '@opencraft/identity-core/http-exchange';
import type { Principal } from '@opencraft/identity-core';
import type { IdentityRequest } from '@opencraft/identity-core/node';
import type { ActorContext } from '@opencraft/identity-core/actors';
import { ActorStore, isActorAuthorization } from './actors.js';
import type { IdentityWrites } from './identity-writes.js';

export interface ActorAccessOptions {
  /** Only verified HUMAN providers belong here. Session proofs use their own credential path. */
  readonly authenticateHuman: (request: IdentityRequest) => Principal | null;
  readonly admitted: (principal: Principal) => boolean;
  /** Compatibility bootstrap for the existing installation administrators, not resource grants. */
  readonly administrator: (principal: Principal) => boolean;
  readonly trustedOrigin?: (request: IdentityRequest) => string | null;
  readonly isHumanCurrent?: (principal: Principal) => boolean;
  readonly rejectHumanRequest?: (request: IdentityRequest) => boolean;
}
export class ActorAccess {
  readonly #requests = new WeakMap<object, { context: ActorContext | null; principal: Principal | null }>();
  #writes: IdentityWrites | null = null;
  /** Actor administration writes go to the Server owner from now on. */
  useOwnerWrites(writes: IdentityWrites): void { this.#writes = writes; }
  constructor(readonly store: ActorStore, readonly options: ActorAccessOptions) {}
  authenticate(request: IdentityRequest): ActorContext | null {
    let entry = this.#requests.get(request);
    if (!entry) {
      const principal = this.options.authenticateHuman(request);
      const authorization = request.headers.authorization;
      const duplicates = (request.rawHeaders?.filter((_, i) => i % 2 === 0 && request.rawHeaders![i]!.toLowerCase() === 'authorization').length ?? 0) > 1;
      // Never choose a winner between independently presented credentials, or fall back from a bad bearer.
      let context: ActorContext | null = null;
      const rejected = this.options.rejectHumanRequest?.(request) ?? false;
      if (!rejected && !duplicates && !authorization && principal && this.options.admitted(principal)) context = this.store.resolveHuman(principal);
      else if (!rejected && !duplicates && !principal && typeof authorization === 'string' && /^Bearer /iu.test(authorization)) {
        context = this.store.authenticateSession(authorization.slice(7));
      }
      entry = { context, principal }; this.#requests.set(request, entry);
    }
    return entry.context && this.current(entry.context, entry.principal) ? entry.context : null;
  }
  private current(context: ActorContext, principal: Principal | null) {
    return this.store.isCurrent(context) && (!principal || (principal.expiresAt > this.store.now()
      && (this.options.isHumanCurrent?.(principal) ?? true) && this.options.admitted(principal)));
  }
  /** Current authority without retaining an HTTP request or its credential headers. */
  lease(request: IdentityRequest): { readonly context: ActorContext; isCurrent(): boolean } | null {
    const context = this.authenticate(request);
    if (!context) return null;
    const principal = this.#requests.get(request)?.principal ?? null;
    return { context, isCurrent: () => this.current(context, principal) };
  }
  manages(request: IdentityRequest, context: ActorContext) {
    const principal = this.#requests.get(request)?.principal ?? null;
    return this.current(context, principal) && (this.store.can(context, this.store.managementResource, 'actors.manage')
      || (!!principal && this.options.administrator(principal)));
  }
  /** Statistics team access follows the current instance role, never actors.manage. */
  usageAuthority(request: IdentityRequest) {
    const context = this.authenticate(request);
    if (!context || this.store.get(context.actorId)?.kind !== 'human') return null;
    const principal = this.#requests.get(request)?.principal;
    return { actorId: context.actorId, administrator: !!principal && this.options.administrator(principal) };
  }
  /** A new Session bearer must not grant access to legacy unscoped HTTP or WebSocket APIs. */
  isSessionRequest(request: IdentityRequest) { return isActorAuthorization(request.headers.authorization); }
  /** Preserve legacy anonymous mode, but never downgrade a recognized, disabled human to anonymous. */
  legacyAdmissionStatus(request: IdentityRequest): 204 | 403 {
    const context = this.authenticate(request);
    return this.#requests.get(request)?.principal && !context ? 403 : 204;
  }
  watch(request: IdentityRequest, revoke: () => void): () => void {
    if (!this.authenticate(request)) return () => {};
    const timer = setInterval(() => {
      let valid = false;
      try { valid = this.authenticate(request) !== null; } catch { /* Identity storage failure revokes the connection. */ }
      if (!valid) revoke();
    }, 500);
    timer.unref();
    return () => clearInterval(timer);
  }
  /** Actor administration under `/__opencraft_actors/`; null for any other path. */
  async handle(exchange: HttpExchangeRequest): Promise<HttpExchangeResponse | null> {
    const path = new URL(exchange.path, 'http://actors.invalid').pathname;
    if (!path.startsWith('/__opencraft_actors/')) return null;
    // Per-request authority is cached on the transport's request view.
    const request = exchange.identity;
    const send = (status: number, value: unknown) =>
      jsonResponse(status, value, [['content-type', 'application/json'], ['cache-control', 'private, no-store'], ['x-content-type-options', 'nosniff']]);
    const context = this.authenticate(request);
    if (!context) return send(401, { error: 'actor_authentication_required' });
    if (path === '/__opencraft_actors/me' && exchange.method === 'GET')
      return send(200, { actor: this.store.get(context.actorId), expiresAt: context.expiresAt });
    if (!this.manages(request, context)) return send(403, { error: 'actor_management_denied' });
    if (exchange.method === 'GET' && path === '/__opencraft_actors/actors') return send(200, { actors: this.store.list() });
    if (exchange.method === 'GET' && path === '/__opencraft_actors/audit') return send(200, { events: this.store.audit() });
    const fields: Record<string, readonly string[]> = {
      '/__opencraft_actors/sessions': ['displayName'],
      '/__opencraft_actors/credentials': ['actorId', 'expiresAt'],
      '/__opencraft_actors/credentials/revoke': ['credentialId'],
      '/__opencraft_actors/grants': ['actorId', 'resource', 'action', 'enabled'],
      '/__opencraft_actors/state': ['actorId', 'enabled'],
    };
    if (exchange.method !== 'POST' || !fields[path]) return send(404, { error: 'missing' });
    const origin = exchange.headers.origin;
    const trustedOrigin = this.options.trustedOrigin?.(request);
    const validOrigin = typeof origin === 'string' && (['http:', 'https:'].some(s => origin === s + '//' + exchange.headers.host) || origin === trustedOrigin);
    if (exchange.headers['content-type']?.split(';')[0] !== 'application/json'
      || (context.credentialId === null && !validOrigin)) return send(403, { error: 'same_origin_json_required' });
    try {
      const bytes = await exchange.readBody(16_384);
      // Request-body IO is an authorization boundary: expiry, disable and grants may have changed.
      if (!this.authenticate(request) || !this.manages(request, context)) return send(403, { error: 'actor_management_denied' });
      const value = JSON.parse(decodeUtf8(bytes));
      const allowed = fields[path]!;
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== allowed.length || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Invalid actor operation');
      // With an owner Worker, the same authority is rechecked under its writer lock before commit.
      const writes = this.#writes, authorize = () => !!this.authenticate(request) && this.manages(request, context);
      if (path === '/__opencraft_actors/sessions') return send(201, { actor: writes ? await writes.createSession(authorize, value.displayName, context.actorId)
        : this.store.createSession(value.displayName, context.actorId) });
      if (path === '/__opencraft_actors/credentials') return send(201, writes ? await writes.issueCredential(authorize, value.actorId, value.expiresAt, context.actorId)
        : this.store.issueCredential(value.actorId, value.expiresAt, context.actorId));
      if (path === '/__opencraft_actors/credentials/revoke') {
        if (writes) await writes.revokeCredential(authorize, value.credentialId, context.actorId); else this.store.revokeCredential(value.credentialId, context.actorId);
        return send(200, { ok: true });
      }
      if (path === '/__opencraft_actors/grants') {
        if (writes) await writes.setGrant(authorize, value.actorId, value.resource, value.action, value.enabled, context.actorId);
        else this.store.setGrant(value.actorId, value.resource, value.action, value.enabled, context.actorId);
        return send(200, { ok: true });
      }
      // '/__opencraft_actors/state' is the last route of `fields`.
      if (value.actorId === context.actorId && value.enabled === false) return send(409, { error: 'cannot_disable_own_actor' });
      if (writes) await writes.setEnabled(authorize, value.actorId, value.enabled, context.actorId); else this.store.setEnabled(value.actorId, value.enabled, context.actorId);
      return send(200, { ok: true });
    } catch (error) {
      return error instanceof HttpBodyTooLarge ? send(413, { error: 'too_large' }) : send(400, { error: 'invalid_actor_operation' });
    }
  }
}
