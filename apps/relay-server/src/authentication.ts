import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '@opencraft/identity-core';
import type { IdentityProvider } from '@opencraft/identity-core/node';
export type EntryOriginResolver = (request: IncomingMessage) => string | null;
interface Route { readonly instanceId: string; readonly origin: string; }
interface Ticket { readonly principal: Principal; readonly route: Route; readonly state: string; readonly path: string; readonly expiresAt: number; }
interface Session { readonly principal: Principal; readonly route: Route; readonly expiresAt: number; }
const LOGIN = '/__opencraft_relay/login', CALLBACK = '/__opencraft_relay/callback', LOGOUT = '/__opencraft_relay/logout';
const random = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function cookieName(origin: string, purpose: string) { return (origin.startsWith('https:') ? '__Host-' : '') + 'opencraft-relay-' + purpose; }
function cookie(req: IncomingMessage, name: string): string | null {
  const matches = String(req.headers.cookie ?? '').split(';').map(c => c.trim()).filter(c => c.startsWith(name + '='));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(name.length + 1); return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
}
function setCookie(origin: string, purpose: string, value: string, seconds: number) {
  return `${cookieName(origin, purpose)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${origin.startsWith('https:') ? '; Secure' : ''}`;
}
/** One shared authentication owner; approved browser entry aliases retain exact origin binding. */
export class RelayAuthentication {
  readonly #tickets = new Map<string, Ticket>();
  readonly #sessions = new Map<string, Session>();
  readonly #starts = new Map<string, { route: Route; path: string; loginOrigin: string; expiresAt: number }>();
  #nextPrune = 0;
  constructor(readonly origin: string, readonly provider: IdentityProvider, readonly routeSource: readonly Route[] | (() => readonly Route[]), readonly resolveEntryOrigin?: EntryOriginResolver) {
    const url = new URL(origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error('Invalid authentication origin');
  }
  get routes(): readonly Route[] { return typeof this.routeSource === 'function' ? this.routeSource() : this.routeSource; }
  /** Product code approves the authority; core still requires the exact request host and configured TLS scheme. */
  originFor(request: IncomingMessage): string {
    if (this.routes.some(route => route.origin !== this.origin && new URL(route.origin).host === request.headers.host)) return this.origin;
    const resolved = this.resolveEntryOrigin?.(request);
    if (!resolved) return this.origin;
    const url = new URL(resolved), host = request.headers.host ?? '';
    if (url.origin !== resolved || url.protocol !== new URL(this.origin).protocol
      || !/^[a-z0-9.-]+(?::[0-9]+)?$/iu.test(host) || url.host !== new URL(url.protocol + '//' + host).host) throw new Error('Invalid resolved entry origin');
    return resolved;
  }
  routesFor(request: IncomingMessage): readonly Route[] {
    const origin = this.originFor(request);
    return origin === this.origin ? this.routes : this.routes.map(route => route.origin === this.origin ? { ...route, origin } : route);
  }
  private prune() {
    const now = Date.now();
    if (now < this.#nextPrune) return;
    this.#nextPrune = now + 1000;
    for (const [key, value] of this.#tickets) if (value.expiresAt <= now) this.#tickets.delete(key);
    for (const [key, value] of this.#sessions) if (value.expiresAt <= now) this.#sessions.delete(key);
    for (const [key, value] of this.#starts) if (value.expiresAt <= now) this.#starts.delete(key);
  }
  authenticate(request: IncomingMessage, route: Route): Principal | null {
    this.prune(); const token = cookie(request, cookieName(route.origin, 'session'));
    const session = token ? this.#sessions.get(digest(token)) : undefined;
    return session && session.expiresAt > Date.now() && session.route.instanceId === route.instanceId && session.route.origin === route.origin ? session.principal : null;
  }
  begin(request: IncomingMessage, response: ServerResponse, route: Route) {
    // Only document navigation initiates authentication; APIs and WebSockets remain explicit 401.
    this.prune();
    if (this.#starts.size >= 10_000) { response.writeHead(503, {'cache-control':'no-store'});response.end();return; }
    const loginOrigin = this.originFor(request);
    const state = random(); this.#starts.set(digest(state),{route,path:request.url ?? '/',loginOrigin,expiresAt:Date.now()+60_000});
    response.writeHead(303, { location: loginOrigin + LOGIN + '?route=' + encodeURIComponent(route.instanceId) + '&state=' + state,
      'set-cookie': setCookie(route.origin, 'login', state, 60), 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' }); response.end();
  }
  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const url = new URL(request.url ?? '/', 'http://relay.invalid');
    if (![LOGIN, CALLBACK, LOGOUT].includes(url.pathname)) return false;
    this.prune();
    const send = (status: number) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' }); response.end(JSON.stringify({error:status===401?'authentication_required':'invalid_authentication_handoff'})); };
    const origin = this.originFor(request), routes = this.routesFor(request);
    const host = origin === this.origin ? request.headers.host : new URL(origin).host;
    const route = routes.find(r => new URL(r.origin).host === host);
    if (url.pathname === LOGIN) {
      const target = routes.find(r => r.instanceId === url.searchParams.get('route')), state = url.searchParams.get('state');
      const start = state ? this.#starts.get(digest(state)) : undefined;
      if (request.method !== 'GET' || host !== new URL(origin).host || !target || !state || !/^[A-Za-z0-9_-]{43}$/u.test(state) || !start || start.expiresAt <= Date.now() || start.route.instanceId !== target.instanceId || start.route.origin !== target.origin || start.loginOrigin !== origin
        || (request.headers.origin !== undefined && request.headers.origin !== origin)) { send(403); return true; }
      const principal = this.provider.authenticate(request);
      if (!principal || principal.expiresAt <= Date.now()) { send(401); return true; }
      if (this.#tickets.size >= 10_000) { send(503); return true; }
      this.#starts.delete(digest(state));
      const ticket = random(); this.#tickets.set(digest(ticket), {principal,route:target,state,path:start.path,expiresAt:Math.min(principal.expiresAt,Date.now()+60_000)});
      response.writeHead(303, { location: target.origin + CALLBACK + '?ticket=' + ticket, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' }); response.end(); return true;
    }
    if (!route || (request.headers.origin !== undefined && request.headers.origin !== route.origin)) { send(403); return true; }
    if (url.pathname === LOGOUT) {
      if (request.method !== 'POST' || request.headers.origin !== route.origin) { send(403); return true; }
      const token = cookie(request, cookieName(route.origin,'session')); if (token && this.authenticate(request, route)) this.#sessions.delete(digest(token));
      response.writeHead(204, {'set-cookie':setCookie(route.origin,'session','',0),'cache-control':'no-store'});response.end();return true;
    }
    const code = url.searchParams.get('ticket'), ticket = code && /^[A-Za-z0-9_-]{43}$/u.test(code) ? this.#tickets.get(digest(code)) : undefined;
    const state = cookie(request, cookieName(route.origin,'login'));
    if (request.method !== 'GET' || !ticket || ticket.expiresAt <= Date.now() || !state || ticket.route.instanceId !== route.instanceId || ticket.route.origin !== route.origin
      || !timingSafeEqual(Buffer.from(state),Buffer.from(ticket.state))) { send(403); return true; }
    this.#tickets.delete(digest(code!));
    if (this.#sessions.size >= 100_000) { send(503); return true; }
    const token = random(), expiresAt = Math.min(ticket.principal.expiresAt,Date.now()+8*3600_000);
    this.#sessions.set(digest(token),{principal:{...ticket.principal,expiresAt},route,expiresAt});
    response.writeHead(303,{location:route.origin+ticket.path, 'set-cookie':[setCookie(route.origin,'login','',0),setCookie(route.origin,'session',token,Math.max(1,Math.floor((expiresAt-Date.now())/1000)))],
      'cache-control':'private, no-store','referrer-policy':'no-referrer'});response.end();return true;
  }
}
