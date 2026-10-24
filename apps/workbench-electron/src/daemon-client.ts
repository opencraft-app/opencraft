import { spawn, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";

import {
  DaemonJsonLineChannel,
  OPENCRAFT_DAEMON_BUILD_ID,
  OPENCRAFT_DAEMON_PROTOCOL_VERSION,
  type DaemonServerMessage,
  type DaemonStorageSummary,
} from "@opencraft/daemon-ipc";

export interface OpenCraftDaemonAppHostConnection {
  readonly storage?: readonly DaemonStorageSummary[];
  send(payload: unknown): void;
  subscribeMessage(listener: (payload: unknown) => void): () => void;
  subscribeClose(listener: (error: Error | null) => void): () => void;
  close(): void;
}

export interface OpenCraftDaemonClientOptions {
  readonly endpoint: string;
  readonly tokenPath: string;
  /** Server deployments supply an existing shared token; never change its permissions or identity. */
  readonly tokenMode?: "existing";
  readonly runtimeDirectory: string;
  readonly daemonEntry: string;
  readonly dshExecutable: string;
  readonly dshCapabilityPlugin?: string;
  readonly dataDirectory: string;
  readonly modelStorageDirectory?: string;
  readonly skillsDirectory?: string;
  readonly codexExecutable: string;
  readonly codexDataDirectory: string;
  readonly nativeCodexHomeDirectory: string;
  readonly codexCoreEndpoint?: string;
  readonly executable: string;
  /** Deployment display name for the daemon machine; desktop keeps the OS name. */
  readonly machineName?: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isDaemonEndpointUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EPIPE";
}

function loadOrCreateToken(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) {
      if (process.platform !== "win32") chmodSync(path, 0o600);
      return existing;
    }
  } catch {
    // First launch owns token creation.
  }
  const token = randomBytes(48).toString("base64url");
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

export function daemonLaunchSpec(
  options: OpenCraftDaemonClientOptions,
  authToken: string,
): { executable: string; args: string[]; options: SpawnOptions } {
  return {
    executable: options.executable,
    args: [
      options.daemonEntry,
      "--endpoint", options.endpoint,
      "--runtime-directory", options.runtimeDirectory,
      "--dsh-executable", options.dshExecutable,
      ...(options.dshCapabilityPlugin ? ["--dsh-capability-plugin", options.dshCapabilityPlugin] : []),
      "--data-directory", options.dataDirectory,
      ...(options.modelStorageDirectory ? ["--model-storage-directory", options.modelStorageDirectory] : []),
      ...(options.skillsDirectory ? ["--skills-directory", options.skillsDirectory] : []),
      "--codex-executable", options.codexExecutable,
      "--codex-data-directory", options.codexDataDirectory,
      "--native-codex-home-directory", options.nativeCodexHomeDirectory,
      ...(options.codexCoreEndpoint ? ["--codex-core-endpoint", options.codexCoreEndpoint] : []),
      ...(options.machineName ? ["--machine-name", options.machineName] : []),
    ],
    options: {
      cwd: options.runtimeDirectory,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        OPENCRAFT_DAEMON_AUTH_TOKEN: authToken,
      },
    },
  };
}

function parseStorage(value: unknown): readonly DaemonStorageSummary[] | undefined {
  if (value === undefined) return undefined;
  const statuses = new Set(["fresh", "up-to-date", "migrated", "adopted", "moved-aside"]);
  if (!Array.isArray(value)) throw new Error("Invalid daemon storage summary");
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || typeof raw.name !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(raw.name) || !statuses.has(raw.status)
      || !Number.isSafeInteger(raw.appliedVersion) || raw.appliedVersion < 1 || typeof raw.movedAside !== "boolean"
      || (raw.hostId !== undefined && (typeof raw.hostId !== "string" || !raw.hostId))
      || (raw.backupPath !== undefined && typeof raw.backupPath !== "string")) throw new Error("Invalid daemon storage summary");
    return { name: raw.name, status: raw.status, appliedVersion: raw.appliedVersion,
      ...(raw.hostId === undefined ? {} : { hostId: raw.hostId }),
      movedAside: raw.movedAside, ...(raw.backupPath === undefined ? {} : { backupPath: raw.backupPath }) };
  });
}

class ConnectedDaemonChannel {
  constructor(readonly channel: DaemonJsonLineChannel, readonly storage?: readonly DaemonStorageSummary[]) {}

  close(): void { this.channel.close(); }
}

export class OpenCraftDaemonClientManager {
  readonly endpoint: string;
  private readonly authToken: string;
  private ensureOperation: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(private readonly options: OpenCraftDaemonClientOptions) {
    this.endpoint = options.endpoint;
    if (options.tokenMode === "existing") {
      const token = readFileSync(options.tokenPath, "utf8").trim();
      if (token.length < 32) throw new Error("Invalid existing daemon token");
      this.authToken = token;
    } else this.authToken = loadOrCreateToken(options.tokenPath);
  }

