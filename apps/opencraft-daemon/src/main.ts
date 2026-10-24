import { nodeObserver } from "../../../packages/observability-contract/node.mjs";
import { unlink } from "node:fs/promises";
import { connect } from "node:net";

import { AppHostServer } from "@opencraft/app-host-server";
import { WebSocketTransport, type AppServerWebSocket } from "@opencraft/appserver-transport-websocket";
import { acquireLocalAgentStorageOwner, openLocalAgentStorage, startLocalAgentHost } from "@opencraft/local-agent-host";
import WebSocket from "ws";

import { readDaemonMachineIdentity } from "./machine-identity.js";
import { MachineIdentityTransport } from "./machine-transport.js";

import { CodexEngineAdapter } from "./codex-engine-adapter.js";
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
  readonly codexExecutable: string;
  readonly codexDataDirectory: string;
  readonly nativeCodexHomeDirectory: string;
  readonly codexCoreEndpoint?: string;
  readonly codexWriterOwnership?: boolean;
  /** Deployment display name; defaults to the OS computer name. */
  readonly machineName?: string;
}) {
  nodeObserver("gateway");
  const machineIdentity = await readDaemonMachineIdentity(options.dataDirectory, options.machineName);
  process.chdir(options.runtimeDirectory);
  const releaseStorageOwner = await acquireLocalAgentStorageOwner(options.dataDirectory);
  let storage: ReturnType<typeof openLocalAgentStorage>;
  try {
    await removeStaleSocket(options.endpoint);
    storage = openLocalAgentStorage({ dataDirectory: options.dataDirectory });
  } catch (error) { await releaseStorageOwner(); throw error; }
  const storageSummary: import("@opencraft/daemon-ipc").DaemonStorageSummary[] = [...storage.summaries];
  const reportStorage = () => {
    for (const { name, outcome } of storage.outcomes) {
      if (outcome.status === "fresh" || outcome.status === "up-to-date") continue;
      console.error(`[opencraft-storage] ${JSON.stringify({ name, status: outcome.status, backupPath: outcome.backupPath, movedAsidePaths: outcome.movedAsidePaths })}`);
    }
  };
  reportStorage();
  let localAgent: Awaited<ReturnType<typeof startLocalAgentHost>> | null = null;
  let localAgentStarting: Promise<Awaited<ReturnType<typeof startLocalAgentHost>>> | null = null;
  const codexAgents = new Set<CodexEngineAdapter>();
  let closing: Promise<void> | null = null;
  const appHost = new AppHostServer({
    logicalClientRouting: true,
    physicalHostLifetime: "server",
    createTransport(hostId) {
      if (hostId !== "local" && hostId !== "local-codex") throw new Error(`OpenCraft Daemon does not own Host ${hostId}`);
      return new MachineIdentityTransport(machineIdentity, hostId === "local" ? "OpenCraft" : "Codex", async () => {
      if (hostId === "local") {
        localAgentStarting ??= startLocalAgentHost({
          storage,
          dshExecutable: options.dshExecutable,
          dshCapabilityPlugin: options.dshCapabilityPlugin,
          runtimeDirectory: options.runtimeDirectory,
          dataDirectory: options.dataDirectory,
          modelStorageDirectory: options.modelStorageDirectory,
          skillsDirectory: options.skillsDirectory,
          machineIdentity,
        }).catch(error => {
          // Host failure closes all supplied handles. Reopen under the same daemon owner
          // before allowing another attempt or advertising ready again.
          try {
            storage = openLocalAgentStorage({ dataDirectory: options.dataDirectory });
            storageSummary.splice(0, storageSummary.length, ...storage.summaries, ...storageSummary.filter(row => row.hostId !== undefined));
            reportStorage();
            localAgentStarting = null;
          } catch {
            void close().catch(() => undefined);
          }
          throw error;
        });
        localAgent = await localAgentStarting;
        return new WebSocketTransport({
          url: localAgent.websocketUrl,
          createSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as AppServerWebSocket,
        });
      }
      if (hostId === "local-codex") {
        const codexAgent = new CodexEngineAdapter({
          onStorageOpened: outcomes => {
            const retained = storageSummary.filter(row => row.hostId !== "local-codex");
            storageSummary.splice(0, storageSummary.length, ...retained, ...outcomes.map(({ name, outcome }) => ({
              hostId: "local-codex", name, status: outcome.status, appliedVersion: outcome.appliedVersion,
              backupPath: outcome.backupPath, movedAside: outcome.movedAsidePaths.length > 0,
            })));
          },
          executable: options.codexExecutable,
          runtimeDirectory: options.runtimeDirectory,
          dataDirectory: options.codexDataDirectory,
          nativeCodexHomeDirectory: options.nativeCodexHomeDirectory,
          coreEndpoint: options.codexCoreEndpoint,
          coreAuthToken: options.authToken,
          writerOwnership: options.codexWriterOwnership,
        });
        codexAgents.add(codexAgent);
        return codexAgent;
      }
      throw new Error(`OpenCraft Daemon does not own Host ${hostId}`);
      });
    },
  });
  let daemonServer: Awaited<ReturnType<typeof startOpenCraftDaemonServer>>;
  const close = (): Promise<void> => {
    if (closing !== null) return closing;
    closing = (async () => {
      await daemonServer.close();
      await appHost.close();
      const agent = localAgent ?? await localAgentStarting?.catch(() => null);
      localAgent = null;
      try { await agent?.close(); } finally {
        try { storage.close(); } finally { await releaseStorageOwner(); }
      }
      await Promise.allSettled([...codexAgents].map(adapter => adapter.close()));
      codexAgents.clear();
    })();
    return closing;
  };
  try {
    daemonServer = await startOpenCraftDaemonServer({
    storage: storageSummary,
    endpoint: options.endpoint,
    authToken: options.authToken,
    appHost,
    onShutdownRequested: () => void close().finally(() => process.exit(0)),
  });
  } catch (error) {
    await appHost.close();
    try { storage.close(); } finally { await releaseStorageOwner(); }
    throw error;
  }
  return { endpoint: daemonServer.endpoint, close };
}
