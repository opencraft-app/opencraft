import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { relayDuplex } from '../../relay-protocol/src/node.js';
import { AssertionProvider, type IdentityProvider, type IdentityRequest } from '../../identity-core/src/node.js';
import { MAX_STREAMS } from '../../relay-protocol/src/index.js';
import { HUB_CONTROL_PATH, HUB_DATA_PATH, HUB_PROTOCOL, MAX_HOPS, publicOrigin, transportEndpoint, validHubId,
  type HubNetworkSnapshot, type HubRoute, type IdentityAuthority } from './contract.js';
import { HubStore, authority, digest, hubId, parseInvitation, random, signed, verified, type Invitation, type InvitePayload, type Peer } from './store.js';
import { HubRouting } from './routing.js';
import { createLocalIngress } from './local-ingress.js';

interface Link {
  id: string; publicKey: string; ws: WebSocket; outgoing: Peer | null; invitation: Invitation | null;
  streams: Set<Duplex>; lastAdvertisement: string; epoch: number; alive: boolean;
}
interface Dial { type: 'dial'; id: string; target: string; path: string[]; }
interface Pending {
  link: Link; token: string; accept: (stream: Duplex) => void; reject: (error: Error) => void;
}
const sendJson = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'private, no-store' }); res.end(JSON.stringify(value)); };
export function sameOriginJson(req: IncomingMessage) {
  return typeof req.headers.origin === 'string' && ['http:', 'https:'].some(s => req.headers.origin === s + '//' + req.headers.host)
    && req.headers['content-type']?.split(';')[0] === 'application/json';
}
export async function readCommand(req: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0, body = ''; for await (const chunk of req) { bytes += chunk.length; if (bytes > 65_536) throw new Error('Command too large'); body += chunk; }
  const input = JSON.parse(body); if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid command'); return input;
}
export class HubNetwork implements IdentityProvider {
  readonly store: HubStore;
  readonly routing: HubRouting;
  readonly links = new Map<string, Link>();
  readonly #controls = new WebSocketServer({ noServer: true, maxPayload: 262_144, perMessageDeflate: false });
  readonly #data = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
  readonly #pending = new Map<string, Pending>();
  readonly #dials = new Map<string, { link: Link; resolve: (stream: Duplex) => void; reject: (error: Error) => void }>();
  readonly #clients = new Map<string, { ws?: WebSocket; timer?: ReturnType<typeof setTimeout>; stopped: boolean; attempts: number }>();
  readonly #handshakes = new Set<WebSocket>();
  readonly #connecting = new Map<WebSocket, Link>();
  readonly #streams = new Set<Duplex>();
  readonly #heartbeat: ReturnType<typeof setInterval>;
  #targetPort = 0;
  #closed = false;
  #provider: AssertionProvider | null = null;
  #providerScope = '';
  readonly #local = createLocalIngress(() => ({ port: this.#targetPort, origin: this.store.state.origin }));
  constructor(path: string, readonly options: { ca?: string; authority?: IdentityAuthority; onRoutes?: () => void; localService?: boolean } = {}) {
    this.store = new HubStore(path); this.routing = new HubRouting(this.store.id);
    try {
      if (options.authority) {
        const a = authority(options.authority);
        if (JSON.stringify(this.store.state.authority) !== JSON.stringify(a)) { this.store.state.authority = a; this.store.record('local-operator', 'configure_identity_authority'); }
      }
    } catch (error) { this.#local.close(); this.#controls.close(); this.#data.close(); this.store.close(); throw error; }
    this.#heartbeat = setInterval(() => {
      for (const link of this.links.values()) { if (!link.alive) link.ws.terminate(); else { link.alive = false; link.ws.ping(); } }
    }, 15_000); this.#heartbeat.unref();
  }
  start(targetPort: number) {
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error('Invalid local Hub target');
    this.#targetPort = targetPort; this.#syncClients();
  }
  authenticate(req: IdentityRequest) {
    const s = this.store.state, scope = s.authority && s.origin ? JSON.stringify([s.authority, s.origin]) : '';
    if (scope !== this.#providerScope) { this.#providerScope = scope; this.#provider = scope ? new AssertionProvider({ issuer: s.authority!.issuer, instanceId: this.store.id, origin: s.origin }, s.authority!.publicKey) : null; }
    const p = this.#provider?.authenticate(req) ?? null;
    return p && s.authority?.providers.includes(p.provider) ? p : null;
  }
  trustedOrigin(req: IdentityRequest) { return this.authenticate(req) ? this.store.state.origin : null; }
  snapshot(): HubNetworkSnapshot {
    const s = this.store.state;
    return { schemaVersion: 1, revision: s.revision, hubId: this.store.id, name: s.name, endpoint: s.endpoint, origin: s.origin,
      accepting: s.accepting, forwarding: s.forwarding, authority: s.authority, localService: this.options.localService !== false,
      peers: [...s.peers.map(p => ({ id: p.id, hubId: p.hubId, name: p.name ?? p.hubId, endpoint: p.endpoint, direction: 'outgoing' as const, connected: !!this.links.get(p.hubId)?.outgoing, allowTransit: p.allowTransit, origins: p.origins })),
        ...s.invitations.filter(i => i.hubId).map(i => ({ id: i.id, hubId: i.hubId!, name: i.name ?? i.hubId!, endpoint: null, direction: 'incoming' as const, connected: this.links.get(i.hubId!)?.invitation === i, allowTransit: i.allowTransit, origins: i.origins }))],
      invitations: s.invitations.map(i => ({ id: i.id, expiresAt: i.expiresAt, redeemed: !!i.hubId, allowTransit: i.allowTransit, origins: i.origins })),
      routes: this.routes().map(r => ({ hubId: r.service.hubId, origin: r.service.origin, path: [this.store.id, ...r.path], nextHop: r.path[0]! })), audit: [...s.audit].reverse() };
  }
  routes(): HubRoute[] { return this.routing.all().filter(r => r.service.origin !== this.store.state.origin && this.links.has(r.path[0]!)); }
  command(input: Record<string, unknown>, operator: string) {
    const before = structuredClone(this.store.state);
    try { return this.#command(input, operator); }
    catch (error) {
      if (JSON.stringify(this.store.state) === JSON.stringify(before)) throw error;
      Object.assign(this.store.state, before);
      // Rebind live policy references after restoring a failed private-state transaction.
      for (const link of [...this.links.values()]) this.#retire(link);
      for (const client of this.#clients.values()) { client.stopped = true; clearTimeout(client.timer); client.ws?.terminate(); }
      this.#clients.clear(); this.#syncClients(); throw error;
    }
  }
  #command(input: Record<string, unknown>, operator: string) {
    if (this.#closed) throw new Error('Hub is closed');
    const s = this.store.state;
    if (input.revision !== s.revision) return { conflict: true, snapshot: this.snapshot() };
    const priorPolicy = JSON.stringify([s.origin, s.accepting, s.forwarding, s.authority]);
    const action = input.action;
    if (action === 'inspect') {
      const p = parseInvitation(input.invitation);
      return { snapshot: this.snapshot(), invitationPreview: { hubId: p.hubId, name: p.name, endpoint: p.endpoint, expiresAt: p.expiresAt,
        allowTransit: p.allowTransit, origins: p.origins, authority: p.authority, fingerprint: digest(p.publicKey).slice(0, 24) } };
    }
    let invitation: string | undefined;
    if (action === 'configure') {
      const name = input.name, accepting = input.accepting, forwarding = input.forwarding;
      if (typeof name !== 'string' || !name.trim() || name.length > 128 || typeof accepting !== 'boolean' || typeof forwarding !== 'boolean') throw new Error('Invalid configuration');
      const endpoint = input.endpoint === '' ? '' : transportEndpoint(input.endpoint), origin = input.origin === '' ? '' : publicOrigin(input.origin);
      if (accepting && !endpoint) throw new Error('Configure a reachable HTTPS endpoint first');
      if (origin && !s.authority) throw new Error('Explicitly accept an identity authority before publishing');
      if (origin && this.options.localService === false) throw new Error('This Hub provides relay only');
      Object.assign(s, { name: name.trim(), endpoint, origin, accepting, forwarding });
    } else if (action === 'invite') {
      if (!s.accepting || !s.endpoint || s.invitations.length >= 128) throw new Error('Hub is not accepting nodes');
      if (typeof input.allowTransit !== 'boolean' || !Array.isArray(input.origins) || input.origins.length > 64 || input.origins.some(o => typeof o !== 'string')) throw new Error('Invalid invitation scope');
      const origins = [...new Set(input.origins.map(publicOrigin))];
      const id = randomUUID(), credential = random(), expiresAt = Date.now() + 24 * 3600_000;
      s.invitations.push({ id, hash: digest(credential), expiresAt, allowTransit: input.allowTransit, origins });
      const payload: InvitePayload = { version: 1, endpoint: s.endpoint, hubId: this.store.id, publicKey: s.publicKey, name: s.name, id, credential,
        expiresAt, allowTransit: input.allowTransit, origins, authority: s.authority, ...(this.options.ca ? { ca: this.options.ca } : {}) };
      invitation = Buffer.from(JSON.stringify({ payload, signature: signed(payload, s.privateKey) })).toString('base64url');
    } else if (action === 'connect') {
      const invite = parseInvitation(input.invitation);
      if (invite.hubId === this.store.id || s.peers.length >= 32 || s.peers.some(p => p.hubId === invite.hubId) || s.invitations.some(i => i.hubId === invite.hubId)) throw new Error('Duplicate or own Hub');
      // Explicit acceptance is separate from tunnel enrollment. The settings preview shows this authority.
      if (invite.authority && input.trustIdentity !== true) throw new Error('Identity authority must be explicitly accepted');
      if (invite.authority && s.authority && JSON.stringify(s.authority) !== JSON.stringify(invite.authority)) throw new Error('Identity authority conflicts with existing configuration');
      if (input.publishOrigin !== undefined && input.publishOrigin !== '' && (!invite.origins.includes(String(input.publishOrigin)) || !invite.authority)) throw new Error('Origin is not granted by invitation');
      if (input.publishOrigin && this.options.localService === false) throw new Error('This Hub provides relay only');
      if (invite.authority && !s.authority) s.authority = authority(invite.authority);
      if (input.publishOrigin) s.origin = publicOrigin(input.publishOrigin);
      s.peers.push({ id: invite.id, hubId: invite.hubId, name: invite.name, publicKey: invite.publicKey, endpoint: invite.endpoint, credential: invite.credential,
        allowTransit: invite.allowTransit, origins: invite.origins, ...(invite.ca ? { ca: invite.ca } : {}) });
    } else if (action === 'untrust') {
      if (this.options.authority) throw new Error('Identity authority is operator managed');
      s.authority = null; s.origin = '';
    } else if (action === 'disconnect' || action === 'revoke') {
      if (typeof input.id !== 'string') throw new Error('Invalid node');
      s.peers = s.peers.filter(p => p.id !== input.id); s.invitations = s.invitations.filter(i => i.id !== input.id);
    } else throw new Error('Unknown Hub command');
    this.store.record(operator, String(action));
    // Global authorization changes retire streams; enrollment and display edits
    // do not interrupt unrelated traffic. Removed peers retire their own streams below.
    if (priorPolicy !== JSON.stringify([s.origin, s.accepting, s.forwarding, s.authority])) {
      for (const stream of this.#streams) stream.destroy();
    }
    for (const link of [...this.links.values()]) {
      if ((!link.outgoing && (!s.accepting || !s.invitations.includes(link.invitation!)))
        || (link.outgoing && !s.peers.includes(link.outgoing))) this.#retire(link);
    }
    this.#syncClients(); this.#announce();
    return { snapshot: this.snapshot(), ...(invitation ? { invitation } : {}) };
  }
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (![HUB_CONTROL_PATH, HUB_DATA_PATH].includes(req.url ?? '')) return false;
    const reject = () => { socket.on('error', () => {}); socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); };
    if (this.#closed || req.headers.origin || req.headers['sec-websocket-protocol'] !== HUB_PROTOCOL) { reject(); return true; }
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u)?.[1] ?? '';
    if (req.url === HUB_DATA_PATH) {
      const id = req.headers['x-opencraft-hub-stream'], pending = typeof id === 'string' ? this.#pending.get(id) : undefined;
      if (!pending || !token || digest(token) !== digest(pending.token) || this.links.get(pending.link.id) !== pending.link) { reject(); return true; }
      this.#pending.delete(String(id)); this.#data.handleUpgrade(req, socket, head, ws => { const stream = this.#stream(ws, pending.link); pending.accept(stream); }); return true;
    }
    const invitation = this.store.state.invitations.find(i => digest(token) === i.hash && (i.hubId || i.expiresAt > Date.now()));
    if (!this.store.state.accepting || !token || !invitation || this.#handshakes.size >= 64) { reject(); return true; }
    this.#controls.handleUpgrade(req, socket, head, ws => {
      const challenge = random(); this.#handshakes.add(ws); ws.on('error', () => {});
      const timer = setTimeout(() => ws.terminate(), 10_000); timer.unref();
      ws.once('close', () => { clearTimeout(timer); this.#handshakes.delete(ws); });
      ws.send(JSON.stringify({ type: 'challenge', challenge, hubId: this.store.id, publicKey: this.store.state.publicKey,
        signature: signed({ challenge, audience: 'hub-peer' }, this.store.state.privateKey) }));
      ws.once('message', raw => {
        try {
          const hello = JSON.parse(raw.toString());
          if (Buffer.byteLength(raw.toString()) > 16_384 || hello.type !== 'hello' || !validHubId(hello.hubId) || hello.hubId === this.store.id || hubId(hello.publicKey) !== hello.hubId
            || !verified({ challenge, audience: this.store.id }, hello.signature, hello.publicKey)
            || (invitation.hubId && (invitation.hubId !== hello.hubId || invitation.publicKey !== hello.publicKey))
            || !this.store.state.accepting || !this.store.state.invitations.includes(invitation)) throw new Error('Unverified Hub');
          if (!invitation.hubId) {
            const before = structuredClone(invitation), revision = this.store.state.revision, audit = [...this.store.state.audit];
            try {
              invitation.hubId = hello.hubId; invitation.publicKey = hello.publicKey;
              invitation.name = typeof hello.name === 'string' ? hello.name.slice(0, 128) : hello.hubId;
              this.store.record(hello.hubId, 'redeem_invitation');
            } catch (error) {
              delete invitation.hubId; delete invitation.publicKey; delete invitation.name; Object.assign(invitation, before);
              this.store.state.revision = revision; this.store.state.audit = audit;
              throw error;
            }
          }
          clearTimeout(timer); this.#handshakes.delete(ws);
          const link = this.#attach(hello.hubId, hello.publicKey, ws, null, invitation);
          ws.send(JSON.stringify({ type: 'ready' })); this.#announce(); this.options.onRoutes?.();
          if (this.links.get(link.id) !== link) ws.terminate();
        } catch { ws.terminate(); }
      });
    }); return true;
  }
  #attach(id: string, key: string, ws: WebSocket, outgoing: Peer | null, invitation: Invitation | null): Link {
    const previous = this.links.get(id); if (previous) this.#retire(previous);
    const link: Link = { id, publicKey: key, ws, outgoing, invitation, streams: new Set(), epoch: 0, lastAdvertisement: '', alive: true };
    this.links.set(id, link); ws.on('pong', () => { link.alive = true; }); ws.on('error', () => {});
    ws.on('message', raw => {
      try { if (this.links.get(id) !== link || Buffer.byteLength(raw.toString()) > 262_144) throw new Error('Retired connection'); this.#message(link, JSON.parse(raw.toString())); }
      catch { this.#retire(link); }
    }); ws.once('close', () => this.#retire(link)); return link;
  }
  #retire(link: Link) {
    if (this.links.get(link.id) === link) { this.links.delete(link.id); this.routing.remove(link.id); this.#announce(); this.options.onRoutes?.(); }
    for (const stream of link.streams) stream.destroy(); link.streams.clear(); link.ws.terminate();
    for (const [ws, owner] of this.#connecting) if (owner === link) { this.#connecting.delete(ws); ws.terminate(); }
    for (const [id, p] of this.#pending) if (p.link === link) { this.#pending.delete(id); p.reject(new Error('Hub disconnected')); }
    for (const [id, p] of this.#dials) if (p.link === link) { this.#dials.delete(id); p.reject(new Error('Hub disconnected')); }
  }
  #announce() {
    if (this.#closed) return;
    for (const link of this.links.values()) {
      const own = this.store.service();
      const routes: HubRoute[] = own ? [{ service: own, path: [this.store.id] }] : [];
      if (this.store.state.forwarding) routes.push(...this.routes().filter(r => !r.path.includes(link.id)).map(r => ({ service: r.service, path: [this.store.id, ...r.path] })));
      const serialized = JSON.stringify(routes);
      if (link.lastAdvertisement === serialized || link.ws.readyState !== WebSocket.OPEN) continue;
      link.lastAdvertisement = serialized; link.ws.send(JSON.stringify({ type: 'routes', epoch: ++link.epoch, routes }));
    }
    this.options.onRoutes?.();
  }
  #message(link: Link, m: any) {
    if (m.type === 'routes') {
      // Outgoing links may advertise only service origins explicitly named in the invitation too.
      this.routing.receive(link.id, m.epoch, m.routes, link.outgoing ?? link.invitation!); this.#announce(); return;
    }
    if (m.type === 'dial') {
      if (link.outgoing) throw new Error('Unexpected dial');
      this.#validateDial(m); this.#checkDispatch(m.target, m.path, link);
      this.#reserve(link, m.id, stream => this.#dispatch(stream, m.target, m.path, link), () => {});
      const p = this.#pending.get(m.id)!;
      link.ws.send(JSON.stringify({ type: 'open', id: m.id, target: m.target, path: m.path, token: p.token, dispatch: 'server' })); return;
    }
    if (m.type === 'open') {
      if (!link.outgoing || typeof m.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(m.token) || !['server', 'client'].includes(m.dispatch)) throw new Error('Invalid data channel');
      this.#validateDial(m);
      if (m.dispatch === 'client') this.#checkDispatch(m.target, m.path, link);
      const localDial = this.#dials.get(m.id);
      if (m.dispatch === 'server' && (!localDial || localDial.link !== link)) throw new Error('Unknown dial');
      if (this.#connecting.size >= 1024 || link.streams.size >= MAX_STREAMS) throw new Error('Stream capacity');
      const ws = new WebSocket(link.outgoing.endpoint.replace(/^http/u, 'ws') + HUB_DATA_PATH, HUB_PROTOCOL, { ca: link.outgoing.ca, perMessageDeflate: false,
        maxPayload: 65_536, handshakeTimeout: 10_000, headers: { authorization: 'Bearer ' + m.token, 'x-opencraft-hub-stream': m.id } });
      this.#connecting.set(ws, link); ws.once('close', () => this.#connecting.delete(ws));
      ws.on('error', () => { localDial?.reject(new Error('Data connection failed')); });
      ws.once('open', () => {
        this.#connecting.delete(ws);
        if (this.links.get(link.id) !== link) { ws.terminate(); return; }
        const stream = this.#stream(ws, link);
        if (m.dispatch === 'server') { this.#dials.delete(m.id); localDial!.resolve(stream); }
        else this.#dispatch(stream, m.target, m.path, link);
      }); return;
    }
    throw new Error('Unknown Hub message');
  }
  #validateDial(m: Dial) {
    if (typeof m.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(m.id) || !validHubId(m.target) || !Array.isArray(m.path)
      || !m.path.length || m.path.length >= MAX_HOPS || m.path.some(p => !validHubId(p)) || new Set(m.path).size !== m.path.length || m.path.includes(this.store.id)) throw new Error('Invalid path');
  }
  #checkDispatch(target: string, path: string[], link: Link) {
    if (this.links.get(link.id) !== link || path.at(-1) !== link.id || path.includes(this.store.id) || path.length >= MAX_HOPS) throw new Error('Unverified path');
    const service = target === this.store.id ? this.store.service() : this.routing.find(target, path)?.service;
    const policy = link.outgoing ?? link.invitation!;
    if (!service || !policy.origins.includes(service.origin) || (target !== this.store.id && (!this.store.state.forwarding || !policy.allowTransit))) throw new Error('Forwarding denied');
  }
  #stream(ws: WebSocket, link: Link): Duplex {
    if (link.streams.size >= MAX_STREAMS || this.#streams.size >= 1024) { ws.terminate(); throw new Error('Stream capacity'); }
    const stream = relayDuplex(ws); link.streams.add(stream); this.#streams.add(stream);
    stream.on('error', () => {});
    const timer = setTimeout(() => stream.destroy(), 3600_000); timer.unref();
    stream.once('close', () => { clearTimeout(timer); link.streams.delete(stream); this.#streams.delete(stream); ws.terminate(); }); return stream;
  }
  #reserve(link: Link, id: string, accept: (stream: Duplex) => void, reject: (error: Error) => void) {
    if (this.#pending.has(id) || this.#pending.size >= 1024 || link.streams.size >= MAX_STREAMS) throw new Error('Stream capacity');
    const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error('Hub data timeout')); }, 10_000); timer.unref();
    this.#pending.set(id, { link, token: random(), accept: s => { clearTimeout(timer); accept(s); }, reject: e => { clearTimeout(timer); reject(e); } });
  }
  async #dispatch(stream: Duplex, target: string, path: string[], link: Link) {
    let next: Duplex | undefined;
    try {
      this.#checkDispatch(target, path, link);
      if (target === this.store.id) { this.#local.accept(stream); return; }
      next = await this.open(target, [...path, this.store.id]);
      if (this.links.get(link.id) !== link || stream.destroyed) { next.destroy(); stream.destroy(); return; }
      next.on('error', () => stream.destroy()); stream.on('error', () => next?.destroy());
      next.once('close', () => stream.destroy()); stream.once('close', () => next?.destroy()); stream.pipe(next); next.pipe(stream);
    } catch { next?.destroy(); stream.destroy(); }
  }
  async open(target: string, path = [this.store.id], signal?: AbortSignal): Promise<Duplex> {
    if (this.#closed || signal?.aborted || !validHubId(target) || path.length >= MAX_HOPS || new Set(path).size !== path.length || path.at(-1) !== this.store.id) throw new Error('Invalid route');
    const route = this.routing.find(target, path), link = route && this.links.get(route.path[0]!);
    if (!route || !link) throw new Error('Hub unavailable');
    const policy = link.outgoing ?? link.invitation!;
    if (!policy.origins.includes(route.service.origin) || (target !== link.id && !policy.allowTransit)) throw new Error('Forwarding denied');
    const id = randomUUID();
    return new Promise<Duplex>((resolve, reject) => {
      const timer = setTimeout(() => failed(new Error('Hub open timeout')), 10_000); timer.unref();
      const abort = () => failed(new Error('Hub open aborted'));
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.#dials.delete(id); };
      const failed = (e: Error) => { done(); this.#pending.delete(id); reject(e); };
      const accepted = (stream: Duplex) => { done(); if (signal?.aborted) { stream.destroy(); reject(new Error('Hub aborted')); } else resolve(stream); };
      signal?.addEventListener('abort', abort, { once: true });
      if (link.outgoing) {
        if (this.#dials.size >= 1024) { failed(new Error('Dial capacity')); return; }
        this.#dials.set(id, { link, resolve: accepted, reject: failed }); link.ws.send(JSON.stringify({ type: 'dial', id, target, path }));
      } else {
        try { this.#reserve(link, id, accepted, failed); link.ws.send(JSON.stringify({ type: 'open', id, target, path, token: this.#pending.get(id)!.token, dispatch: 'client' })); }
        catch { failed(new Error('Hub capacity')); }
      }
    });
  }
  #syncClients() {
    for (const [id, client] of this.#clients) if (!this.store.state.peers.some(p => p.id === id)) {
      client.stopped = true; clearTimeout(client.timer); client.ws?.terminate(); this.#clients.delete(id);
    }
    if (!this.#targetPort || this.#closed) return;
    for (const peer of this.store.state.peers) {
      if (this.#clients.has(peer.id)) continue;
      const client: { ws?: WebSocket; timer?: ReturnType<typeof setTimeout>; stopped: boolean; attempts: number } = { stopped: false, attempts: 0 }; this.#clients.set(peer.id, client);
      const connect = () => {
        if (client.stopped || this.#closed) return;
        const ws = new WebSocket(peer.endpoint.replace(/^http/u, 'ws') + HUB_CONTROL_PATH, HUB_PROTOCOL, { ca: peer.ca, perMessageDeflate: false, maxPayload: 262_144,
          handshakeTimeout: 10_000, headers: { authorization: 'Bearer ' + peer.credential } }); client.ws = ws; ws.on('error', () => {});
        const timer = setTimeout(() => ws.terminate(), 10_000); timer.unref();
        ws.once('message', raw => {
          try {
            const m = JSON.parse(raw.toString());
            if (m.type !== 'challenge' || m.hubId !== peer.hubId || m.publicKey !== peer.publicKey || typeof m.challenge !== 'string' || m.challenge.length !== 43
              || !verified({ challenge: m.challenge, audience: 'hub-peer' }, m.signature, peer.publicKey)) throw new Error('Wrong peer');
            ws.send(JSON.stringify({ type: 'hello', hubId: this.store.id, name: this.store.state.name, publicKey: this.store.state.publicKey, signature: signed({ challenge: m.challenge, audience: peer.hubId }, this.store.state.privateKey) }));
            ws.once('message', rawReady => {
              try { if (JSON.parse(rawReady.toString()).type !== 'ready' || client.stopped) throw new Error('Not ready');
                clearTimeout(timer); client.attempts = 0; this.#attach(peer.hubId, peer.publicKey, ws, peer, null); this.#announce(); } catch { ws.terminate(); }
            });
          } catch { ws.terminate(); }
        });
        ws.once('close', () => {
          clearTimeout(timer); if (!client.stopped && !this.#closed) { client.timer = setTimeout(connect, Math.min(30_000, 250 * 2 ** Math.min(client.attempts++, 7))); client.timer.unref(); }
        });
      }; connect();
    }
  }
  close() {
    if (this.#closed) return; this.#closed = true; clearInterval(this.#heartbeat);
    for (const client of this.#clients.values()) { client.stopped = true; clearTimeout(client.timer); client.ws?.terminate(); } this.#clients.clear();
    for (const ws of this.#handshakes) ws.terminate(); this.#handshakes.clear();
    for (const ws of this.#connecting.keys()) ws.terminate(); this.#connecting.clear();
    for (const link of this.links.values()) this.#retire(link); for (const stream of this.#streams) stream.destroy();
    this.#controls.close(); this.#data.close(); this.#local.close(); this.store.close();
  }
}