  async connectAppHost(connectionId: string): Promise<OpenCraftDaemonAppHostConnection> {
    if (this.shuttingDown) throw new Error("OpenCraft Daemon is shutting down");
    await this.ensureRunning();
    if (this.shuttingDown) throw new Error("OpenCraft Daemon is shutting down");
    const connected = await this.open("app-host", connectionId);
    const messageListeners = new Set<(payload: unknown) => void>();
    const closeListeners = new Set<(error: Error | null) => void>();
    const unsubscribeMessage = connected.channel.subscribeMessage((value) => {
      const message = value as DaemonServerMessage;
      if (message?.type === "app-host/message") {
        for (const listener of messageListeners) listener(message.payload);
      }
    });
    const unsubscribeClose = connected.channel.subscribeClose((error) => {
      for (const listener of closeListeners) listener(error);
      messageListeners.clear();
      closeListeners.clear();
    });
    let closed = false;
    return {
      storage: connected.storage,
      send: (payload) => connected.channel.send({ type: "app-host/message", payload }),
      subscribeMessage(listener) {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
      subscribeClose(listener) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      close() {
        if (closed) return;
        closed = true;
        unsubscribeMessage();
        unsubscribeClose();
        messageListeners.clear();
        closeListeners.clear();
        connected.close();
      },
    };
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await this.ensureOperation?.catch(() => undefined);
    try {
      const connected = await this.open("control", `shutdown:${process.pid}`);
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 2_000);
        const finish = () => {
          clearTimeout(timeout);
          resolve();
        };
        connected.channel.subscribeMessage((value) => {
          if ((value as DaemonServerMessage)?.type === "daemon/shutting-down") finish();
        });
        connected.channel.subscribeClose(finish);
        connected.channel.send({ type: "daemon/shutdown" });
      });
      connected.close();
    } catch {
      // No live daemon is already the desired shutdown state.
    }
  }

  private ensureRunning(): Promise<void> {
    if (this.ensureOperation !== null) return this.ensureOperation;
    const operation = this.probeOrStart().finally(() => {
      if (this.ensureOperation === operation) this.ensureOperation = null;
    });
    this.ensureOperation = operation;
    return operation;
  }

  private async probeOrStart(): Promise<void> {
    try {
      const existing = await this.open("control", `probe:${process.pid}`);
      existing.close();
      return;
    } catch (error) {
      if (!isDaemonEndpointUnavailable(error)) {
        throw new Error(
          `A process owns the OpenCraft Daemon endpoint but cannot be adopted: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    if (this.shuttingDown) throw new Error("OpenCraft Daemon is shutting down");
    this.spawnDaemon();
    const deadline = Date.now() + 12_000;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      if (this.shuttingDown) throw new Error("OpenCraft Daemon is shutting down");
      try {
        const connected = await this.open("control", `probe:${process.pid}`);
        connected.close();
        return;
      } catch (error) {
        if (!isDaemonEndpointUnavailable(error)) {
          throw new Error(
            `The OpenCraft Daemon endpoint became reachable but failed its handshake: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        lastError = error;
        await delay(100);
      }
    }
    throw new Error(
      `OpenCraft Daemon did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private spawnDaemon(): void {
    const launch = daemonLaunchSpec(this.options, this.authToken);
    const child = spawn(launch.executable, launch.args, launch.options);
    child.unref();
  }

  private open(role: "app-host" | "control", connectionId: string): Promise<ConnectedDaemonChannel> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.endpoint);
      const channel = new DaemonJsonLineChannel(socket);
      let settled = false;
      const timeout = setTimeout(() => fail(new Error("Timed out connecting to OpenCraft Daemon")), 2_500);
      const cleanup = () => {
        clearTimeout(timeout);
        unsubscribeMessage();
        unsubscribeClose();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        channel.destroy();
        reject(error);
      };
      const unsubscribeMessage = channel.subscribeMessage((value) => {
        const message = value as DaemonServerMessage;
        if (message?.type === "daemon/fatal") {
          fail(new Error(`${message.code}: ${message.message}`));
          return;
        }
        if (message?.type !== "daemon/ready") return;
        if (
          message.protocolVersion !== OPENCRAFT_DAEMON_PROTOCOL_VERSION
          || message.buildId !== OPENCRAFT_DAEMON_BUILD_ID
        ) {
          fail(new Error("OpenCraft Daemon protocol/build mismatch"));
          return;
        }
        let storage: readonly DaemonStorageSummary[] | undefined;
        try { storage = parseStorage(message.storageOutcomes ?? message.storage); }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
        if (settled) return;
        settled = true;
        cleanup();
        resolve(new ConnectedDaemonChannel(channel, storage));
      });
      const unsubscribeClose = channel.subscribeClose((error) => {
        fail(error ?? new Error("OpenCraft Daemon closed during handshake"));
      });
      socket.once("connect", () => {
        channel.send({
          type: "daemon/hello",
          protocolVersion: OPENCRAFT_DAEMON_PROTOCOL_VERSION,
          buildId: OPENCRAFT_DAEMON_BUILD_ID,
          authToken: this.authToken,
          connectionId,
          role,
        });
      });
    });
  }
}
