import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { codexDeclaration } from "@opencraft/agent-bridge-host/codex-declaration";
import type { BridgeGatewayOptions } from "@opencraft/agent-bridge-host/gateway";

/** Bundled programs the daemon launches; built beside the daemon into `codex-bridge/`. */
export const CODEX_BRIDGE_PROGRAMS = {
  core: "codex-core.cjs",
  appServer: "codex-app-server.cjs",
  engineHost: "engine-host.mjs",
  provider: "codex.cjs",
  /** Preload that stops a child once the daemon's end of its stdin closes. */
  exitWithParent: "exit-with-parent.cjs",
} as const;

export interface CodexBridgeStackOptions {
  /** Directory holding {@link CODEX_BRIDGE_PROGRAMS} and their workers. */
  readonly programs: string;
  /** Node runtime for the children; Electron runs as Node through ELECTRON_RUN_AS_NODE. */
  readonly node: string;
  readonly codexExecutable: string;
  /** Codex data directory: accounts and the native CODEX_HOME (`runtime/`) stay where the local Host kept them. */
  readonly codexDataDirectory: string;
  readonly nativeCodexHomeDirectory: string;
  readonly runtimeDirectory: string;
  /** Private state of the stack: Engine Host database, sandbox records, generation artifacts. */
  readonly stateDirectory: string;
  /** Shared control token for Core and AppServer; the daemon uses it as its Core credential. */
  readonly authToken: string;
  readonly modelStorageDirectory?: string;
  readonly startupTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

export interface CodexBridgeStack {
  readonly coreEndpoint: string;
  readonly bridge: BridgeGatewayOptions;
  close(): Promise<void>;
}

const CHILDREN_RECORD = "children.json";
/** The provider generation is content-addressed: identical programs and launch register the same generation again. */
const stableJson = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stableJson).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A running process's command line, or null when it is gone or cannot be read (then it is not touched). */
function commandLine(pid: number): Promise<string | null> {
  if (process.platform === "linux") return readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => null);
  if (process.platform === "win32") return Promise.resolve(null);
  return new Promise((resolve) =>
    execFile("ps", ["-o", "command=", "-p", String(pid)], (error, stdout) => resolve(error ? null : stdout)),
  );
}

