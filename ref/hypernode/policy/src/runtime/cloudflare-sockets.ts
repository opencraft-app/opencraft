import type { ReadableStream, WritableStream } from "web-streams-polyfill";

export interface SocketAddress {
  hostname: string;
  port: number;
}

export type SecureTransport = "off" | "on" | "starttls";

export interface SocketOptions {
  secureTransport?: SecureTransport;
  allowHalfOpen?: boolean;
}

export interface SocketTelemetry {
  traceparent?: string;
  correlationId?: string;
  requestId?: string;
}

export interface InternalSocketOptions extends SocketOptions {
  telemetry?: SocketTelemetry | null;
}

export interface SocketOpenInfo {
  localAddress: string | null;
  remoteAddress: string | null;
}

export interface CloudflareSocketPort {
  readonly id: string;
  readonly opened: Promise<SocketOpenInfo>;
  readonly closed: Promise<void>;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<ArrayBufferView<ArrayBufferLike>>;
  close(): Promise<void>;
  startTls(): CloudflareSocketPort;
}

interface OutboundTcpConnectPort {
  connect(address: string | SocketAddress, options?: SocketOptions): CloudflareSocketPort;
}

let outboundTcpService: OutboundTcpConnectPort | null = null;

export function bindCloudflareSockets(service: OutboundTcpConnectPort): void {
  outboundTcpService = service;
}

// Public compatibility entry point. The production bundle aliases the
// `cloudflare:sockets` module specifier to this module.
export function connect(
  address: string | SocketAddress,
  options?: SocketOptions,
): CloudflareSocketPort {
  if (outboundTcpService === null) {
    throw new Error("OutboundTcpService is not available");
  }
  return outboundTcpService.connect(address, options);
}
