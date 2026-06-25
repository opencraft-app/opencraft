import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import type { Attributes } from "@opentelemetry/api";
import type { VelaLocalSpan, VelaLocalTracer } from "../../../../packages/vela-observability-client/src";

import { bundledVeladDatabaseUrl, bundledVeladPath, desktopRuntimeEnv, type RuntimePathHost } from "./velad-runtime-paths";
import {
  infoFromReadyEvent,
  parseVeladReadyLine,
  requestRuntimeShutdown,
  type VeladRuntimeInfo,
  type VeladRuntimeSnapshot,
} from "./velad-runtime-state";
import type { RuntimeLogger } from "./velad-runtime-logs";

export interface VeladRuntimeManagerOptions {
  host: RuntimePathHost;
  resourcesPath: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  resolveBundledVeladPath?: (resourcesPath: string) => string | null;
  logger: RuntimeLogger;
  readyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  requestTimeoutMs?: number;
  observability?: VelaLocalTracer;
}

type SpawnedVeladProcess = ChildProcessWithoutNullStreams & {
  stdout: Readable;
  stderr: Readable;
};

export class VeladRuntimeManager {
  private readonly options: Required<Omit<VeladRuntimeManagerOptions, "env" | "observability">> & {
    env: NodeJS.ProcessEnv;
    observability?: VelaLocalTracer;
  };
  private child: SpawnedVeladProcess | null = null;
  private startPromise: Promise<VeladRuntimeInfo> | null = null;
  private snapshot: VeladRuntimeSnapshot = { status: "idle" };
  private managementToken: string | null = null;

  constructor(options: VeladRuntimeManagerOptions) {
    this.options = {
      env: options.env ?? process.env,
      fetchImpl: resolveRuntimeFetch(options.fetchImpl),
      spawnImpl: options.spawnImpl ?? spawn,
      resolveBundledVeladPath: options.resolveBundledVeladPath ?? bundledVeladPath,
      readyTimeoutMs: options.readyTimeoutMs ?? 15_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 2_000,
      host: options.host,
      resourcesPath: options.resourcesPath,
      logger: options.logger,
      observability: options.observability,
    };
  }

  getSnapshot() {
    return this.snapshot;
  }

  resetStart() {
    this.startPromise = null;
    if (this.snapshot.status === "failed") {
      this.snapshot = { status: "idle" };
    }
  }

