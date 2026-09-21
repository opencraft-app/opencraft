import { Context, Service } from "@deepseek-ai/cordis";
import {
  ReadableStream,
  type ReadableStreamDefaultController,
  WritableStream,
} from "web-streams-polyfill";
import {
  bindCloudflareSockets,
  type CloudflareSocketPort,
  type InternalSocketOptions,
  type SecureTransport,
  type SocketAddress,
  type SocketOpenInfo,
  type SocketOptions,
  type SocketTelemetry,
} from "../runtime/cloudflare-sockets.ts";
import type {
  ClaimedTcpTransport,
  OutboundTcpPort,
  TcpDrainResult,
  TcpDriverOptions,
  TcpOutboundDriver,
} from "../types/network.ts";

const SECURE_TRANSPORTS = new Set<SecureTransport>(["off", "on", "starttls"]);

type WorkerSocketState = "opening" | "open" | "closed" | "detached";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function parseAddress(address: string | SocketAddress): SocketAddress {
  if (typeof address === "object" && address !== null) {
    const hostname = String(address.hostname ?? "");
    const port = Number(address.port);
    if (hostname && Number.isInteger(port) && port >= 1 && port <= 65535) {
      return { hostname, port };
    }
    throw new TypeError("SocketAddress requires a hostname and a port between 1 and 65535");
  }
  const text = String(address ?? "");
  if (text.startsWith("[")) {
    const match = /^\[([^\]]+)]:(\d+)$/.exec(text);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return parseAddress({ hostname: match[1], port: Number(match[2]) });
    }
  }
  const separator = text.lastIndexOf(":");
  if (separator > 0) {
    return parseAddress({
      hostname: text.slice(0, separator),
      port: Number(text.slice(separator + 1)),
    });
  }
  throw new TypeError("TCP address must be a SocketAddress or host:port string");
}

function normalizeOptions(options: SocketOptions = {}): TcpDriverOptions {
  const secureTransport = options.secureTransport ?? "off";
  if (!SECURE_TRANSPORTS.has(secureTransport)) {
    throw new TypeError(`Unsupported secureTransport: ${JSON.stringify(secureTransport)}`);
  }
  return { secureTransport, allowHalfOpen: options.allowHalfOpen === true };
}

function internalTelemetryOptions(telemetry: SocketTelemetry | null | undefined): Partial<TcpDriverOptions> {
  if (telemetry === null || telemetry === undefined) return {};
  return {
    _hypernodeTraceparent: String(telemetry.traceparent ?? ""),
    _hypernodeCorrelationId: String(telemetry.correlationId ?? ""),
    _hypernodeRequestId: String(telemetry.requestId ?? ""),
  };
}

function byteView(chunk: ArrayBufferView<ArrayBufferLike>): Uint8Array {
  if (!ArrayBuffer.isView(chunk)) {
    throw new TypeError("Socket writable accepts only Uint8Array or ArrayBuffer views");
  }
  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

export class WorkerSocket implements CloudflareSocketPort {
  private readonly service: OutboundTcpService;
  readonly id: string;
  readonly address: SocketAddress;
  readonly options: TcpDriverOptions;
  readonly opened: Promise<SocketOpenInfo>;
  readonly closed: Promise<void>;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<ArrayBufferView<ArrayBufferLike>>;
  state: WorkerSocketState = "opening";
  transportClaimed = false;

  private readonly openedDeferred = deferred<SocketOpenInfo>();
  private readonly closedDeferred = deferred<void>();
  private readController!: ReadableStreamDefaultController<Uint8Array>;

  constructor(
    service: OutboundTcpService,
    id: string,
    address: SocketAddress,
    options: TcpDriverOptions,
    open = true,
  ) {
    this.service = service;
    this.id = id;
    this.address = address;
    this.options = options;
    this.opened = this.openedDeferred.promise;
    this.closed = this.closedDeferred.promise;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.readController = controller;
      },
      cancel: () => this.close(),
    });
    this.writable = new WritableStream<ArrayBufferView<ArrayBufferLike>>({
      write: (chunk) => this.opened.then(() => this.service.write(this, byteView(chunk))),
      close: () => this.opened.then(() => this.service.shutdownWrite(this)),
      abort: () => this.close(),
    });
    if (open) this.service.open(this);
  }

  close(): Promise<void> {
    this.service.close(this);
    return this.closed;
  }

  startTls(): WorkerSocket {
    return this.service.startTls(this);
  }

  accept(result: TcpDrainResult): void {
    if (this.state === "closed" || this.state === "detached") return;
    if (result.dataBytes.length > 0) this.readController.enqueue(new Uint8Array(result.dataBytes));
    if (!result.closed) return;
    if (result.error !== null) this.fail(new Error(result.error));
    else this.finish();
  }

  markOpened(info: SocketOpenInfo): void {
    this.state = "open";
    this.openedDeferred.resolve({
      localAddress: info.localAddress ?? null,
      remoteAddress: info.remoteAddress ?? null,
    });
  }

  fail(error: unknown): void {
    if (this.state === "closed") return;
    const wasOpening = this.state === "opening";
    this.state = "closed";
    if (wasOpening) this.openedDeferred.reject(error);
    try {
      this.readController.error(error);
    } catch {}
    this.closedDeferred.reject(error);
  }

  finish(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    try {
      this.readController.close();
    } catch {}
    this.closedDeferred.resolve();
  }

  detach(): void {
    if (this.state === "closed" || this.state === "detached") return;
    this.state = "detached";
    try {
      this.readController.close();
    } catch {}
    this.closedDeferred.resolve();
  }
}

