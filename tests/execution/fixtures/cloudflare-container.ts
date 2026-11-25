/** In-process double of a Durable Object's `ctx.container` (the Cloudflare Containers
 * Durable Object Container API) for the `cloudflare` sandbox backend. Processes are real
 * local child processes; the double reproduces what the 2026-11-23 probe observed on
 * Cloudflare (docs/architecture/platform/workspace-host-split.md §3.6):
 *
 * - `exec` does not inherit the `start()` environment (only PATH) and runs as root;
 *   its stdin is a WritableStream whose writes wait for the pipe (back-pressure).
 * - `kill` signals only the exec'd process, never its descendants; signalling a process
 *   that already exited is an internal error (counted in `killAfterExit`).
 * - `monitor()` settles when the container stops: resolves for a reasonless destroy or
 *   exit 0, rejects with an `exitCode`-bearing error for a crash.
 * - `destroy()` ends every process of the container, including detached descendants.
 * - A Durable Object reset drops exec handles: processes reading stdin get EOF, others
 *   keep running (orphans) until the container stops.
 * - One container per Durable Object; each start is a new incarnation with a new kernel
 *   boot id and placement id; `inspect()` returns the start labels. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { Readable } from "node:stream";
import { CLOUDFLARE_IDENTITY_SOURCE } from "@opencraft/sandbox-cloudflare";
import type {
  ContainerExecOptions,
  ContainerExecProcess,
  ContainerInfo,
  ContainerStartOptions,
  DurableObjectContainer,
} from "@opencraft/sandbox-cloudflare/bindings";

interface Instance {
  readonly bootId: string;
  readonly placement: string;
  readonly options: ContainerStartOptions;
  readonly execs: Set<ChildProcess>;
  stopped: boolean;
  settle(outcome: { code: number } | { reason: unknown }): void;
  readonly monitor: Promise<void>;
}

const signalNumber = (signal: NodeJS.Signals | null) =>
  signal ? ((constants.signals as Record<string, number>)[signal] ?? 9) : 0;

/** Every live descendant of `root`, deepest first (setsid does not change the parent). */
function descendants(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const list = children.get(parent) ?? [];
      list.push(Number(entry));
      children.set(parent, list);
    } catch {}
  }
  const result: number[] = [];
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      walk(child);
      result.push(child);
    }
  };
  walk(root);
  return result;
}

export class FakeDurableObjectContainer implements DurableObjectContainer {
  readonly images = Object.freeze({ base: "registry.example.test/opencraft-agent@sha256:" + "0".repeat(64) });
  readonly timeouts: number[] = [];
  readonly starts: ContainerStartOptions[] = [];
  /** `kill` calls on a process that had already exited (an internal error on Cloudflare). */
  killAfterExit = 0;
  destroys = 0;
  /** Observes every chunk written to an exec's stdin (broker frames). */
  onStdin?: (chunk: Uint8Array) => void;
  #current: Instance | undefined;
  #last: Instance | undefined;
  /** Exec handles of the current Durable Object instance (dropped by `resetDurableObject`). */
  #handles = new Set<ChildProcess>();

  get running() {
    return !!this.#current && !this.#current.stopped;
  }