  ensureReady() {
    if (!this.startPromise) {
      this.startPromise = this.start().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.snapshot = { status: "failed", error: message };
        throw err;
      });
    }
    return this.startPromise;
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    return this.withSpan(
      "electron.velad.stop",
      {
        "velad.runtime.mode": "local",
        "velad.listen_addr": this.snapshot.info?.listenAddr ?? "",
      },
      async (span) => {
        this.snapshot = { ...this.snapshot, status: "stopping" };

        const info = this.snapshot.info;
        const token = this.managementToken;
        let exitAfterShutdown: Promise<void> | null = null;
        if (info && token) {
          exitAfterShutdown = waitForChildExit(child, this.options.shutdownTimeoutMs);
          try {
            await requestRuntimeShutdown(
              info.apiBaseUrl,
              token,
              this.options.fetchImpl,
              this.options.requestTimeoutMs,
            );
          } catch (err) {
            exitAfterShutdown.catch(() => undefined);
            exitAfterShutdown = null;
            this.log("[host]", `velad runtime shutdown request failed: ${errorMessage(err)}`);
            span?.setAttribute("velad.shutdown_request_failed", true);
            span?.setAttribute("velad.shutdown_request_error", errorMessage(err));
          }
        }

        try {
          await (exitAfterShutdown ?? waitForChildExit(child, this.options.shutdownTimeoutMs));
          this.finishStopped();
          return;
        } catch {
          this.log("[host]", "velad did not exit after runtime shutdown; calling child.kill()");
          span?.setAttribute("velad.stop_fallback", "child.kill");
        }

        const exitAfterKill = waitForChildExit(child, this.options.shutdownTimeoutMs);
        const killSent = child.kill();
        span?.setAttribute("velad.kill_sent", killSent);
        this.log("[host]", `velad child.kill() returned ${killSent}`);
        try {
          await exitAfterKill;
          this.finishStopped();
        } catch {
          const error = "failed_to_stop";
          this.snapshot = { status: "failed", error };
          this.log("[host]", error);
          throw new Error(error);
        }
      }
    );
  }

  private async start() {
    const binaryPath =
      this.options.env.VELA_DESKTOP_VELAD_PATH?.trim() ||
      this.options.resolveBundledVeladPath(this.options.resourcesPath);
    if (!binaryPath) {
      throw new Error("local velad binary not found");
    }
    return this.withSpan(
      "electron.velad.start",
      {
        "velad.runtime.mode": "local",
        "velad.external": false,
      },
      async (span) => {
        const info = await this.startLocalRuntime(binaryPath);
        span?.setAttribute("velad.listen_addr", info.listenAddr);
        span?.setAttribute("velad.api_base_url", info.apiBaseUrl);
        span?.setAttribute("velad.otel_base_url", info.otelBaseUrl);
        return info;
      }
    );
  }

  private startLocalRuntime(binaryPath: string) {
    this.snapshot = { status: "starting" };
    this.managementToken = randomBytes(32).toString("hex");
    const databaseUrl = bundledVeladDatabaseUrl(
      this.options.host,
      this.options.env.VELAD_DATABASE_URL,
    );
    this.log("[host]", `starting local velad at ${binaryPath}`);
    this.log("[host]", `using local velad database ${databaseUrl}`);
    const child = this.options.spawnImpl(
      binaryPath,
      [
        "--listen",
        "127.0.0.1:0",
        "--database-url",
        databaseUrl,
        "--management-token",
        this.managementToken,
      ],
      {
        env: {
          ...desktopRuntimeEnv(this.options.host, this.options.env),
          RUST_LOG: this.options.env.RUST_LOG ?? "warn",
        },
        stdio: "pipe",
      },
    ) as SpawnedVeladProcess;
    this.child = child;
    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trimEnd();
      console.error(`[velad] ${message}`);
      this.log("[velad:stderr]", message);
    });
    child.on("exit", (code, signal) => {
      this.log("[host]", `velad exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.child = null;
      if (this.snapshot.status === "stopping") {
        this.snapshot = { status: "stopped" };
      }
    });
    return this.waitForReadyLine(child.stdout);
  }

  private waitForReadyLine(stdout: Readable) {
    return new Promise<VeladRuntimeInfo>((resolve, reject) => {
      let buffer = "";
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("velad ready event timed out"));
      }, this.options.readyTimeoutMs);
      const onData = (chunk: Buffer | string) => {
        buffer += String(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.log("[velad:stdout]", trimmed);
          let readyEvent;
          try {
            readyEvent = parseVeladReadyLine(trimmed);
          } catch (err) {
            cleanup();
            reject(err);
            return;
          }
          if (!readyEvent) continue;
          cleanup();
          const info = infoFromReadyEvent(readyEvent);
          this.snapshot = { status: "ready", info };
          this.options.observability?.setEndpoint(info.otelBaseUrl);
          this.log("[host]", `velad ready at ${info.apiBaseUrl}`);
          resolve(info);
          return;
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`velad exited before ready code=${code ?? "null"} signal=${signal ?? "null"}`));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        stdout.off("data", onData);
        this.child?.off("exit", onExit);
      };
      stdout.on("data", onData);
      this.child?.on("exit", onExit);
    });
  }

  private finishStopped() {
    this.child = null;
    this.startPromise = null;
    this.managementToken = null;
    this.snapshot = { status: "stopped" };
  }

  private log(source: string, message: string) {
    this.options.logger.write(source, message);
  }

  private async withSpan<T>(
    name: string,
    attributes: Attributes,
    run: (span: VelaLocalSpan | null) => Promise<T>,
  ): Promise<T> {
    const observability = this.options.observability;
    if (!observability) {
      return run(null);
    }
    const span = observability.startSpan(name, { attributes });
    try {
      const value = await run(span);
      observability.endSpan(span);
      await this.flushObservability();
      return value;
    } catch (err) {
      observability.recordError(span, err);
      observability.endSpan(span);
      await this.flushObservability();
      throw err;
    }
  }

  private async flushObservability() {
    try {
      await this.options.observability?.forceFlush();
    } catch (err) {
      this.log("[host]", `velad observability flush failed: ${errorMessage(err)}`);
    }
  }
}

function resolveRuntimeFetch(fetchImpl?: typeof fetch): typeof fetch {
  if (fetchImpl) return fetchImpl;
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis) as typeof fetch;
  }
  return (async () => {
    throw new Error("No Electron runtime fetch implementation is available");
  }) as typeof fetch;
}

function waitForChildExit(child: SpawnedVeladProcess, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for child exit"));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