export class OutboundTcpService extends Service implements OutboundTcpPort {
  driver: TcpOutboundDriver;
  sequence = 0;
  sockets = new Map<string, WorkerSocket>();

  constructor(ctx: Context, driver: TcpOutboundDriver = hostTcpOutboundDriver) {
    super(ctx, "outboundTcp");
    this.driver = driver;
    bindCloudflareSockets(this);
    ctx.effect(() => () => {
      for (const socket of [...this.sockets.values()]) this.close(socket);
    });
  }

  connect(address: string | SocketAddress, options: SocketOptions = {}): WorkerSocket {
    return new WorkerSocket(
      this,
      `outbound-tcp:${++this.sequence}`,
      parseAddress(address),
      normalizeOptions(options),
    );
  }

  connectInternal(address: string | SocketAddress, options: InternalSocketOptions = {}): WorkerSocket {
    const normalizedOptions = {
      ...normalizeOptions(options),
      ...internalTelemetryOptions(options.telemetry),
    };
    return new WorkerSocket(
      this,
      `outbound-tcp:${++this.sequence}`,
      parseAddress(address),
      normalizedOptions,
    );
  }

  open(socket: WorkerSocket): void {
    this.sockets.set(socket.id, socket);
    try {
      socket.markOpened(this.driver.open(socket.id, socket.address, socket.options));
    } catch (error) {
      this.sockets.delete(socket.id);
      socket.fail(error);
    }
  }

  write(socket: WorkerSocket, bytes: Uint8Array): void {
    this.requireActive(socket);
    const written = this.driver.write(socket.id, bytes);
    if (written !== bytes.byteLength) {
      throw new Error(`short TCP write: ${written}/${bytes.byteLength}`);
    }
  }

  shutdownWrite(socket: WorkerSocket): void {
    this.requireActive(socket);
    this.driver.shutdownWrite(socket.id);
  }

  drain(socket: WorkerSocket): TcpDrainResult {
    if (!this.sockets.has(socket.id)) {
      return { dataBytes: new Uint8Array(0), closed: true, error: null };
    }
    const result = this.driver.drain(socket.id);
    socket.accept(result);
    if (result.closed) this.sockets.delete(socket.id);
    return result;
  }

  tick(): void {
    for (const socket of [...this.sockets.values()]) {
      if (!socket.transportClaimed) this.drain(socket);
    }
  }

  claimTransport(socketPort: CloudflareSocketPort): ClaimedTcpTransport {
    if (!(socketPort instanceof WorkerSocket)) {
      throw new TypeError("TCP socket does not belong to OutboundTcpService");
    }
    const socket = socketPort;
    this.requireActive(socket);
    if (socket.readable.locked || socket.writable.locked || socket.transportClaimed) {
      throw new TypeError("TCP socket is already locked to a consumer");
    }
    socket.transportClaimed = true;
    return {
      write: (bytes) => this.write(socket, byteView(bytes)),
      closeWrite: () => this.shutdownWrite(socket),
      drain: () => {
        if (!this.sockets.has(socket.id)) {
          return { dataBytes: new Uint8Array(0), closed: true, error: null };
        }
        const result = this.driver.drain(socket.id);
        if (result.closed) this.sockets.delete(socket.id);
        return result;
      },
      close: () => this.close(socket),
    };
  }

  close(socket: WorkerSocket): void {
    if (this.sockets.delete(socket.id)) this.driver.close(socket.id);
    socket.finish();
  }

  startTls(socket: WorkerSocket): WorkerSocket {
    if (socket.options.secureTransport !== "starttls" || !this.sockets.has(socket.id)) {
      throw new TypeError("startTls() requires a live socket opened with secureTransport: 'starttls'");
    }
    const replacement = new WorkerSocket(
      this,
      socket.id,
      socket.address,
      { ...socket.options, secureTransport: "on" },
      false,
    );
    try {
      const info = this.driver.startTls(socket.id);
      socket.detach();
      this.sockets.set(socket.id, replacement);
      replacement.markOpened(info);
    } catch (error) {
      socket.fail(error);
      replacement.fail(error);
      this.sockets.delete(socket.id);
    }
    return replacement;
  }

  private requireActive(socket: WorkerSocket): void {
    if (!this.sockets.has(socket.id) || socket.state !== "open") {
      throw new Error("TCP socket is not writable");
    }
  }
}
