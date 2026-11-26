import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  CONTROL_PATH,
  DATA_PATH,
  DRAIN_CAPABILITY,
  DRAIN_HEADER,
  MAX_STREAMS,
  RELAY_PROTOCOL,
  STREAM_HEADER,
} from "@opencraft/relay-protocol";
import { bridgeRelayDuplex, relayDuplex, relayIdleDeadline } from "@opencraft/relay-protocol/node";
import {
  MACHINE_SELF_UPDATE_METHOD,
  type PersonalMachineCommand,
  type PersonalMachinesDirectory,
} from "@opencraft/appserver-protocol/personal-machines";
import { PersonalMachineStore } from "./personal-machines-store.js";

const PREFIX = "/__opencraft_machines";
const UPDATE_TIMEOUT_MS = 180_000;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const equalSecret = (left: string, right: string): boolean =>
  Boolean(left && right)
  && timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
const equalHash = (secret: string, expectedHex: string): boolean =>
  Boolean(secret && /^[a-f0-9]{64}$/u.test(expectedHex))
  && timingSafeEqual(createHash("sha256").update(secret).digest(), Buffer.from(expectedHex, "hex"));
const bearer = (req: IncomingMessage): string =>
  /^Bearer ([A-Za-z0-9_-]{32,64})$/u.exec(req.headers.authorization ?? "")?.[1] ?? "";
const quote = (value: string): string => `'${value.replace(/'/gu, "'\\''")}'`;

export function personalMachineOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("Remote machine requires an origin");
  const url = new URL(value);
  if (
    url.origin !== value
    || url.username
    || url.password
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))
  ) {
    throw new Error("Remote machine requires HTTPS");
  }
  return url.origin;
}

/** Deployment-owned HTTPS callback address; never derive it from loopback, intranet HTTP or SSH tunnels. */
export function personalMachineEnrollmentOrigin(value: unknown): string {
  const origin = personalMachineOrigin(value);
  const url = new URL(origin);
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    url.protocol !== "https:"
    || host === "localhost"
    || host.endsWith(".localhost")
    || host === "0.0.0.0"
    || host === "[::]"
    || host === "[::1]"
    || /^127\./u.test(host)
    || host.startsWith("[::ffff:")
  ) {
    throw new Error("Remote enrollment requires an HTTPS Server origin");
  }
  return origin;
}

const json = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};

const readJsonBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 16_384) throw new Error("Request too large");
  }
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid JSON object");
  }
  return parsed as Record<string, unknown>;
};

interface MachineConnection {
  readonly id: string;
  readonly socket: WebSocket;
  readonly streams: Set<Duplex>;
  readonly version: string | null;
  readonly preservesStreams: boolean;
  detached: boolean;
}

export interface PersonalMachinesOptions {
  readonly directory: string;
  readonly ownerActorId: string;
  readonly ownerToken: string;
  readonly archive: string;
  readonly digest: string;
  readonly installer: string;
  readonly updater?: string;
  readonly enrollmentOrigin?: string;
  readonly enrollmentCa?: string;
}

export class PersonalMachines {
  readonly store: PersonalMachineStore;
  private readonly controlSockets = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  private readonly dataSockets = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
  private readonly connections = new Map<string, MachineConnection>();
  private readonly allConnections = new Set<MachineConnection>();
  private readonly updating = new Map<string, { targetDigest: string; startedAt: number; error: string | null }>();
  private readonly pending = new Map<
    string,
    { token: string; connection: MachineConnection; accept(ws: WebSocket): void; reject(): void }
  >();
  private readonly downloads = new Set<ServerResponse>();
  private closed = false;
  private closeOperation?: Promise<void>;

  constructor(private readonly options: PersonalMachinesOptions) {
    if (options.enrollmentOrigin) personalMachineEnrollmentOrigin(options.enrollmentOrigin);
    this.controlSockets.on("headers", (headers, req) => {
      if (req.headers[DRAIN_HEADER] === DRAIN_CAPABILITY) {
        headers.push(`${DRAIN_HEADER}: ${DRAIN_CAPABILITY}`);
      }
    });
    this.store = new PersonalMachineStore(options.directory, options.ownerActorId, () => {
      this.closed = true;
      for (const connection of [...this.allConnections]) this.retire(connection);
    });
  }

