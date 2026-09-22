import { unlink } from "node:fs/promises";
import { connect } from "node:net";

import { AppHostServer } from "@opencraft/app-host-server";
import { WebSocketTransport, type AppServerWebSocket } from "@opencraft/appserver-transport-websocket";
import { startLocalAgentHost } from "@opencraft/local-agent-host";
import WebSocket from "ws";

import { startOpenCraftDaemonServer } from "./server.js";

function isNamedPipe(endpoint: string): boolean {
  return endpoint.startsWith("\\\\.\\pipe\\");
}

async function removeStaleSocket(endpoint: string): Promise<void> {
  if (isNamedPipe(endpoint)) return;
  const active = await new Promise<boolean>((resolveActive) => {
    const socket = connect(endpoint);
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      resolveActive(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    timeout = setTimeout(() => done(false), 250);
    timeout.unref();
  });
  if (active) throw new Error(`OpenCraft Daemon is already listening at ${endpoint}`);
  await unlink(endpoint).catch(() => undefined);
}

export async function startOpenCraftDaemon(options: {
  readonly endpoint: string;
  readonly runtimeDirectory: string;
  readonly authToken: string;
  readonly dshExecutable: string;
  readonly dshCapabilityPlugin?: string;
  readonly dataDirectory: string;
  readonly modelStorageDirectory?: string;
  readonly skillsDirectory?: string;
}) {
  process.chdir(options.runtimeDirectory);
  await removeStaleSocket(options.endpoint);
  let localAgent: Awaited<ReturnType<typeof startLocalAgentHost>> | null = null;
  let closing: Promise<void> | null = null;
  const appHost = new AppHostServer({
    logicalClientRouting: true,
    async createTransport(hostId) {
      if (hostId !== "local") throw new Error(`OpenCraft Daemon does not own Host ${hostId}`);
      localAgent ??= await startLocalAgentHost({
        dshExecutable: options.dshExecutable,
        dshCapabilityPlugin: options.dshCapabilityPlugin,
        runtimeDirectory: options.runtimeDirectory,
        dataDirectory: options.dataDirectory,
        modelStorageDirectory: options.modelStorageDirectory,
        skillsDirectory: options.skillsDirectory,
      });
      return new WebSocketTransport({
        url: localAgent.websocketUrl,
        createSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as AppServerWebSocket,
      });
    },
  });
  let daemonServer: Awaited<ReturnType<typeof startOpenCraftDaemonServer>>;
  const close = (): Promise<void> => {
    if (closing !== null) return closing;
    closing = (async () => {
      await daemonServer.close();
      await appHost.close();
      const agent = localAgent;
      localAgent = null;
      await agent?.close();
    })();
    return closing;
  };
  daemonServer = await startOpenCraftDaemonServer({
    endpoint: options.endpoint,
    authToken: options.authToken,
    appHost,
    onShutdownRequested: () => void close().finally(() => process.exit(0)),
  });
  return { endpoint: daemonServer.endpoint, close };
}