/** Stop children a crashed daemon left behind, as recorded when they started. */
async function stopRecordedChildren(stateDirectory: string): Promise<void> {
  let recorded: { pid: number; program: string }[];
  try {
    recorded = JSON.parse(await readFile(join(stateDirectory, CHILDREN_RECORD), "utf8"));
  } catch {
    return;
  }
  for (const { pid, program } of Array.isArray(recorded) ? recorded : []) {
    if (!Number.isSafeInteger(pid) || pid < 2 || typeof program !== "string") continue;
    // Only a process still running our program is ours; a reused pid is left alone.
    if (!(await commandLine(pid))?.includes(program)) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await rm(join(stateDirectory, CHILDREN_RECORD), { force: true });
}

interface ChildLauncherOptions {
  readonly node: string;
  /** Preload that stops a child once the daemon's end of its stdin closes. */
  readonly exitWithParent: string;
  readonly programs: string;
  readonly runtimeDirectory: string;
  readonly stateDirectory: string;
  readonly timeoutMs: number;
  readonly log: (line: string) => void;
}

/**
 * Children of this process, recorded so a successor can stop those a crash left
 * behind, and closed in reverse start order through their stdin.
 */
async function childLauncher(options: ChildLauncherOptions) {
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  await stopRecordedChildren(options.stateDirectory);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const children: { child: ChildProcess; program: string }[] = [];
  const record = () =>
    writeFile(
      join(options.stateDirectory, CHILDREN_RECORD),
      JSON.stringify(children.map(({ child, program }) => ({ pid: child.pid, program }))),
      { mode: 0o600 },
    );

  /** Start a child and resolve with its first stdout line accepted by `ready`. */
  const start = async (program: string, args: string[], ready: (line: Record<string, unknown>) => boolean) => {
    const child = spawn(options.node, ["--require", options.exitWithParent, program, ...args], {
      cwd: options.runtimeDirectory,
      env,
      // The daemon keeps stdin open for the child's life; see CODEX_BRIDGE_PROGRAMS.exitWithParent.
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push({ child, program });
    await record();
    const name = program.slice(options.programs.length + 1);
    createInterface({ input: child.stderr! }).on("line", (line) => options.log(`[codex-bridge:${name}] ${line}`));
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} did not become ready`)), options.timeoutMs);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`${name} exited during startup (${signal ?? code})`));
      });
      createInterface({ input: child.stdout! }).on("line", (line) => {
        let value: Record<string, unknown>;
        try {
          value = JSON.parse(line);
        } catch {
          return;
        }
        if (value && ready(value)) {
          clearTimeout(timer);
          resolve(value);
        }
      });
    });
  };

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      // Reverse order: the Engine Host settles its providers before native Codex and Core go away.
      for (const { child } of [...children].reverse()) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        // Closing stdin asks the child to stop through its own shutdown path (see exitWithParent);
        // Windows has no catchable SIGTERM, so this is the one graceful request on every platform.
        child.stdin?.end();
        const forced = setTimeout(() => child.kill("SIGKILL"), 15_000);
        await exited;
        clearTimeout(forced);
      }
      await rm(join(options.stateDirectory, CHILDREN_RECORD), { force: true });
    })());
  return { start, close };
}

const programPaths = (directory: string) =>
  Object.fromEntries(
    Object.entries(CODEX_BRIDGE_PROGRAMS).map(([key, file]) => [key, join(directory, file)]),
  ) as Record<keyof typeof CODEX_BRIDGE_PROGRAMS, string>;

/**
 * Register the Codex provider generation and start the Engine Host for an
 * existing Core. The generation is content-addressed: the same programs and
 * launch register the same generation again, and the artifact is kept by digest
 * so threads bound to it outlive program updates.
 */
async function prepareEngineHost(options: {
    programs: Record<keyof typeof CODEX_BRIDGE_PROGRAMS, string>;
    node: string;
    coreEndpoint: string;
    coreToken: string;
    coreNativeSocket?: string;
    nativeProjectless?: true;
    stateDirectory: string;
    cli?: CodexEngineHostOptions["cli"];
    socketPath?: string;
}) {
  const privateFile = async (name: string, content: string) => {
    const path = join(options.stateDirectory, name);
    await writeFile(path, content, { mode: 0o600 });
    return path;
  };
  const providerBytes = await readFile(options.programs.provider);
  const providerDigest = sha256(providerBytes);
  const generations = join(options.stateDirectory, "generations");
  await mkdir(generations, { recursive: true, mode: 0o700 });
  const artifact = join(generations, `codex-${providerDigest}.cjs`);
  await copyFile(options.programs.provider, artifact);
  const attachment = await privateFile(
    "provider-core.json",
    JSON.stringify({
      endpoint: options.coreEndpoint,
      token: options.coreToken,
      ...(options.coreNativeSocket ? { nativeSocket: options.coreNativeSocket } : {}),
      ...(options.nativeProjectless ? { nativeProjectless: true } : {}),
    }),
  );
  const launch = {
    command: [options.node, artifact, attachment],
    cwd: options.stateDirectory,
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
  const generation = { digest: providerDigest, artifact, provider: codexDeclaration, launch };
  const id = `codex-${sha256(stableJson(generation)).slice(0, 24)}`;
  const token = randomBytes(48).toString("base64url");
  const config = await privateFile(
    "engine-host.json",
    JSON.stringify({
      database: join(options.stateDirectory, "engine-host.sqlite"),
      token,
      backend: "host-process",
      backendOptions: { stateDirectory: join(options.stateDirectory, "sandbox") },
      // host-process neither enforces resources nor contains commands beyond their process group.
      policy: {
        id: "desktop-codex",
        capacity: { cpuMillis: 256_000, memoryBytes: 512 * 1024 ** 3 },
        accept: { unenforcedResources: true, bestEffortContainment: true },
      },
      generations: [{ id, ...generation }],
      activate: id,
      cutoverCodex: true,
      ...(options.cli ? { cli: options.cli } : {}),
      ...(options.socketPath ? { socketPath: options.socketPath } : {}),
    }),
  );
  await mkdir(join(options.stateDirectory, "sandbox"), { recursive: true, mode: 0o700 });
  return { config, token };
}

async function launchEngineHost(
  start: Awaited<ReturnType<typeof childLauncher>>["start"],
  options: Parameters<typeof prepareEngineHost>[0] & { serverId?: string },
): Promise<BridgeGatewayOptions> {
  const { config, token } = await prepareEngineHost(options);
  const ready = await start(options.programs.engineHost, [config], (line) => typeof line.url === "string");
  return {
    url: String(ready.url),
    token,
    serverId: options.serverId ?? "local-codex",
    inboxPath: join(options.stateDirectory, "gateway-inbox.sqlite"),
  };
}

/** Prepare the same immutable provider for supervision by the workspace agent. */
export async function prepareWorkspaceCodexEngineHost(options: Pick<CodexEngineHostOptions,
  "programs" | "node" | "coreEndpoint" | "coreToken" | "stateDirectory"> & { socketPath: string; coreNativeSocket: string }) {
  const programs = programPaths(options.programs);
  await stat(programs.engineHost);
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  return { program: programs.engineHost, ...await prepareEngineHost({ ...options, programs, nativeProjectless: true }) };
}

export interface CodexEngineHostOptions {
  /** Directory holding {@link CODEX_BRIDGE_PROGRAMS}; only the Engine Host, provider and preload are used. */
  readonly programs: string;
  readonly node: string;
  /** The running Core this Engine Host's Codex provider attaches to. */
  readonly coreEndpoint: string;
  readonly coreToken: string;
  /**
   * Native Codex socket, when the Core owns accounts only and the native AppServer is reached
   * elsewhere (a workspace endpoint). Without it the provider asks the Core's health.
   */
  readonly coreNativeSocket?: string;
  readonly runtimeDirectory: string;
  /** Private state: Engine Host database, sandbox records, generation artifacts, gateway inbox. */
  readonly stateDirectory: string;
  readonly startupTimeoutMs?: number;
  readonly log?: (line: string) => void;
  /**
   * The execution CLI (thread spawn/tell/wait from a turn's shell): the Server's private
   * signing key file, its loopback `/thread-cli` endpoint and a private launcher directory.
   */
  readonly cli?: { readonly directory: string; readonly signingKey: string; readonly endpoint: string };
  /** The conversation server these Threads belong to; execution credentials are signed for it. */
  readonly serverId?: string;
}

/**
 * The Codex Engine Host alone, for a process whose Core already runs (a
 * server): it is this process's child and stops with it. Existing Threads keep
 * running on the Core's native AppServer; the bridge reaches them there.
 */
export async function startCodexEngineHost(
  options: CodexEngineHostOptions,
): Promise<{ readonly bridge: BridgeGatewayOptions; close(): Promise<void> }> {
  const programs = programPaths(options.programs);
  for (const key of ["engineHost", "provider", "exitWithParent"] as const) await stat(programs[key]);
  const launcher = await childLauncher({
    node: options.node,
    exitWithParent: programs.exitWithParent,
    programs: options.programs,
    runtimeDirectory: options.runtimeDirectory,
    stateDirectory: options.stateDirectory,
    timeoutMs: options.startupTimeoutMs ?? 60_000,
    log: options.log ?? ((line) => console.error(line)),
  });
  try {
    const bridge = await launchEngineHost(launcher.start, {
      programs,
      node: options.node,
      coreEndpoint: options.coreEndpoint,
      coreToken: options.coreToken,
      ...(options.coreNativeSocket ? { coreNativeSocket: options.coreNativeSocket } : {}),
      stateDirectory: options.stateDirectory,
      ...(options.cli ? { cli: options.cli } : {}),
      ...(options.serverId ? { serverId: options.serverId } : {}),
    });
    return { bridge, close: launcher.close };
  } catch (error) {
    await launcher.close().catch(() => undefined);
    throw error;
  }
}

/**
 * The daemon's Codex bridge stack for one desktop installation: split Codex
 * Core (accounts and model proxy), the standalone native AppServer and the
 * Engine Host with the Codex provider. They are the daemon's children and stop
 * with it; there is no fallback to another execution path when one fails.
 */
export async function startCodexBridgeStack(options: CodexBridgeStackOptions): Promise<CodexBridgeStack> {
  const log = options.log ?? ((line: string) => console.error(line));
  const programs = programPaths(options.programs);
  for (const path of Object.values(programs)) await stat(path);

  // Unix sockets in a short private directory (paths are length-limited: 104 bytes on macOS);
  // on Windows, named pipes unique to this stack instance.
  const windows = process.platform === "win32";
  const sockets = windows ? undefined : await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ocb-"));
  const instance = randomBytes(8).toString("hex");
  const pipe = (name: string) => String.raw`\\.\pipe\opencraft-codex-` + `${instance}-${name}`;
  const coreEndpoint = sockets ? join(sockets, "core.sock") : pipe("core"),
    appServerEndpoint = sockets ? join(sockets, "app-server.sock") : pipe("app-server");
  const launcher = await childLauncher({
    node: options.node,
    exitWithParent: programs.exitWithParent,
    programs: options.programs,
    runtimeDirectory: options.runtimeDirectory,
    stateDirectory: options.stateDirectory,
    timeoutMs: options.startupTimeoutMs ?? 60_000,
    log,
  });
  const close = async () => {
    await launcher.close();
    if (sockets) await rm(sockets, { recursive: true, force: true });
  };

  try {
    const tokenFile = join(options.stateDirectory, "control.token");
    await writeFile(tokenFile, `${options.authToken}\n`, { mode: 0o600 });
    const shared = [
      "--token-file",
      tokenFile,
      "--codex-executable",
      options.codexExecutable,
      "--runtime-directory",
      options.runtimeDirectory,
      "--data-directory",
      options.codexDataDirectory,
    ];
    await launcher.start(
      programs.core,
      [
        "--endpoint",
        coreEndpoint,
        "--app-server-endpoint",
        appServerEndpoint,
        "--proxy-port",
        String(await freePort()),
        "--native-codex-home-directory",
        options.nativeCodexHomeDirectory,
        ...(options.modelStorageDirectory ? ["--model-storage-directory", options.modelStorageDirectory] : []),
        ...shared,
      ],
      (line) => line.type === "codex-accounts-listening",
    );
    await launcher.start(
      programs.appServer,
      ["--endpoint", appServerEndpoint, "--core-endpoint", coreEndpoint, ...shared],
      (line) => line.type === "codex-app-server-ready",
    );
    const bridge = await launchEngineHost(launcher.start, {
      programs,
      node: options.node,
      coreEndpoint,
      coreToken: options.authToken,
      stateDirectory: options.stateDirectory,
    });
    return { coreEndpoint, bridge, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
