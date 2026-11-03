import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '@opencraft/identity-core';
import type { IdentityRequest } from '@opencraft/identity-core/node';
import type { ActorContext } from '@opencraft/identity-core/actors';
import { ActorStore, isActorAuthorization } from './actors.js';

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
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = new URL(request.url ?? '/', 'http://actors.invalid').pathname;
    if (!path.startsWith('/__opencraft_actors/')) return false;
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify(value));
    };
    const context = this.authenticate(request);
    if (!context) { send(401, { error: 'actor_authentication_required' }); return true; }
    if (path === '/__opencraft_actors/me' && request.method === 'GET') {
      send(200, { actor: this.store.get(context.actorId), expiresAt: context.expiresAt }); return true;
    }
    if (!this.manages(request, context)) { send(403, { error: 'actor_management_denied' }); return true; }
    if (request.method === 'GET' && path === '/__opencraft_actors/actors') { send(200, { actors: this.store.list() }); return true; }
    if (request.method === 'GET' && path === '/__opencraft_actors/audit') { send(200, { events: this.store.audit() }); return true; }
    const fields: Record<string, readonly string[]> = {
      '/__opencraft_actors/sessions': ['displayName'],
      '/__opencraft_actors/credentials': ['actorId', 'expiresAt'],
      '/__opencraft_actors/credentials/revoke': ['credentialId'],
      '/__opencraft_actors/grants': ['actorId', 'resource', 'action', 'enabled'],
      '/__opencraft_actors/state': ['actorId', 'enabled'],
    };
    if (request.method !== 'POST' || !fields[path]) { send(404, { error: 'missing' }); return true; }
    const origin = request.headers.origin;
    const trustedOrigin = this.options.trustedOrigin?.(request);
    const validOrigin = typeof origin === 'string' && (['http:', 'https:'].some(s => origin === s + '//' + request.headers.host) || origin === trustedOrigin);
    if (request.headers['content-type']?.split(';')[0] !== 'application/json'
      || (context.credentialId === null && !validOrigin)) {
      send(403, { error: 'same_origin_json_required' }); return true;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > 16_384) { send(413, { error: 'too_large' }); return true; }
        chunks.push(bytes);
      }
      // Request-body IO is an authorization boundary: expiry, disable and grants may have changed.
      if (!this.authenticate(request) || !this.manages(request, context)) { send(403, { error: 'actor_management_denied' }); return true; }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const allowed = fields[path]!;
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== allowed.length || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Invalid actor operation');
      if (path === '/__opencraft_actors/sessions') send(201, { actor: this.store.createSession(value.displayName, context.actorId) });
      else if (path === '/__opencraft_actors/credentials') send(201, this.store.issueCredential(value.actorId, value.expiresAt, context.actorId));
      else if (path === '/__opencraft_actors/credentials/revoke') { this.store.revokeCredential(value.credentialId, context.actorId); send(200, { ok: true }); }
      else if (path === '/__opencraft_actors/grants') { this.store.setGrant(value.actorId, value.resource, value.action, value.enabled, context.actorId); send(200, { ok: true }); }
      else if (path === '/__opencraft_actors/state') {
        if (value.actorId === context.actorId && value.enabled === false) { send(409, { error: 'cannot_disable_own_actor' }); return true; }
        this.store.setEnabled(value.actorId, value.enabled, context.actorId); send(200, { ok: true });
      }
    } catch { send(400, { error: 'invalid_actor_operation' }); }
    return true;
  }
}
