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
} from "@opencraft/daemon-ipc";

export interface OpenCraftDaemonAppHostConnection {
  send(payload: unknown): void;
  subscribeMessage(listener: (payload: unknown) => void): () => void;
  subscribeClose(listener: (error: Error | null) => void): () => void;
  close(): void;
}

export interface OpenCraftDaemonClientOptions {
  readonly endpoint: string;
  readonly tokenPath: string;
  readonly runtimeDirectory: string;
  readonly daemonEntry: string;
  readonly dshExecutable: string;
  readonly dshCapabilityPlugin?: string;
  readonly dataDirectory: string;
  readonly modelStorageDirectory?: string;
  readonly skillsDirectory?: string;
  readonly executable: string;
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

class ConnectedDaemonChannel {
  constructor(readonly channel: DaemonJsonLineChannel) {}

  close(): void { this.channel.close(); }
}

export class OpenCraftDaemonClientManager {
  readonly endpoint: string;
  private readonly authToken: string;
  private ensureOperation: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(private readonly options: OpenCraftDaemonClientOptions) {
    this.endpoint = options.endpoint;
    this.authToken = loadOrCreateToken(options.tokenPath);
  }

  async connectAppHost(connectionId: string): Promise<OpenCraftDaemonAppHostConnection> {
    if (this.shuttingDown) throw new Error("OpenCraft Daemon is shutting down");
    await this.ensureRunning();
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
    this.spawnDaemon();
    const deadline = Date.now() + 12_000;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
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
        if (settled) return;
        settled = true;
        cleanup();
        resolve(new ConnectedDaemonChannel(channel));
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
