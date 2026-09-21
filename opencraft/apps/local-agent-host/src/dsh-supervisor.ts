import { access } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { dirname, join } from "node:path";

export interface DshSupervisorOptions {
  readonly repository?: string;
  readonly executable?: string;
  readonly runtimeDirectory?: string;
  readonly dataDirectory?: string;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly onUnexpectedExit?: (error: Error) => void;
  readonly patches?: readonly string[];
  readonly onCapabilityBridge?: (url: string) => void;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export class DshSupervisor {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private readonly stopping = new WeakSet<object>();
  constructor(private readonly options: DshSupervisorOptions = {}) {}
  get processId(): number | null { return this.child?.pid ?? null; }

  async start(): Promise<string> {
    const externallyManaged = process.env.OPENCRAFT_DSH_URL?.trim();
    if (externallyManaged) return externallyManaged;
    if (this.child !== null) throw new Error("DSH is already starting");

    const repository = this.options.repository
      ?? process.env.OPENCRAFT_DSH_REPOSITORY?.trim();
    const sourceEntry = repository ? join(repository, "apps/cli/src/bin.ts") : null;
    const runtimeDirectory = this.options.runtimeDirectory
      ?? (this.options.executable ? dirname(this.options.executable) : process.cwd());
    const packagedEntry = this.options.executable
      ?? process.env.OPENCRAFT_DSH_EXECUTABLE?.trim()
      ?? (this.options.runtimeDirectory
        ? join(runtimeDirectory, "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js")
        : join(process.cwd(), "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"));
    const usePackaged = await exists(packagedEntry);
    const useSource = !usePackaged && sourceEntry !== null && await exists(sourceEntry);
    if (!usePackaged && !useSource) {
      throw new Error("OpenCraft DSH runtime is missing; run npm run prepare:dsh-runtime before packaging");
    }
    const tsxEntry = join(repository ?? process.cwd(), "node_modules/tsx/dist/cli.mjs");
    const command = process.execPath;
    // DSH's loader/HMR service intentionally consumes Node's internal ESM loader.
    // Keep this as a Node runtime argument (before the entry point), exactly as a
    // standalone DSH host expects; it is not a OpenCraft or web-app flag.
    const args = useSource
      ? ["--expose-internals", tsxEntry, sourceEntry!, "web", "--host", "127.0.0.1", "--port", "0", "--no-open"]
      : ["--expose-internals", packagedEntry, "web", "--host", "127.0.0.1", "--port", "0", "--no-open"];
    for (const path of this.options.patches ?? []) args.splice(args.indexOf("web") + 1, 0, "--patch", path);
    const child = spawn(command, args, {
      cwd: useSource ? repository : runtimeDirectory,
      env: {
        ...process.env,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        ...(this.options.dataDirectory ? { DSH_HOME: this.options.dataDirectory } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.pipe(process.stderr);
    return new Promise<string>((resolve, reject) => {
      let stdout = "";
      let settled = false;
      let ready = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void this.stopChild(child).finally(() => reject(error));
      };
      const timer = setTimeout(() => {
        fail(new Error("Timed out waiting for the bundled DSH host"));
      }, this.options.startupTimeoutMs ?? 30_000);
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        process.stdout.write(`[dsh] ${text}`);
        stdout = (stdout + text).slice(-8192);
        const match = /dsh web:\s*(https?:\/\/[^\s]+)/u.exec(stdout);
        const bridge = /opencraft capability bridge:\s*(http:\/\/127\.0\.0\.1:\d+)/u.exec(stdout);
        if (bridge) this.options.onCapabilityBridge?.(bridge[1]!);
        if (match && !settled) {
          settled = true;
          ready = true;
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        if (this.child === child) this.child = null;
        const error = new Error(`DSH exited ${ready ? "during execution" : "before startup"} (${code ?? signal ?? "unknown"})`);
        if (!ready) fail(error);
        else if (!this.stopping.has(child)) this.options.onUnexpectedExit?.(error);
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child !== null) await this.stopChild(child);
  }
  private async stopChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
    this.stopping.add(child);
    if (this.child === child) this.child = null;
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, this.options.shutdownTimeoutMs ?? 3_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
}