  start(options: ContainerStartOptions): void {
    if (this.running) throw new Error("Container is already running");
    const instance = options.instance;
    if (
      !(options.image || options.containerSnapshot) ||
      typeof options.enableInternet !== "boolean" ||
      (instance !== undefined &&
        typeof instance === "object" &&
        (!(instance.vcpu >= 0.0625 && instance.vcpu <= 4) ||
          !Number.isSafeInteger(instance.memoryMib) ||
          instance.memoryMib < 256 ||
          instance.memoryMib > 12288 ||
          !Number.isSafeInteger(instance.diskMb) ||
          instance.diskMb < 2000 ||
          instance.diskMb > 20000))
    )
      throw new RangeError("Invalid container start options");
    const labels = Object.entries(options.labels ?? {});
    if (
      labels.length > 10 ||
      labels.some(([name, value]) => !name || Buffer.byteLength(name) > 16 || Buffer.byteLength(value) > 64)
    )
      throw new Error("Invalid labels");
    let settle!: Instance["settle"];
    const monitor = new Promise<void>((resolve, reject) => {
      settle = (outcome) => {
        if ("code" in outcome)
          outcome.code === 0
            ? resolve()
            : reject(
                Object.assign(new Error(`Container exited with unexpected exit code: ${outcome.code}`), {
                  exitCode: outcome.code,
                }),
              );
        else outcome.reason === undefined ? resolve() : reject(outcome.reason);
      };
    });
    void monitor.catch(() => {});
    this.starts.push(options);
    this.#current = this.#last = {
      bootId: randomUUID(),
      placement: randomBytes(16).toString("hex"),
      options,
      execs: new Set(),
      stopped: false,
      settle,
      monitor,
    };
  }

  async inspect(): Promise<ContainerInfo | null> {
    const current = this.#current;
    return current && !current.stopped ? { image: current.options.image ?? "", labels: { ...current.options.labels } } : null;
  }

  monitor(): Promise<void> {
    const instance = this.#current ?? this.#last;
    if (!instance) throw new Error("This Durable Object has no container");
    return instance.monitor;
  }

  async setInactivityTimeout(durationMs: number): Promise<void> {
    if (!(durationMs > 0)) throw new TypeError("Inactivity timeout must be positive");
    if (durationMs > 6 * 3600_000) throw new RangeError("Inactivity timeout exceeds 6 hours");
    this.timeouts.push(durationMs);
  }

  async destroy(reason?: unknown): Promise<void> {
    const instance = this.#current;
    if (!instance || instance.stopped) return;
    this.destroys++;
    await this.#stop(instance, { reason });
  }

  /** The container's main process exits by itself (a crash when `code` is nonzero). */
  async exitMain(code: number): Promise<void> {
    const instance = this.#current;
    if (instance && !instance.stopped) await this.#stop(instance, { code });
  }

  /** A Durable Object reset: exec handles are gone. Processes reading stdin read EOF;
   * the others keep running in the container. */
  resetDurableObject(): void {
    for (const child of this.#handles) child.stdin?.end();
    this.#handles = new Set();
  }

  /** Outside replacement (platform restart): a new incarnation under the same object. */
  async restart(): Promise<void> {
    const instance = this.#current;
    if (!instance) return;
    await this.destroy();
    this.start({
      ...instance.options,
      labels: { ...instance.options.labels, "oc-incarnation": randomBytes(16).toString("hex") },
    });
  }

  async #stop(instance: Instance, outcome: { code: number } | { reason: unknown }) {
    instance.stopped = true;
    const exits: Promise<unknown>[] = [];
    for (const child of instance.execs) {
      if (child.pid === undefined) continue;
      for (const pid of [...descendants(child.pid), child.pid])
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      if (child.exitCode === null && child.signalCode === null)
        exits.push(new Promise((resolve) => child.once("exit", resolve)));
    }
    await Promise.all(exits);
    instance.settle(outcome);
  }

  async exec(command: string[], options: ContainerExecOptions = {}): Promise<ContainerExecProcess> {
    const instance = this.#current;
    if (!instance || instance.stopped) throw new Error("Container is not running");
    if (!command.length) throw new TypeError("exec requires a command");
    // The identity probe reads what the platform's VM would report.
    if (command.includes(CLOUDFLARE_IDENTITY_SOURCE)) {
      const size = instance.options.instance;
      const custom = typeof size === "object" ? size : { vcpu: 4, memoryMib: 12288 };
      return this.#exec(
        instance,
        [
          "/bin/echo",
          JSON.stringify({
            boot: instance.bootId,
            cpus: Math.ceil(custom.vcpu),
            memory: String(custom.memoryMib * 1024 ** 2),
            placement: instance.placement,
          }),
        ],
        options,
      );
    }
    return this.#exec(instance, command, options);
  }

  async #exec(instance: Instance, command: string[], options: ContainerExecOptions): Promise<ContainerExecProcess> {
    // Not inherited from start() or the image, except PATH.
    const child = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd ?? "/",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...options.env },
      stdio: [
        options.stdin === "pipe" ? "pipe" : "ignore",
        options.stdout === "ignore" ? "ignore" : "pipe",
        options.stderr === "pipe" || options.stderr === undefined ? "pipe" : "ignore",
      ],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    instance.execs.add(child);
    this.#handles.add(child);
    let exited = false;
    const exitCode = new Promise<number>((resolve) =>
      child.once("exit", (code, signal) => {
        exited = true;
        instance.execs.delete(child);
        resolve(code ?? 128 + signalNumber(signal));
      }),
    );
    child.stdin?.on("error", () => {});
    const stdin = child.stdin
      ? new WritableStream<Uint8Array>({
          write: (chunk) =>
            new Promise<void>((resolve, reject) => {
              this.onStdin?.(chunk);
              child.stdin!.write(chunk, (error) => (error ? reject(error) : resolve()));
            }),
          close: () =>
            new Promise<void>((resolve) => {
              child.stdin!.end(() => resolve());
            }),
          abort: () => {
            child.stdin!.destroy();
          },
        })
      : null;
    const web = (stream: Readable | null) => (stream ? (Readable.toWeb(stream) as ReadableStream<Uint8Array>) : null);
    return {
      stdin,
      stdout: web(child.stdout),
      stderr: options.stderr === "pipe" || options.stderr === undefined ? web(child.stderr) : null,
      pid: child.pid!,
      exitCode,
      kill: (signal = 15) => {
        if (!Number.isInteger(signal) || signal < 1 || signal > 64) throw new RangeError("Invalid signal");
        if (exited) {
          this.killAfterExit++;
          throw new Error("internal error");
        }
        process.kill(child.pid!, signal);
      },
    };
  }
}
