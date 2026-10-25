import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireCodexWriter, CODEX_CORE_PROTOCOL_VERSION, CodexCoreControlClient, CodexCoreUnavailableError, type CodexAppServerHealth } from "@opencraft/account-pool-host";
import type { CodexCoreOptions } from "./main.js";
import { startControlServer } from "./control-server.js";
import { nativeReady, removeStaleSocket } from "./native-process.js";
import { startOrchestrationCallbackRelay } from "./orchestration-callback-lane.js";

export interface CodexAppServerOptions {
  readonly endpoint: string;
  readonly coreEndpoint: string;
  readonly authToken: string;
  readonly dataDirectory: string;
  /** Generation-local owner root. Account identity still uses dataDirectory. */
  readonly runtimeDataDirectory?: string;
  readonly runtimeDirectory: string;
  readonly executable: string;
  readonly spawnAppServer?: CodexCoreOptions["spawnAppServer"];
  readonly onFailure?: (error: Error) => void;
  readonly waitForCore?: boolean;
  readonly signal?: AbortSignal;
}

/** Fixed-payload execution owner; no account database, credentials or maintenance clients. */
export async function startCodexAppServer(options: CodexAppServerOptions) {
  if (process.platform === "win32" || ![options.endpoint, options.coreEndpoint, options.dataDirectory, options.runtimeDirectory].every(isAbsolute)
    || options.endpoint === options.coreEndpoint || options.authToken.length < 32) throw new Error("Invalid Codex AppServer configuration");
  const runtimeDataDirectory = options.runtimeDataDirectory ?? options.dataDirectory;
  if (!isAbsolute(runtimeDataDirectory)) throw new Error("Codex runtime directory must be absolute");
  const release = await acquireCodexWriter(runtimeDataDirectory, "runtime");
  const nativeSocket = join(dirname(options.endpoint), "native.sock");
  const nativeListener = join(dirname(options.endpoint), "native-internal.sock");
  let relay: Awaited<ReturnType<typeof startOrchestrationCallbackRelay>> | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let control: Awaited<ReturnType<typeof startControlServer>> | undefined;
  let authSocket: Awaited<ReturnType<typeof nativeReady>> | undefined;
  let ownsNative = false, failed = false, ready = false;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try {
      await control?.close(); await relay?.close(); authSocket?.terminate();
      if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
        const timer = setTimeout(() => child?.kill("SIGKILL"), 2_000);
        child!.once("close", () => { clearTimeout(timer); resolve(); }); child!.kill("SIGTERM");
      });
    } finally { if (ownsNative) await unlink(nativeListener).catch(() => undefined); release(); }
  })();
  try {
    const dataDirectory = await realpath(options.dataDirectory);
    const runtimeOwnerRoot = await realpath(runtimeDataDirectory);
    const runtimeRoot = join(runtimeOwnerRoot, "runtime");
    const core = new CodexCoreControlClient(options.coreEndpoint, options.authToken);
    let attempt = 0;
    const configuration = await (async () => {
      for (;;) {
        options.signal?.throwIfAborted();
        try { return await core.appServerLaunch(options.signal); }
        catch (error) {
          if (!options.waitForCore || !(error instanceof CodexCoreUnavailableError)) throw error;
          await delay(Math.min(5_000, 250 * 2 ** Math.min(attempt++, 5)), undefined, { signal: options.signal });
        }
      }
    })();
    options.signal?.throwIfAborted();
    if (configuration.dataDirectory !== dataDirectory) throw new Error("Codex AppServer data directory mismatch");
    const { launch } = configuration;
    const baseSetting = launch.args.find(arg => arg.startsWith("chatgpt_base_url="));
    if (!baseSetting) throw new Error("Codex proxy URL is missing");
    const proxyBaseUrl: string = JSON.parse(baseSetting.slice(baseSetting.indexOf("=") + 1));
    // startControlServer validates the private parent before spawning the native listener.
    control = await startControlServer(options.endpoint, options.authToken, async request => ({
      status: request.method === "GET" && request.url === "/health" && !failed && ready ? 200 : 503,
      value: request.method === "GET" && request.url === "/health" && !failed && ready
        ? { protocolVersion: CODEX_CORE_PROTOCOL_VERSION, pid: process.pid, codexPid: child!.pid!, nativeSocket,
          dataDirectory, runtimeDataDirectory: runtimeOwnerRoot, codexHome: runtimeRoot, proxyBaseUrl,
          callbackProtocolVersion: 1, callbackIncarnation: relay?.incarnation, pendingCallbacks: relay?.pendingCallbacks ?? 0, pendingOrchestrationMutations: relay?.pendingMutations ?? 0 } satisfies CodexAppServerHealth
        : { error: "Codex AppServer unavailable" },
    }));
    if (nativeSocket === options.endpoint) throw new Error("AppServer control endpoint must differ from native.sock");
    await removeStaleSocket(nativeListener);
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    if (options.runtimeDataDirectory && await realpath(runtimeRoot) !== runtimeRoot) throw new Error("Generation HOME must not alias another directory");
    const args = ["app-server", "--listen", `unix://${nativeListener}`, ...launch.args];
    const env = { ...process.env, ...launch.env, CODEX_HOME: runtimeRoot,
      OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined };
    child = options.spawnAppServer?.({ args, cwd: options.runtimeDirectory, env })
      ?? spawn(options.executable, args, { cwd: options.runtimeDirectory, env, stdio: ["pipe", "pipe", "pipe"] });
    ownsNative = true;
    child.stdout.resume(); child.stderr.on("data", chunk => process.stderr.write(chunk));
    const failure = (error: Error) => { failed = true; if (!closing) options.onFailure?.(error); };
    child.once("error", failure);
    child.once("close", (code, signal) => failure(new Error(`Codex AppServer exited (${code ?? signal ?? "unknown"})`)));
    authSocket = await nativeReady(nativeListener, child, launch.auth);
    relay = await startOrchestrationCallbackRelay(nativeSocket, nativeListener);
    options.signal?.throwIfAborted();
    if (failed) throw new Error("Codex AppServer exited during startup");
    await chmod(nativeSocket, 0o600);
    ready = true;
    return { endpoint: options.endpoint, close };
  } catch (error) { await close(); throw error; }
}
