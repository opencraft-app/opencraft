import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { bridgeRelayDuplex, relayDuplex } from "@opencraft/relay-protocol/node";
import { DATA_PATH, STREAM_HEADER } from "@opencraft/relay-protocol";
import { readPrivateJson } from "@opencraft/identity-core/node";
import { HubNetwork } from "@opencraft/hub-network/node";
import {
  HUB_CONTROL_PATH,
  HUB_DATA_PATH,
  type HubNetworkSnapshot,
  type HubRoute,
  type IdentityAuthority,
} from "@opencraft/hub-network";
import { validService, MemoryHubStore, parseHubState, type State } from "@opencraft/hub-network/store";
import { RelayRedis } from "./redis.js";
import type { RelayClusterPort, RelayHub } from "./cluster-port.js";

const LEASE_MS = 12_000;
const TICK_MS = 2000;
const AUTH = "x-opencraft-relay-cluster-auth";
const FORWARD = "x-opencraft-relay-cluster-path";
interface Owner {
  node: string;
  endpoint: string;
  claim: string;
}
interface PublishedHub {
  owner: string;
  sequence: number;
  snapshot: HubNetworkSnapshot;
  routes: HubRoute[];
}
type Handlers = Parameters<RelayClusterPort["bind"]>[0];
function equal(a: unknown, b: string) {
  return (
    typeof a === "string" &&
    timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest())
  );
}
function rejected(socket: Duplex, status = 503) {
  socket.end(
    `HTTP/1.1 ${status >= 400 && status <= 599 ? status : 503} Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}
function owner(value: string | null, internalPort: number): Owner | null {
  if (!value) return null;
  const v = JSON.parse(value) as Owner;
  if (
    !v ||
    typeof v.node !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/u.test(v.node) ||
    typeof v.claim !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(v.claim) ||
    typeof v.endpoint !== "string"
  )
    throw new Error("Invalid relay connection owner");
  const url = new URL(v.endpoint),
    host = url.hostname.replace(/^\[|\]$/gu, "");
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    Number(url.port || 80) !== internalPort ||
    !isIP(host) ||
    host.startsWith("169.254.")
  )
    throw new Error("Invalid relay owner endpoint");
  return v;
}

/** Shared metadata is in Redis; byte streams remain direct, bounded duplex connections. */
export class RedisRelayCluster implements RelayClusterPort {
  readonly nodeId: string;
  readonly sessions: RelayRedis;
  readonly hub: RelayHub;
  readonly #internal = createServer((req, res) => {
    void this.#request(req, res).catch(() => {
      res.writeHead(503);
      res.end();
    });
  });
  readonly #websockets = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
  readonly #sockets = new Set<WebSocket>();
  readonly #tunnels = new Set<Duplex>();
  readonly #dataTunnels = new Set<Duplex>();
  readonly #forwarded = new WeakSet<IncomingMessage>();
  readonly #connections = new Map<string, { value: string; retire: () => void }>();
  readonly #retained = new Set<() => void>();
  readonly #pending = new Map<string, string>();
  readonly #self: Owner;
  #handlers?: Handlers;
  #timer?: ReturnType<typeof setInterval>;
  #tickRunning = false;
  #closed = false;
  #upgrading = 0;
  #ready = false;
  #leaderValue: string | null = null;
  #deadline = 0;
  #node?: HubNetwork;
  #published?: PublishedHub;
  #publishSequence = 0;
  #prepareGeneration = 0;
  #appliedPrepareGeneration = 0;
  readonly #tickWaiters: (() => void)[] = [];
  constructor(
    readonly redis: RelayRedis,
    readonly options: {
      nodeId: string;
      advertiseHost: string;
      publicPort: number;
      stateFile: string;
      authority?: IdentityAuthority;
      ca?: string;
      configurationHash: string;
    },
  ) {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(options.nodeId) || !isIP(options.advertiseHost))
      throw new Error("Explicit relay replica identity and IP are required");
    this.sessions = redis;
    this.nodeId = options.nodeId.slice(0, 90) + "-" + randomUUID();
    this.#self = {
      node: this.nodeId,
      endpoint: `http://${isIP(options.advertiseHost) === 6 ? "[" + options.advertiseHost + "]" : options.advertiseHost}:${redis.configuration.internalPort}/`,
      claim: randomUUID(),
    };
    this.hub = {
      snapshot: () => {
        if (!this.#published) throw new Error("Hub owner unavailable");
        return this.#published.snapshot;
      },
      routes: () => this.#published?.routes ?? [],
      command: (input, operator) => this.#command(input, operator),
      handleUpgrade: (req, socket, head) => (this.#ownsHub() ? this.#node!.handleUpgrade(req, socket, head) : false),
      open: (id, path, signal) => {
        if (path !== undefined) throw new Error("Cluster ingress cannot select a Hub path");
        return this.#open("hub", id, signal ?? new AbortController().signal);
      },
    };
    this.#internal.on("upgrade", (req, socket, head) => {
      socket.on("error", () => {});
      this.#upgrading++;
      void this.#upgrade(req, socket, head)
        .catch(() => rejected(socket))
        .finally(() => {
          this.#upgrading--;
        });
    });
    this.#internal.headersTimeout = 15_000;
    this.#internal.requestTimeout = 15_000;
    this.#internal.maxConnections = 16_384;
    this.#internal.maxRequestsPerSocket = 1000;
  }
  bind(handlers: Handlers) {
    if (this.#handlers) throw new Error("Relay cluster already bound");
    this.#handlers = handlers;
  }
  retainStreams(retire: () => void) {
    this.#retained.add(retire);
    return () => {
      this.#retained.delete(retire);
    };
  }
  activeStreams() {
    return this.#upgrading + this.#sockets.size + this.#dataTunnels.size + (this.#node?.activeStreams() ?? 0);
  }
  async start() {
    try {
      if (!this.#handlers) throw new Error("Relay cluster is not bound");
      const seed = parseHubState(await readPrivateJson(this.options.stateFile));
      const accepted = await this.redis.evaluate(
        "local v=redis.call('GET',KEYS[1]); if v and v~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[1]); return 1",
        ["configuration"],
        [this.options.configurationHash],
      );
      if (accepted !== 1) throw new Error("Replica configuration differs from this relay cluster");
      // The existing HubStore validates the identity and policies before opening an owner.
      await this.redis.evaluate(
        "if not redis.call('GET',KEYS[1]) then redis.call('SET',KEYS[1],ARGV[1]); end; return 1",
        ["hub-state"],
        [JSON.stringify(seed)],
      );
      await new Promise<void>((resolve, reject) => {
        this.#internal.once("error", reject);
        this.#internal.listen(this.redis.configuration.internalPort, this.options.advertiseHost, () => {
          this.#internal.off("error", reject);
          resolve();
        });
      });
      await this.#tick();
      if (!this.#ready) throw new Error("Relay cluster initialization failed");
      this.#timer = setInterval(() => {
        void this.#tick();
      }, TICK_MS);
      this.#timer.unref();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  #ownsHub() {
    return !!this.#node && !!this.#leaderValue && performance.now() < this.#deadline && !this.#closed;
  }
  async #persist(state: Readonly<State>, expectedOwner: string) {
    if (!this.#ownsHub() || this.#leaderValue !== expectedOwner) throw new Error("Hub lease retired");
    const result = await this.redis.evaluate(
      "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[2],ARGV[2]); return 1",
      ["hub-owner", "hub-state"],
      [expectedOwner, JSON.stringify(state)],
    );
    if (result !== 1) {
      if (this.#leaderValue === expectedOwner) this.#fail();
      throw new Error("Hub lease retired");
    }
  }
  async #activate(value: string) {
    const state = await this.redis.read("hub-state");
    if (!state || state.length > 1_048_576) throw new Error("Invalid shared Hub state");
    const seed = (await readPrivateJson(this.options.stateFile)) as { publicKey?: unknown };
    if ((JSON.parse(state) as { publicKey?: unknown }).publicKey !== seed.publicKey)
      throw new Error("Redis namespace belongs to another Hub identity");
    const node = new HubNetwork(new MemoryHubStore(JSON.parse(state)), {
      localService: false,
      ...(this.options.authority ? { authority: this.options.authority } : {}),
      ...(this.options.ca ? { ca: this.options.ca } : {}),
      persist: (state) => this.#persist(state, value),
      onRoutes: () => {
        if (this.#node === node)
          void this.#publish().catch(() => {
            if (this.#node === node) this.#fail();
          });
      },
    });
    if (this.#closed || value !== this.#leaderValue) {
      node.close();
      return;
    }
    this.#node = node;
    await this.#persist(node.store.state, value);
    if (!this.#ownsHub() || this.#node !== node) throw new Error("Hub lease retired");
    node.start(this.options.publicPort);
    await this.#publish();
  }
  async #publish() {
    if (!this.#ownsHub()) throw new Error("Hub lease retired");
    const published: PublishedHub = {
      owner: this.#leaderValue!,
      sequence: ++this.#publishSequence,
      snapshot: this.#node!.snapshot(),
      routes: this.#node!.routes(),
    };
    const result = await this.redis.evaluate(
      `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
      local old=redis.call('GET',KEYS[2]); if old then local p=cjson.decode(old); if p.owner==ARGV[1] and p.sequence>=tonumber(ARGV[4]) then return 2 end end
      redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]); return 1`,
      ["hub-owner", "hub-routes"],
      [this.#leaderValue!, JSON.stringify(published), LEASE_MS, published.sequence],
    );
    if (result !== 1 && result !== 2) throw new Error("Hub lease retired");
    if (result === 1 && (this.#published?.owner !== published.owner || this.#published.sequence <= published.sequence))
      this.#published = published;
  }
  #fail() {
    this.#ready = false;
    this.#deadline = 0;
    const node = this.#node;
    this.#node = undefined;
    try {
      node?.close();
    } catch {
      /* The owner is still fenced by the Redis lease. */
    }
    this.#leaderValue = null;
    for (const entry of this.#connections.values()) entry.retire();
    this.#connections.clear();
    for (const retire of this.#retained) retire();
    this.#retained.clear();
    for (const socket of this.#sockets) socket.terminate();
    for (const tunnel of this.#tunnels) tunnel.destroy();
  }
  async #tick() {
    if (this.#tickRunning || this.#closed) return;
    this.#tickRunning = true;
    try {
      const start = performance.now();
      if (this.#leaderValue) {
        if (!this.#ownsHub() || !(await this.redis.renew("hub-owner", this.#leaderValue, LEASE_MS))) this.#fail();
        else {
          this.#deadline = start + LEASE_MS;
          await this.#publish();
        }
      }
      if (!this.#leaderValue) {
        if (this.#closed) return;
        const value = JSON.stringify({ ...this.#self, claim: randomUUID() });
        const claimed = await this.redis.evaluate(
          `if redis.call('GET',KEYS[1])~=ARGV[1] then return -1 end
          if redis.call('SET',KEYS[2],ARGV[2],'NX','PX',ARGV[3]) then return 1 end; return 0`,
          ["configuration", "hub-owner"],
          [this.options.configurationHash, value, LEASE_MS],
        );
        if (claimed === -1) throw new Error("Relay configuration retired");
        if (claimed === 1) {
          if (this.#closed) {
            await this.redis.release("hub-owner", value);
            return;
          }
          this.#leaderValue = value;
          this.#deadline = start + LEASE_MS;
          await this.#activate(value);
        }
      }
      for (const [id, entry] of [...this.#connections]) {
        if (this.#closed) return;
        if (!(await this.redis.renew(`connection:${id}`, entry.value, LEASE_MS))) {
          if (this.#connections.get(id) === entry) {
            this.#connections.delete(id);
            entry.retire();
          }
        }
      }
      if (!this.#closed) this.#ready = true;
    } catch {
      this.#fail();
    } finally {
      this.#tickRunning = false;
      for (const resolve of this.#tickWaiters.splice(0)) resolve();
    }
  }
  async prepare() {
    if (!this.#ready || this.#closed) throw new Error("Relay shared state unavailable");
    const generation = ++this.#prepareGeneration,
      localOwner = this.#leaderValue;
    let value: unknown;
    try {
      value = await this.redis.evaluate(
        "return {redis.call('GET',KEYS[1]) or '',redis.call('GET',KEYS[2]) or '',redis.call('GET',KEYS[3]) or ''}",
        ["hub-owner", "hub-routes", "configuration"],
      );
    } catch (error) {
      if (generation >= this.#appliedPrepareGeneration) this.#fail();
      throw error;
    }
    if (!Array.isArray(value) || value[2] !== this.options.configurationHash) {
      this.#fail();
      throw new Error("Relay configuration retired");
    }
    if (localOwner && localOwner === this.#leaderValue && Array.isArray(value) && value[0] !== localOwner) {
      this.#fail();
      throw new Error("Hub lease retired");
    }
    if (
      !Array.isArray(value) ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string" ||
      !owner(value[0], this.redis.configuration.internalPort)
    )
      throw new Error("Hub owner unavailable");
    const published = JSON.parse(value[1]) as PublishedHub;
    if (
      published.owner !== value[0] ||
      !Number.isSafeInteger(published.sequence) ||
      !published.snapshot ||
      published.snapshot.schemaVersion !== 1 ||
      !Array.isArray(published.snapshot.peers) ||
      !Array.isArray(published.routes) ||
      published.routes.length > 1000
    )
      throw new Error("Hub owner is recovering");
    for (const route of published.routes) {
      validService(route.service);
      if (
        !Array.isArray(route.path) ||
        !route.path.length ||
        route.path.length > 8 ||
        route.path.some((id) => typeof id !== "string" || !/^hub-[a-f0-9]{40}$/u.test(id))
      )
        throw new Error("Invalid shared Hub route");
    }
    if (generation >= this.#appliedPrepareGeneration) {
      this.#appliedPrepareGeneration = generation;
      if (this.#ownsHub() && published.owner !== this.#leaderValue) throw new Error("Hub owner changed during request");
      if (this.#published?.owner !== published.owner || this.#published.sequence <= published.sequence)
        this.#published = published;
    }
  }
  async claimConnection(instanceId: string, retire: () => void) {
    if (this.#closed || !this.#ready) throw new Error("Relay replica retired");
    const value = JSON.stringify({ ...this.#self, claim: randomUUID() });
    await this.redis.write(`connection:${instanceId}`, value, LEASE_MS);
    if (this.#closed) {
      await this.redis.release(`connection:${instanceId}`, value);
      throw new Error("Relay replica retired");
    }
    const previous = this.#connections.get(instanceId);
    this.#connections.set(instanceId, { value, retire });
    previous?.retire();
    return value;
  }
  async releaseConnection(instanceId: string, claim: string) {
    if (this.#connections.get(instanceId)?.value === claim) this.#connections.delete(instanceId);
    await this.redis.release(`connection:${instanceId}`, claim);
  }
  async registerPending(id: string) {
    if (this.#closed || !this.#ready) throw new Error("Relay replica retired");
    const value = JSON.stringify(this.#self);
    this.#pending.set(id, value);
    await this.redis.write(`pending:${id}`, value, 10_000);
  }
  async releasePending(id: string) {
    const value = this.#pending.get(id);
    if (!value) return;
    this.#pending.delete(id);
    await this.redis.release(`pending:${id}`, value);
  }
  open(instanceId: string, signal: AbortSignal) {
    return this.#open("instance", instanceId, signal);
  }
  async #open(kind: "hub" | "instance", id: string, signal: AbortSignal): Promise<Duplex> {
    const value = await this.redis.read(kind === "hub" ? "hub-owner" : `connection:${id}`);
    const destination = owner(value, this.redis.configuration.internalPort);
    if (!destination || signal.aborted) throw new Error("Instance unavailable");
    if (destination.node === this.#self.node) {
      if (kind === "hub") {
        if (!this.#ownsHub() || value !== this.#leaderValue) throw new Error("Hub owner retired");
        return this.#node!.open(id, undefined, signal);
      }
      return this.#handlers!.channel(id, signal, value!);
    }
    return await new Promise<Duplex>((resolve, reject) => {
      const address = new URL("channel", destination.endpoint);
      address.protocol = "ws:";
      address.searchParams.set("kind", kind);
      address.searchParams.set("id", id);
      address.searchParams.set("claim", destination.claim);
      const ws = new WebSocket(address, {
        headers: { [AUTH]: this.redis.configuration.credential },
        perMessageDeflate: false,
        maxPayload: 65_536,
        handshakeTimeout: 10_000,
      });
      this.#track(ws);
      const abort = () => ws.terminate();
      signal.addEventListener("abort", abort, { once: true });
      ws.once("close", () => signal.removeEventListener("abort", abort));
      ws.once("error", reject);
      ws.once("open", () => {
        if (signal.aborted) {
          ws.terminate();
          reject(new Error("Request cancelled"));
        } else resolve(relayDuplex(ws));
      });
    });
  }
  #track(ws: WebSocket) {
    this.#sockets.add(ws);
    ws.on("error", () => {});
    ws.once("close", () => this.#sockets.delete(ws));
  }
  async #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (!equal(req.headers[AUTH], this.redis.configuration.credential) || this.#closed) {
      rejected(socket);
      return;
    }
    await this.prepare();
    const url = new URL(req.url ?? "/", this.#self.endpoint);
    if (url.pathname === "/forward") {
      const path = req.headers[FORWARD];
      if (typeof path !== "string" || ![DATA_PATH, HUB_CONTROL_PATH, HUB_DATA_PATH].includes(path)) {
        rejected(socket);
        return;
      }
      delete req.headers[AUTH];
      delete req.headers[FORWARD];
      req.url = path;
      this.#forwarded.add(req);
      this.#handlers!.upgrade(req, socket, head);
      return;
    }
    if (url.pathname !== "/channel") {
      rejected(socket);
      return;
    }
    const kind = url.searchParams.get("kind"),
      id = url.searchParams.get("id"),
      claim = url.searchParams.get("claim");
    if (!id || !/^[A-Za-z0-9._-]{1,128}$/u.test(id) || !["hub", "instance"].includes(kind ?? "")) {
      rejected(socket);
      return;
    }
    const value = await this.redis.read(kind === "hub" ? "hub-owner" : `connection:${id}`),
      current = owner(value, this.redis.configuration.internalPort);
    if (
      !current ||
      current.node !== this.#self.node ||
      current.claim !== claim ||
      (kind === "hub" && (!this.#ownsHub() || value !== this.#leaderValue))
    ) {
      rejected(socket);
      return;
    }
    const abort = new AbortController();
    let stream: Duplex | undefined;
    const cancelled = () => {
      abort.abort();
      stream?.destroy();
    };
    socket.once("close", cancelled);
    stream =
      kind === "hub"
        ? await this.#node!.open(id, undefined, abort.signal)
        : await this.#handlers!.channel(id, abort.signal, value!);
    if (socket.destroyed || abort.signal.aborted) {
      stream.destroy();
      return;
    }
    this.#websockets.handleUpgrade(req, socket, head, (ws) => {
      socket.off("close", cancelled);
      this.#track(ws);
      const transport = relayDuplex(ws);
      bridgeRelayDuplex(stream!, transport);
    });
  }
  async forwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const hub = [HUB_CONTROL_PATH, HUB_DATA_PATH].includes(req.url ?? "");
    if (this.#forwarded.has(req)) {
      if (hub && !this.#ownsHub()) {
        rejected(socket);
        return true;
      }
      return false;
    }
    const pendingId = req.headers[STREAM_HEADER];
    if (!hub && (req.url !== DATA_PATH || typeof pendingId !== "string" || !/^[a-f0-9-]{36}$/u.test(pendingId)))
      return false;
    const destination = owner(
      await this.redis.read(hub ? "hub-owner" : `pending:${pendingId}`),
      this.redis.configuration.internalPort,
    );
    if (!destination) {
      if (hub) rejected(socket);
      return hub;
    }
    if (destination.node === this.#self.node) return false;
    const upstream = request(new URL("forward", destination.endpoint), {
      method: "GET",
      headers: { ...req.headers, [AUTH]: this.redis.configuration.credential, [FORWARD]: req.url! },
    });
    const timer = setTimeout(() => upstream.destroy(), 10_000);
    timer.unref();
    const cancelled = () => {
      clearTimeout(timer);
      upstream.destroy();
    };
    socket.once("close", cancelled);
    upstream.on("error", () => socket.destroy());
    upstream.once("upgrade", (response, tunnel, initial) => {
      this.#tunnels.add(tunnel);
      tunnel.once("close", () => this.#tunnels.delete(tunnel));
      if (req.url !== HUB_CONTROL_PATH) {
        this.#dataTunnels.add(tunnel);
        tunnel.once("close", () => this.#dataTunnels.delete(tunnel));
      }
      socket.off("close", cancelled);
      clearTimeout(timer);
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${x}`))
          .join("\r\n")}\r\n\r\n`,
      );
      if (initial.length) socket.write(initial);
      if (head.length) tunnel.write(head);
      bridgeRelayDuplex(socket, tunnel);
    });
    upstream.once("response", (response) => {
      clearTimeout(timer);
      response.resume();
      rejected(socket, response.statusCode);
    });
    upstream.end();
    return true;
  }
  async #command(input: Record<string, unknown>, operator: string): Promise<ReturnType<HubNetwork["command"]>> {
    const destination = owner(await this.redis.read("hub-owner"), this.redis.configuration.internalPort);
    if (!destination) throw new Error("Hub owner unavailable");
    if (destination.node === this.#self.node) {
      if (!this.#ownsHub()) throw new Error("Hub owner retired");
      const result = await this.#node!.durableCommand(input, operator);
      await this.#publish();
      return result;
    }
    return await new Promise((resolve, reject) => {
      const body = JSON.stringify({ input, operator, claim: destination.claim });
      const upstream = request(
        new URL("command", destination.endpoint),
        {
          method: "POST",
          headers: {
            [AUTH]: this.redis.configuration.credential,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += String(chunk);
            if (body.length > 2_097_152) upstream.destroy();
          });
          response.on("error", reject);
          response.on("end", () => {
            try {
              const result = JSON.parse(body);
              if (response.statusCode !== 200 || !result?.snapshot || result.snapshot.schemaVersion !== 1)
                throw new Error("Hub command unavailable");
              resolve(result);
            } catch {
              reject(new Error("Hub command unavailable"));
            }
          });
        },
      );
      upstream.setTimeout(10_000, () => upstream.destroy());
      upstream.on("error", () => reject(new Error("Hub command unavailable")));
      upstream.end(body);
    });
  }
  async #request(req: IncomingMessage, res: ServerResponse) {
    if (
      !equal(req.headers[AUTH], this.redis.configuration.credential) ||
      req.method !== "POST" ||
      req.url !== "/command" ||
      !this.#ownsHub()
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 65_536) throw new Error("Command too large");
    }
    const value = JSON.parse(body);
    if (
      !value ||
      value.claim !== JSON.parse(this.#leaderValue!).claim ||
      !value.input ||
      typeof value.input !== "object" ||
      Array.isArray(value.input) ||
      typeof value.operator !== "string" ||
      value.operator.length > 512
    )
      throw new Error("Invalid internal Hub command");
    const result = await this.#node!.durableCommand(value.input, value.operator);
    await this.#publish();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(result));
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    const leader = this.#leaderValue,
      entries = [...this.#connections],
      pending = [...this.#pending];
    this.#fail();
    if (this.#tickRunning) await new Promise<void>((resolve) => this.#tickWaiters.push(resolve));
    await Promise.allSettled([
      ...entries.map(([id, entry]) => this.redis.release(`connection:${id}`, entry.value)),
      ...pending.map(([id, value]) => this.redis.release(`pending:${id}`, value)),
      ...(leader ? [this.redis.release("hub-owner", leader)] : []),
    ]);
    await new Promise<void>((resolve) => {
      this.#internal.close(() => resolve());
      this.#internal.closeAllConnections();
    });
    this.#websockets.close();
    this.redis.close();
  }
}
