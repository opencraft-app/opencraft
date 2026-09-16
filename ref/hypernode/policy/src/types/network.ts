import type {
  CloudflareSocketPort,
  InternalSocketOptions,
  SecureTransport,
  SocketAddress,
  SocketOpenInfo,
  SocketOptions,
} from "../runtime/cloudflare-sockets.ts";

export interface TcpDrainResult {
  dataBytes: Uint8Array;
  closed: boolean;
  error: string | null;
}

export interface TcpDriverOptions {
  secureTransport: SecureTransport;
  allowHalfOpen: boolean;
  _hypernodeTraceparent?: string;
  _hypernodeCorrelationId?: string;
  _hypernodeRequestId?: string;
}

export interface TcpOutboundDriver {
  open(id: string, address: SocketAddress, options: TcpDriverOptions): SocketOpenInfo;
  write(id: string, bytes: Uint8Array): number;
  shutdownWrite(id: string): void;
  drain(id: string): TcpDrainResult;
  startTls(id: string): SocketOpenInfo;
  close(id: string): void;
}

export interface ClaimedTcpTransport {
  write(bytes: Uint8Array): void;
  closeWrite(): void;
  drain(): TcpDrainResult;
  close(): void;
}

export interface OutboundTcpPort {
  connect(address: string | SocketAddress, options?: SocketOptions): CloudflareSocketPort;
  connectInternal?(
    address: string | SocketAddress,
    options?: InternalSocketOptions,
  ): CloudflareSocketPort;
  claimTransport(socket: CloudflareSocketPort): ClaimedTcpTransport;
}

export interface HttpClientRequestOptions {
  url: string;
  method?: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  telemetry?: InternalSocketOptions["telemetry"];
}

export interface HttpClientDrainResult {
  status: number;
  headers: Record<string, string>;
  dataBytes: number[];
  closed: boolean;
  error: string | null;
}

export interface HttpClientPort {
  open(id: string, options: HttpClientRequestOptions): void;
  drain(id: string): HttpClientDrainResult;
  close(id: string): void;
}

export interface PortForwardConnection {
  identity?: { id: string } | null;
  metadata: { connectionId: string };
}

export interface PortForwardChannel {
  localId: number;
}

export interface DirectTcpTarget {
  hostname?: unknown;
  port?: unknown;
}

export interface PortForwardSocket {
  readonly id: string;
  readonly connection: PortForwardConnection;
  readonly channel: PortForwardChannel;
  readonly hostname: string;
  readonly port: number;
  readonly workerSocket: CloudflareSocketPort;
  readonly transport: ClaimedTcpTransport;
  closed: boolean;
  error: string | null;
}

export interface PortForwardPort {
  open(
    connection: PortForwardConnection,
    channel: PortForwardChannel,
    target: DirectTcpTarget,
  ): PortForwardSocket;
  write(socket: PortForwardSocket, data: Uint8Array): void;
  closeWrite(socket: PortForwardSocket): void;
  drain(socket: PortForwardSocket): TcpDrainResult;
  close(socket: PortForwardSocket | null | undefined): void;
}
