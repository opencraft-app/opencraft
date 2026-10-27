import { MessagePortAppHostClient } from "@opencraft/app-host-client";
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
