import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import {
  acquireCodexWriter, CODEX_CORE_PROTOCOL_VERSION, CodexAccountService,
  type CodexAccountServiceOptions, type CodexCoreHealth,
} from "@opencraft/account-pool-host";

export interface CodexCoreOptions extends CodexAccountServiceOptions {
  readonly endpoint: string;
  readonly authToken: string;
  readonly runtimeDirectory: string;
  readonly spawnAppServer?: (input: { args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
  readonly onFailure?: (error: Error) => void;
}

async function removeStaleSocket(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path);
    socket.setTimeout(1_000);
    socket.once("connect", () => { socket.destroy(); reject(new Error(`Socket already has a listener: ${path}`)); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error(`Socket probe timed out: ${path}`)); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
  await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}

async function nativeReady(path: string, child: ChildProcessWithoutNullStreams,
  auth: ReturnType<CodexAccountService["launch"]>["auth"]): Promise<WebSocket> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Codex AppServer exited during startup");
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`ws+unix://${path}:/`, { handshakeTimeout: 500 });
        const timer = setTimeout(() => { socket.terminate(); reject(new Error("Native initialize timed out")); }, 1_000);
        socket.on("error", error => { clearTimeout(timer); reject(error); });
        socket.on("close", () => { clearTimeout(timer); reject(new Error("Native connection closed during initialize")); });
        socket.on("open", () => socket.send(JSON.stringify({ id: 1, method: "initialize",
          params: { clientInfo: { name: "opencraft-core-health", version: "1" }, capabilities: { experimentalApi: true } } })));
        socket.on("message", data => {
          try {
            const value = JSON.parse(String(data));
            if (value.method === "account/chatgptAuthTokens/refresh" && value.id !== undefined) {
              const { type: _type, ...result } = auth;
              socket.send(JSON.stringify({ id: value.id, result }));
              return;
            }
            if (value.id !== 1 && value.id !== 2) return;
            if (value.error) { clearTimeout(timer); socket.terminate(); reject(new Error("Native authentication initialization rejected")); }
            else if (value.id === 1) {
              socket.send(JSON.stringify({ method: "initialized" }));
              socket.send(JSON.stringify({ id: 2, method: "account/login/start", params: auth }));
              return;
            } else { clearTimeout(timer); resolve(socket); }
          } catch (error) { clearTimeout(timer); socket.terminate(); reject(error); }
        });
      });
    } catch { await delay(50); }
  }
  throw new Error("Codex AppServer Unix listener did not become ready");
}

/** Execution and account ownership lives here, never in a daemon connection. */
export async function startCodexCore(options: CodexCoreOptions) {
  if (process.platform === "win32") throw new Error("Codex core requires Unix sockets");
  if (![options.endpoint, options.runtimeDirectory, options.dataDirectory, options.nativeCodexHomeDirectory].every(isAbsolute)) {
    throw new Error("Codex core paths must be absolute");
  }
  if (options.authToken.length < 32) throw new Error("Codex core requires a private daemon token (at least 32 characters)");
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
    child.stderr.on("data", chunk => process.stderr.write(chunk));
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
    health = { protocolVersion: CODEX_CORE_PROTOCOL_VERSION, pid: process.pid, codexPid: child.pid!, nativeSocket };
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.endpoint, () => { server.off("error", reject); ownsControl = true; resolve(); });
    });
    await chmod(options.endpoint, 0o600);
    if (startupError) throw startupError;
    return { endpoint: options.endpoint, health, close };
  } catch (error) { await close(); throw error; }
}
