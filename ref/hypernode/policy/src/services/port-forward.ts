import { Service, type Inject } from "@deepseek-ai/cordis";
import { connect } from "../runtime/cloudflare-sockets.ts";
import { errorMessage } from "../types/domain.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  DirectTcpTarget,
  PortForwardChannel,
  PortForwardConnection,
  PortForwardPort,
  PortForwardSocket,
  TcpDrainResult,
} from "../types/network.ts";

const MAX_FORWARD_CHUNK = 4 * 1024 * 1024;

type Dependencies = "outboundTcp";

export class PortForwardService extends Service implements PortForwardPort {
  static inject = ["outboundTcp"] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  private sequence = 0;
  private readonly sockets = new Map<string, PortForwardSocket>();

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "portForward");
  }

  open(
    connection: PortForwardConnection,
    channel: PortForwardChannel,
    target: DirectTcpTarget,
  ): PortForwardSocket {
    if (!connection.identity?.id) {
      throw new Error("SSH port forwarding requires an authenticated identity");
    }
    const hostname = String(target.hostname ?? "");
    const port = Number(target.port);
    if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("invalid direct-tcpip target");
    }
    const id = `vssh-forward:${connection.metadata.connectionId}:${channel.localId}:${++this.sequence}`;
    const workerSocket = connect(
      { hostname, port },
      { secureTransport: "off", allowHalfOpen: true },
    );
    const transport = this.ctx.outboundTcp.claimTransport(workerSocket);
    const socket: PortForwardSocket = {
      id,
      connection,
      channel,
      hostname,
      port,
      workerSocket,
      transport,
      closed: false,
      error: null,
    };
    workerSocket.opened.catch((error: unknown) => {
      socket.error = errorMessage(error);
    });
    workerSocket.closed.catch((error: unknown) => {
      socket.error = errorMessage(error);
    });
    this.sockets.set(id, socket);
    return socket;
  }

  write(socket: PortForwardSocket, data: Uint8Array): void {
    if (socket.closed) return;
    if (data.length > MAX_FORWARD_CHUNK) {
      throw new Error("forwarded TCP chunk exceeds limit");
    }
    try {
      socket.transport.write(data);
    } catch (error) {
      socket.error = errorMessage(error);
    }
  }

  closeWrite(socket: PortForwardSocket): void {
    if (socket.closed) return;
    try {
      socket.transport.closeWrite();
    } catch (error) {
      socket.error = errorMessage(error);
    }
  }

  drain(socket: PortForwardSocket): TcpDrainResult {
    if (socket.closed) {
      return { dataBytes: new Uint8Array(0), closed: true, error: socket.error };
    }
    if (socket.error !== null) {
      return { dataBytes: new Uint8Array(0), closed: true, error: socket.error };
    }
    return socket.transport.drain();
  }

  close(socket: PortForwardSocket | null | undefined): void {
    if (socket === null || socket === undefined || socket.closed) return;
    socket.closed = true;
    this.sockets.delete(socket.id);
    socket.transport.close();
  }
}
