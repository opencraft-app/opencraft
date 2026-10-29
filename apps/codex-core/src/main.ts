import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import WebSocket from "ws";
import {
  acquireCodexWriter, CODEX_CORE_PROTOCOL_VERSION, CodexAccountService,
  type CodexAccountServiceOptions, type CodexCoreHealth,
} from "@opencraft/account-pool-host";

import { nativeReady, removeStaleSocket } from "./native-process.js";
import { startSplitCodexCore } from "./split-core.js";

export interface CodexCoreOptions extends CodexAccountServiceOptions {
  readonly endpoint: string;
  readonly authToken: string;
  readonly runtimeDirectory: string;
  /** Explicit opt-in; omitted deployments retain the combined process. */
  readonly appServerEndpoint?: string;
  readonly spawnAppServer?: (input: { args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
  readonly onFailure?: (error: Error) => void;
}

/** Execution and account ownership lives here, never in a daemon connection. */
export async function startCodexCore(options: CodexCoreOptions) {
  if (process.platform === "win32") throw new Error("Codex core requires Unix sockets");
  if (![options.endpoint, options.runtimeDirectory, options.dataDirectory, options.nativeCodexHomeDirectory].every(isAbsolute)) {
    throw new Error("Codex core paths must be absolute");
  }
  if (options.authToken.length < 32) throw new Error("Codex core requires a private daemon token (at least 32 characters)");
  if (options.appServerEndpoint) return startSplitCodexCore(options);
  const nativeSocket = join(dirname(options.endpoint), "native.sock");
  if (nativeSocket === options.endpoint) throw new Error("Codex core control endpoint must differ from native.sock");
  const releaseWriter = await acquireCodexWriter(options.dataDirectory);
  let child: ChildProcessWithoutNullStreams | null = null;
  let accounts: CodexAccountService | null = null;
  let health: CodexCoreHealth | null = null;
  let closing: Promise<void> | null = null;
  let ownsControl = false;
  let ownsNative = false;
  let authSocket: WebSocket | null = null;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    const reply = (status: number, value: unknown) => { res.writeHead(status); res.end(JSON.stringify(value)); };
    const provided = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${options.authToken}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      reply(401, { error: "Codex core authentication failed" }); return;
    }
    if (closing || health === null || child?.exitCode !== null || child?.signalCode !== null) {
      reply(503, { error: "Codex core is unavailable" }); return;
    }
    if (req.method === "GET" && req.url === "/health") { reply(200, health); return; }
    if (req.method !== "POST" || req.url !== "/accounts") { reply(404, { error: "Unknown Codex core operation" }); return; }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error("Account request too large");
        chunks.push(chunk);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || !("method" in value) || !("params" in value)
        || typeof value.method !== "string" || !value.method.startsWith("opencraft/codex/accounts/")
        || !value.params || typeof value.params !== "object" || Array.isArray(value.params)) throw new Error("Invalid account request");
      reply(200, await accounts!.request(value.method, value.params as Record<string, unknown>));
    } catch (error) { reply(400, { error: error instanceof Error ? error.message : "Codex account operation failed" }); }
  });

  const close = (): Promise<void> => closing ??= (async () => {
    health = null;
    authSocket?.terminate();
    if (ownsControl) await new Promise<void>(resolve => server.close(() => resolve()));
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child?.kill("SIGKILL"), 2_000);
        child!.once("close", () => { clearTimeout(timer); resolve(); });
        child!.kill("SIGTERM");
      });
    }
    try { await accounts?.close(); }
    finally {
      if (ownsNative) await unlink(nativeSocket).catch(() => undefined);
      if (ownsControl) await unlink(options.endpoint).catch(() => undefined);
      releaseWriter();
    }
  })();

  try {
    await mkdir(dirname(options.endpoint), { recursive: true, mode: 0o700 });
    if (((await stat(dirname(options.endpoint))).mode & 0o077) !== 0) {
      throw new Error("Codex core socket directory must be private (mode 0700)");
    }
    await removeStaleSocket(options.endpoint);
    await removeStaleSocket(nativeSocket);
    const runtimeRoot = join(options.dataDirectory, "runtime");
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    accounts = await CodexAccountService.start(options);
    const launch = accounts.launch();
    const args = ["app-server", "--listen", `unix://${nativeSocket}`, ...launch.args];
    const env = { ...process.env, ...launch.env, CODEX_HOME: runtimeRoot,
      OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined };
    child = options.spawnAppServer?.({ args, cwd: options.runtimeDirectory, env })
      ?? spawn(options.executable, args, { cwd: options.runtimeDirectory, env, stdio: ["pipe", "pipe", "pipe"] });
    ownsNative = true;
    child.stdout.resume();
    // Native stderr may contain tool output or private environment values.
    child.stderr.resume();
    let startupError: Error | null = null;
    const failed = (error: Error) => {
      startupError = error;
      if (health !== null && !closing) { health = null; options.onFailure?.(error); }
    };
    child.once("error", failed);
    child.once("close", (code, signal) => failed(new Error(`Codex AppServer exited (${code ?? signal ?? "unknown"})`)));
    authSocket = await nativeReady(nativeSocket, child, launch.auth);
    if (startupError) throw startupError;
    await chmod(nativeSocket, 0o600);
    health = { environmentVariablesVersion: 1, protocolVersion: CODEX_CORE_PROTOCOL_VERSION, pid: process.pid, codexPid: child.pid!, nativeSocket };
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.endpoint, () => { server.off("error", reject); ownsControl = true; resolve(); });
    });
    await chmod(options.endpoint, 0o600);
    if (startupError) throw startupError;
    return { endpoint: options.endpoint, health, close };
  } catch (error) { await close(); throw error; }
}