  async ready(): Promise<void> {
    await this.store.ready;
  }

  private buildUpdateCommand(id: string): string | null {
    const origin = this.options.enrollmentOrigin;
    if (!origin) return null;
    if (!this.options.enrollmentCa) {
      return `bash -o pipefail -c ${quote(`curl -fsS ${origin}${PREFIX}/install.sh | bash -s -- --update ${id}`)}`;
    }
    const encodedCa = Buffer.from(this.options.enrollmentCa).toString("base64");
    return `OPENCRAFT_MACHINE_ORIGIN=${quote(origin)} bash -c ${quote(
      `set -euo pipefail; curl --fail --silent --show-error --location --max-redirs 0 --cacert <(printf %s ${quote(encodedCa)} | base64 -d) ${quote(`${origin}${PREFIX}/install.sh`)} | bash -s -- --update ${id}`,
    )}`;
  }

  directory(): PersonalMachinesDirectory {
    const now = Date.now();
    return {
      hubId: this.store.state.hubId,
      ownerActorId: this.store.state.ownerActorId,
      enrollmentOrigin: this.options.enrollmentOrigin ?? null,
      digest: this.options.digest,
      machines: this.store.state.machines
        .filter((row) => row.credentialHash !== null || row.expiresAt > now)
        .map((row) => {
          const live = this.connections.get(row.id);
          const enrolled = row.credentialHash !== null;
          const upd = this.updating.get(row.id);
          if (upd && live?.version === upd.targetDigest) {
            this.updating.delete(row.id);
          } else if (upd && !upd.error && now - upd.startedAt > UPDATE_TIMEOUT_MS) {
            upd.error = "Remote update timed out";
          }
          const activeUpd = this.updating.get(row.id);
          const isUpdating = Boolean(activeUpd && !activeUpd.error && now - activeUpd.startedAt <= UPDATE_TIMEOUT_MS);
          return {
            id: row.id,
            name: row.machine?.name ?? "",
            machine: row.machine,
            connected: Boolean(live),
            phase: enrolled ? "enrolled" : "pending",
            expiresAt: enrolled ? null : row.expiresAt,
            version: live?.version ?? null,
            updateAvailable: live ? live.version !== this.options.digest : null,
            updateCommand: enrolled ? this.buildUpdateCommand(row.id) : null,
            ...(isUpdating ? { updating: true } : {}),
            ...(activeUpd?.error ? { updateError: activeUpd.error } : {}),
          };
        }),
    };
  }

  private openInternalRpc(id: string): Promise<WebSocket> {
    const connection = this.connections.get(id);
    if (!connection || connection.detached || connection.streams.size >= MAX_STREAMS || this.pending.size >= MAX_STREAMS) {
      return Promise.reject(new Error("Remote machine is offline or busy"));
    }
    return new Promise<WebSocket>((resolve, reject) => {
      const streamId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      let settled = false;
      const timer = setTimeout(() => {
        this.pending.delete(streamId);
        if (!settled) {
          settled = true;
          reject(new Error("Timed out opening remote machine stream"));
        }
      }, 10_000);
      timer.unref();
      this.pending.set(streamId, {
        connection,
        token,
        reject: () => {
          clearTimeout(timer);
          this.pending.delete(streamId);
          if (!settled) {
            settled = true;
            reject(new Error("Remote machine stream rejected"));
          }
        },
        accept: (ws) => {
          clearTimeout(timer);
          if (connection.detached || this.connections.get(id) !== connection) {
            ws.terminate();
            if (!settled) {
              settled = true;
              reject(new Error("Remote machine reconnected during stream setup"));
            }
            return;
          }
          const idle = relayIdleDeadline(ws, () => stream.destroy());
          const stream = relayDuplex(ws);
          connection.streams.add(stream);
          stream.once("close", () => {
            idle();
            connection.streams.delete(stream);
            this.forgetDetached(connection);
            ws.terminate();
          });
          const rpcWs = new WebSocket("ws://personal-machine/rpc", {
            createConnection: () => stream as unknown as ReturnType<typeof import("node:net").createConnection>,
            handshakeTimeout: 10_000,
          });
          rpcWs.once("open", () => {
            if (!settled) {
              settled = true;
              resolve(rpcWs);
            }
          });
          rpcWs.once("error", (err) => {
            stream.destroy();
            if (!settled) {
              settled = true;
              reject(err);
            }
          });
          rpcWs.once("close", () => stream.destroy());
        },
      });
      connection.socket.send(JSON.stringify({ type: "open", id: streamId, token }));
    });
  }

