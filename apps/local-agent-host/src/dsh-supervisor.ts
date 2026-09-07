import { access } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { join } from "node:path";

export interface DshSupervisorOptions {
  readonly repository?: string;
  readonly executable?: string;
  readonly dataDirectory?: string;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export class DshSupervisor {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  constructor(private readonly options: DshSupervisorOptions = {}) {}

  async start(): Promise<string> {
    const externallyManaged = process.env.OPENCRAFT_DSH_URL?.trim();
    if (externallyManaged) return externallyManaged;
    if (this.child !== null) throw new Error("DSH is already starting");

    const repository = this.options.repository
      ?? process.env.OPENCRAFT_DSH_REPOSITORY?.trim();
    const sourceEntry = repository ? join(repository, "apps/cli/src/bin.ts") : null;
    const packagedEntry = this.options.executable
      ?? process.env.OPENCRAFT_DSH_EXECUTABLE?.trim()
      ?? join(process.cwd(), "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");
    const usePackaged = await exists(packagedEntry);
    const useSource = !usePackaged && sourceEntry !== null && await exists(sourceEntry);
    if (!usePackaged && !useSource) {
      throw new Error("OpenCraft DSH runtime is missing; run npm run prepare:dsh-runtime before packaging");
    }
    const tsxEntry = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
    const command = process.execPath;
    // DSH's loader/HMR service intentionally consumes Node's internal ESM loader.
    // Keep this as a Node runtime argument (before the entry point), exactly as a
    // standalone DSH host expects; it is not a OpenCraft or web-app flag.
    const args = useSource
      ? ["--expose-internals", tsxEntry, sourceEntry!, "web", "--host", "127.0.0.1", "--port", "0", "--no-open"]
      : ["--expose-internals", packagedEntry, "web", "--host", "127.0.0.1", "--port", "0", "--no-open"];
    const child = spawn(command, args, {
      cwd: useSource ? repository : process.cwd(),
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
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Timed out waiting for the bundled DSH host"));
      }, 30_000);
      const finish = (callback: () => void) => { clearTimeout(timer); callback(); };
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        process.stdout.write(`[dsh] ${text}`);
        stdout += text;
        const match = /dsh web:\s*(https?:\/\/[^\s]+)/u.exec(stdout);
        if (match) finish(() => resolve(match[1]!));
      });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("exit", (code, signal) => {
        this.child = null;
        finish(() => reject(new Error(`DSH exited before startup (${code ?? signal ?? "unknown"})`)));
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3_000)),
    ]);
  }
}
