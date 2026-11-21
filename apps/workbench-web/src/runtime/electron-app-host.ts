import { MessagePortAppHostClient } from "@opencraft/app-host-client";
import type { DuplexTransport } from "@opencraft/appserver-client/transport";
import { retryDelayMs, wasEstablished } from "@opencraft/workbench-runtime/retry-schedule";
import { RenewableAppHostTransport } from "./renewable-app-host-transport";
import {
  APP_HOST_PROTOCOL_VERSION,
  CONNECT_APP_HOST_MESSAGE,
  type ConnectAppHostMessage,
} from "@opencraft/app-host-protocol";

function rendererId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `renderer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Opens the one application-scoped bridge to Electron's physical Host owner.
 * Individual Host runtimes multiplex over this port and never see Electron IPC.
 */
export function connectElectronAppHost(): MessagePortAppHostClient {
  const channel = new MessageChannel();
  const id = rendererId();
  const message: ConnectAppHostMessage = {
    type: CONNECT_APP_HOST_MESSAGE,
    protocolVersion: APP_HOST_PROTOCOL_VERSION,
    rendererId: id,
  };
  window.postMessage(message, window.location.origin, [channel.port2]);
  return new MessagePortAppHostClient(channel.port1, id);
}

/**
 * The Electron App Host as the Workbench consumes it: one durable transport per
 * Host whose physical port is replaced when the daemon goes away.
 *
 * A port is terminated when Main reports that its daemon connection closed (or
 * the daemon was not ready). Consumers then reconnect through this shared
 * schedule and wait in `connecting`, instead of failing at once and retrying in
 * a tight loop against a port that can never reopen.
 */
export function connectRecoveringElectronAppHost(options: {
  readonly connect?: () => MessagePortAppHostClient;
  /** Explicit retry schedule; defaults use exponential backoff with jitter. */
  readonly retryDelaysMs?: readonly number[];
} = {}): { createTransport(hostId: string): DuplexTransport; close(): void } {
  const connect = options.connect ?? connectElectronAppHost;
  const transports = new Set<RenewableAppHostTransport>();
  let current: MessagePortAppHostClient | null = null;
  const ready = new WeakSet<MessagePortAppHostClient>();
  let disposed = false;
  let failures = 0;
  let retryAt = 0;
  let readyAt: number | null = null;
  const failed = () => {
    // Losing an established port restarts the schedule; repeated refusals escalate.
    if (wasEstablished(readyAt, Date.now())) failures = 0;
    readyAt = null;
    retryAt = Date.now() + retryDelayMs(failures++, { schedule: options.retryDelaysMs });
  };
  const acquire = async (assertCurrent: () => void, waiting: (delayMs: number) => void): Promise<MessagePortAppHostClient> => {
    if (current?.isClosed) { current = null; failed(); }
    while (current === null && Date.now() < retryAt) {
      const delayMs = retryAt - Date.now();
      waiting(delayMs);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      assertCurrent();
      if (disposed) throw new Error("App Host connection is closed");
    }
    if (disposed) throw new Error("App Host connection is closed");
    if (current === null) {
      const client = connect();
      current = client;
      void client.waitUntilReady().then(
        () => { ready.add(client); if (current === client) readyAt = Date.now(); },
        () => { if (current === client) { current = null; failed(); } },
      );
    }
    return current;
  };
  return {
    createTransport(hostId) {
      if (disposed) throw new Error("App Host connection is closed");
      const transport: RenewableAppHostTransport = new RenewableAppHostTransport(async (assertCurrent, waiting) => {
        const owner = await acquire(assertCurrent, waiting);
        return {
          transport: owner.createTransport(hostId),
          attemptId: `${hostId}:${Date.now()}`,
          diagnostic: () => undefined,
          subscribeStage(listener) {
            // A ready port reports its stage synchronously so a late notification
            // can never follow, and overwrite, the channel's own open status.
            if (ready.has(owner)) { listener("host"); return () => undefined; }
            let live = true;
            listener("bridge");
            void owner.waitUntilReady().then(() => { if (live) listener("host"); }, () => undefined);
            return () => { live = false; };
          },
        };
      }, () => { transports.delete(transport); });
      transports.add(transport);
      return transport;
    },
    close() {
      if (disposed) return;
      disposed = true;
      for (const transport of [...transports]) void transport.close().catch(() => undefined);
      current?.close();
      current = null;
    },
  };
}