  private async triggerRemoteUpdate(id: string): Promise<void> {
    const updateCmd = this.buildUpdateCommand(id);
    if (!updateCmd) throw new Error("Remote enrollment address is not configured");
    const rpcWs = await this.openInternalRpc(id);
    let seq = 0;
    const logicalClientId = `pm-updater-${randomUUID()}`;
    const call = (method: string, params: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const reqId = `pm-update-${++seq}`;
        const timer = setTimeout(() => {
          rpcWs.off("message", onMessage);
          reject(new Error(`${method} timed out`));
        }, 15_000);
        timer.unref();
        const onMessage = (raw: WebSocket.RawData) => {
          try {
            const frame = JSON.parse(String(raw)) as {
              id?: unknown;
              result?: unknown;
              error?: { code?: unknown; message?: string };
            };
            if (frame.id !== reqId) return;
            clearTimeout(timer);
            rpcWs.off("message", onMessage);
            if (frame.error) {
              reject(Object.assign(new Error(frame.error.message ?? "RPC failed"), { code: frame.error.code }));
            } else {
              resolve(frame.result);
            }
          } catch {
            // Ignore unrelated frames on this disposable client.
          }
        };
        rpcWs.on("message", onMessage);
        rpcWs.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: reqId,
            method,
            params,
            __opencraftLogicalClientId: logicalClientId,
          }),
        );
      });
    try {
      await call("initialize", {
        clientInfo: { name: "opencraft-personal-machine-updater", version: "1" },
        capabilities: { experimentalApi: true },
      });
      try {
        await call(MACHINE_SELF_UPDATE_METHOD, {});
        return;
      } catch (err) {
        const code = (err as { code?: unknown })?.code;
        const msg = err instanceof Error ? err.message : "";
        if (code !== -32601 && code !== -32603 && !/not supported|unavailable/iu.test(msg)) throw err;
      }
      await call("process/spawn", {
        processHandle: `pm-self-update-${randomUUID()}`,
        command: "/bin/bash",
        args: ["-c", `nohup ${updateCmd} >"$HOME/.opencraft/machines/${id}/remote-update.log" 2>&1 </dev/null & sleep 0.3`],
        cols: 80,
        rows: 24,
      });
    } finally {
      rpcWs.close();
    }
  }

  async command(
    input: PersonalMachineCommand,
  ): Promise<PersonalMachinesDirectory & { command?: string; machineId?: string }> {
    if (!input || typeof input !== "object" || this.closed || !this.store.available) {
      throw new Error("Machine service unavailable");
    }
    if (input.action === "list") return this.directory();
    if (input.action === "create") {
      if (Object.keys(input).some((key) => key !== "action")) {
        throw new Error("Enrollment address belongs to the Server");
      }
      const origin = personalMachineEnrollmentOrigin(this.options.enrollmentOrigin);
      const reachable = this.options.enrollmentCa
        ? await new Promise<boolean>((resolve, reject) => {
            const req = httpsRequest(
              `${origin}${PREFIX}/install.sh`,
              { ca: this.options.enrollmentCa, timeout: 10_000 },
              (res) => {
                resolve(res.statusCode === 200 && res.headers["x-opencraft-machine-hub"] === this.store.state.hubId);
                res.resume();
              },
            );
            req.on("error", reject);
            req.on("timeout", () => req.destroy(new Error("Enrollment probe timeout")));
            req.end();
          })
        : await (async () => {
            const probe = await fetch(`${origin}${PREFIX}/install.sh`, {
              redirect: "error",
              signal: AbortSignal.timeout(10_000),
            });
            await probe.body?.cancel();
            return probe.ok && probe.headers.get("x-opencraft-machine-hub") === this.store.state.hubId;
          })();
      if (!reachable) throw new Error("Remote enrollment entrance is unavailable");
      const secret = randomBytes(32).toString("base64url");
      const state = await this.store.command("create", { pairHash: hash(secret) });
      const row = state.machines.at(-1)!;
      if (!this.options.enrollmentCa) {
        return {
          ...this.directory(),
          machineId: row.id,
          command: `bash -o pipefail -c ${quote(`curl -fsS ${origin}${PREFIX}/install.sh | bash -s -- ${secret}`)}`,
        };
      }
      const bootstrap = JSON.stringify({
        schemaVersion: 1,
        origin,
        hubId: state.hubId,
        id: row.id,
        secret,
        digest: this.options.digest,
        ca: this.options.enrollmentCa,
      });
      const encodedCa = Buffer.from(this.options.enrollmentCa).toString("base64");
      return {
        ...this.directory(),
        machineId: row.id,
        command: `OPENCRAFT_MACHINE_BOOTSTRAP=${quote(bootstrap)} bash -c ${quote(
          `set -euo pipefail; curl --fail --silent --show-error --location --max-redirs 0 --cacert <(printf %s ${quote(encodedCa)} | base64 -d) ${quote(`${origin}${PREFIX}/install.sh`)} | bash`,
        )}`,
      };
    }
    if (input.action === "revoke") {
      if (typeof input.id !== "string") throw new Error("Invalid machine");
      this.updating.delete(input.id);
      // Retire credentials durably BEFORE dropping live sockets so reconnect sees 403 and halts.
      await this.store.command("revoke", { id: input.id });
      for (const connection of [...this.allConnections]) {
        if (connection.id === input.id) this.retire(connection);
      }
      return this.directory();
    }
    if (input.action === "update") {
      if (typeof input.id !== "string" || !/^[-a-f0-9]{36}$/u.test(input.id)) {
        throw new Error("Invalid machine");
      }
      const row = this.store.state.machines.find((candidate) => candidate.id === input.id && candidate.credentialHash !== null);
      if (!row || !this.connections.get(input.id)) throw new Error("Remote machine is offline");
      const current = this.updating.get(input.id);
      if (current && !current.error && Date.now() - current.startedAt < UPDATE_TIMEOUT_MS) {
        return this.directory();
      }
      this.updating.set(input.id, { targetDigest: this.options.digest, startedAt: Date.now(), error: null });
      try {
        await this.triggerRemoteUpdate(input.id);
      } catch (error) {
        this.updating.set(input.id, {
          targetDigest: this.options.digest,
          startedAt: Date.now(),
          error: error instanceof Error ? error.message : "Remote update failed",
        });
        throw error;
      }
      return this.directory();
    }
    throw new Error("Unknown machine action");
  }

  async http(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(PREFIX)) return false;
    try {
      await this.ready();
      if (this.closed || !this.store.available) throw new Error("Machine service unavailable");
      if (req.method === "GET" && url.pathname === `${PREFIX}/install.sh`) {
        if (url.searchParams.get("module") === "update") {
          const token = bearer(req);
          const row = this.store.state.machines.find(
            (candidate) =>
              candidate.id === url.searchParams.get("id")
              && candidate.credentialHash !== null
              && equalHash(token, candidate.credentialHash),
          );
          if (!row) {
            json(res, 403, { error: "update_unavailable" });
            return true;
          }
          const updaterPath = this.options.updater ?? new URL("../../../scripts/personal-machine/update.mjs", import.meta.url);
          const moduleBytes = await readFile(updaterPath);
          res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
          res.end(moduleBytes);
          return true;
        }
        const scriptText = await readFile(this.options.installer, "utf8");
        res.writeHead(200, {
          "content-type": "text/x-shellscript",
          "cache-control": "no-store",
          "x-opencraft-machine-hub": this.store.state.hubId,
        });
        res.end(`export OPENCRAFT_MACHINE_ORIGIN=${quote(this.options.enrollmentOrigin ?? "")}\n${scriptText}`);
        return true;
      }
      if (
        url.searchParams.get("update") === "1"
        && req.method === "GET"
        && (url.pathname === `${PREFIX}/bootstrap` || url.pathname === `${PREFIX}/source.tgz`)
      ) {
        const token = bearer(req);
        const row = this.store.state.machines.find(
          (candidate) =>
            candidate.id === url.searchParams.get("id")
            && candidate.credentialHash !== null
            && equalHash(token, candidate.credentialHash),
        );
        if (!row) {
          json(res, 403, { error: "update_unavailable" });
          return true;
        }
        if (url.pathname === `${PREFIX}/bootstrap`) {
          json(res, 200, {
            schemaVersion: 1,
            origin: this.options.enrollmentOrigin,
            hubId: this.store.state.hubId,
            id: row.id,
            digest: this.options.digest,
          });
          return true;
        }
        this.streamArchive(res);
        return true;
      }
      if (url.pathname === `${PREFIX}/status` && req.method === "GET" && equalSecret(bearer(req), this.options.ownerToken)) {
        json(res, 200, this.directory());
        return true;
      }
      const secret = bearer(req);
      if (url.pathname === `${PREFIX}/bootstrap` && req.method === "GET") {
        const row = this.store.state.machines.find(
          (candidate) =>
            equalHash(secret, candidate.pairHash) && candidate.credentialHash === null && candidate.expiresAt > Date.now(),
        );
        if (!row) {
          json(res, 403, { error: "pairing_unavailable" });
          return true;
        }
        json(res, 200, {
          schemaVersion: 1,
          origin: personalMachineEnrollmentOrigin(this.options.enrollmentOrigin),
          hubId: this.store.state.hubId,
          id: row.id,
          secret,
          digest: this.options.digest,
        });
        return true;
      }
      const id = url.searchParams.get("id");
      const row = this.store.state.machines.find((candidate) => candidate.id === id && equalHash(secret, candidate.pairHash));
      if (!row) {
        json(res, 403, { error: "pairing_unavailable" });
        return true;
      }
      if (url.pathname === `${PREFIX}/source.tgz` && req.method === "GET" && row.credentialHash === null && row.expiresAt > Date.now()) {
        this.streamArchive(res);
        return true;
      }
      if (url.pathname === `${PREFIX}/enroll` && req.method === "POST") {
        const input = await readJsonBody(req);
        await this.store.command("claim", {
          id,
          pairHash: hash(secret),
          credentialHash: input.credentialHash,
          machine: input.machine,
        });
        json(res, 200, { id, hubId: this.store.state.hubId });
        return true;
      }
      json(res, 403, { error: "pairing_unavailable" });
    } catch {
      if (!res.headersSent) json(res, 403, { error: "pairing_unavailable" });
      else res.destroy();
    }
    return true;
  }

  private streamArchive(res: ServerResponse): void {
    res.writeHead(200, { "content-type": "application/gzip", "cache-control": "no-store" });
    this.downloads.add(res);
    const source = createReadStream(this.options.archive);
    source.on("error", () => res.destroy());
    res.once("close", () => {
      this.downloads.delete(res);
      source.destroy();
    });
    source.pipe(res);
  }

  private forgetDetached(connection: MachineConnection): void {
    if (connection.detached && connection.streams.size === 0) {
      this.allConnections.delete(connection);
    }
  }

  private detach(connection: MachineConnection): void {
    connection.detached = true;
    if (this.connections.get(connection.id) === connection) {
      this.connections.delete(connection.id);
    }
    for (const [id, pending] of this.pending) {
      if (pending.connection === connection) {
        this.pending.delete(id);
        pending.reject();
      }
    }
    this.forgetDetached(connection);
  }

  private retire(connection: MachineConnection): void {
    this.detach(connection);
    connection.socket.terminate();
    for (const stream of connection.streams) stream.destroy();
    this.allConnections.delete(connection);
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://localhost");
    const reject = () => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    if (url.pathname === CONTROL_PATH) {
      const token = bearer(req);
      const row = this.store.state?.machines.find(
        (candidate) => candidate.credentialHash !== null && equalHash(token, candidate.credentialHash),
      );
      if (!row || this.closed || !this.store.available || req.headers.origin || req.headers["sec-websocket-protocol"] !== RELAY_PROTOCOL) {
        reject();
        return true;
      }
      this.controlSockets.handleUpgrade(req, socket, head, (ws) => {
        const previous = this.connections.get(row.id);
        if (previous) this.retire(previous);
        const rawVersion = req.headers["x-opencraft-machine-version"];
        const version = typeof rawVersion === "string" && /^(?:[a-f0-9]{64}|legacy)$/u.test(rawVersion) ? rawVersion : null;
        if (version === this.options.digest) this.updating.delete(row.id);
        const connection: MachineConnection = {
          id: row.id,
          socket: ws,
          streams: new Set<Duplex>(),
          version,
          preservesStreams: req.headers[DRAIN_HEADER] === DRAIN_CAPABILITY,
          detached: false,
        };
        this.allConnections.add(connection);
        this.connections.set(row.id, connection);
        const heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 15_000);
        heartbeat.unref();
        let pong = Date.now();
        ws.on("pong", () => {
          pong = Date.now();
        });
        const expire = setInterval(() => {
          if (Date.now() - pong > 45_000) ws.terminate();
        }, 15_000);
        expire.unref();
        ws.on("error", () => {});
        ws.once("close", (code) => {
          clearInterval(heartbeat);
          clearInterval(expire);
          if (connection.preservesStreams && !this.closed && [1006, 1012].includes(code)) {
            this.detach(connection);
          } else {
            this.retire(connection);
          }
        });
      });
      return true;
    }
    if (url.pathname === DATA_PATH) {
      const id = String(req.headers[STREAM_HEADER] ?? "");
      const pending = this.pending.get(id);
      if (!pending || !equalSecret(bearer(req), pending.token) || req.headers.origin || this.closed) {
        reject();
        return true;
      }
      this.pending.delete(id);
      this.dataSockets.handleUpgrade(req, socket, head, (ws) => pending.accept(ws));
      return true;
    }
    const match = /^\/__opencraft_machines\/([a-f0-9-]{36})\/rpc$/u.exec(url.pathname);
    if (!match) return false;
    const ownerCandidate = bearer(req) || (url.searchParams.get("token") ?? "");
    if (this.closed || !this.store.available || !equalSecret(ownerCandidate, this.options.ownerToken)) {
      reject();
      return true;
    }
    const connection = this.connections.get(match[1]!);
    if (!connection || connection.detached || connection.streams.size >= MAX_STREAMS || this.pending.size >= MAX_STREAMS) {
      reject();
      return true;
    }
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const cleanup = () => {
      clearTimeout(timer);
      this.pending.delete(id);
      socket.off("close", cleanup);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject();
    }, 10_000);
    timer.unref();
    socket.once("close", cleanup);
    this.pending.set(id, {
      connection,
      token,
      reject: () => {
        cleanup();
        reject();
      },
      accept: (ws) => {
        cleanup();
        if (socket.destroyed || connection.detached || this.connections.get(match[1]!) !== connection) {
          ws.terminate();
          return;
        }
        const idle = relayIdleDeadline(ws, () => stream.destroy());
        const stream = relayDuplex(ws);
        connection.streams.add(stream);
        stream.once("close", () => {
          idle();
          connection.streams.delete(stream);
          this.forgetDetached(connection);
          ws.terminate();
        });
        const forwardedHeaders = Object.entries(req.headers)
          .filter(([key]) => !["authorization", "cookie", "host", "origin"].includes(key))
          .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(",") : value}`)
          .join("\r\n");
        stream.write(`GET /rpc HTTP/1.1\r\nHost: personal-machine\r\n${forwardedHeaders}\r\n\r\n`);
        if (head.length) stream.write(head);
        bridgeRelayDuplex(stream, socket);
      },
    });
    connection.socket.send(JSON.stringify({ type: "open", id, token }));
    return true;
  }

  close(): Promise<void> {
    return (this.closeOperation ??= (async () => {
      this.closed = true;
      for (const response of this.downloads) response.destroy();
      for (const connection of [...this.allConnections]) this.retire(connection);
      for (const pending of this.pending.values()) pending.reject();
      this.pending.clear();
      this.controlSockets.close();
      this.dataSockets.close();
      await this.store.close();
    })());
  }
}
