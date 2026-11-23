import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  SandboxCreationFault,
  SandboxFault,
  type SandboxBackend,
  type SandboxCommand,
  type SandboxEnforcement,
  type SandboxEnvironment,
  type SandboxExit,
  type SandboxIdentity,
  type SandboxOutput,
  type SandboxPoolPolicy,
  type SandboxProcess,
  type SandboxResources,
} from "@opencraft/sandbox";

const execute = promisify(execFile);
const fault = (code: ConstructorParameters<typeof SandboxFault>[0], message: string) => new SandboxFault(code, message);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The host-process guarantee, stated rather than implied: requested resources
 * are an admission reservation only, and a descendant that detaches itself
 * (a new session on POSIX, or any process whose ancestor already exited on
 * Windows) can survive close. Permission isolation stays with the engine.
 */
export const HOST_PROCESS_ENFORCEMENT: Readonly<SandboxEnforcement> = Object.freeze({
  resources: "unenforced",
  containment: "best-effort",
});

/** Operating-system operations on one command's process group (POSIX) or tree (Windows). */
export interface HostProcessPlatform {
  /** A new process group per command on POSIX; none on Windows. */
  readonly detached: boolean;
  /** Opaque start identity of a live process, or null when it is gone. */
  startIdentity(pid: number): Promise<string | null>;
  /** Ask (force=false) or force (force=true) the group or tree to stop. */
  terminate(pid: number, force: boolean): Promise<void>;
  /** Whether any member of the group (POSIX) or the root (Windows) is still observable. */
  alive(pid: number): Promise<boolean>;
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 1;

/** POSIX: one process group per command. A PID is never reused while it still names a live group. */
export const posixHostProcessPlatform: HostProcessPlatform = {
  detached: true,
  async startIdentity(pid) {
    if (!validPid(pid)) return null;
    if (process.platform === "linux") {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        // Fields after the parenthesised command name; starttime is field 22 overall.
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
      } catch {
        return null;
      }
    }
    try {
      return (
        (
          await execute("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
            env: { LANG: "C", LC_ALL: "C" },
            timeout: 5000,
          })
        ).stdout.trim() || null
      );
    } catch {
      return null;
    }
  },
  async terminate(pid, force) {
    if (!validPid(pid)) return;
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    } catch (error) {
      if (errno(error) !== "ESRCH") throw error;
    }
  },
  async alive(pid) {
    if (!validPid(pid)) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return errno(error) !== "ESRCH";
    }
  },
};

/** Windows: the root and its live descendants, found by taskkill's tree walk. */
export const windowsHostProcessPlatform: HostProcessPlatform = {
  detached: false,
  async startIdentity(pid) {
    if (!validPid(pid)) return null;
    const root = process.env.SystemRoot ?? "C:\\Windows";
    try {
      const { stdout } = await execute(
        `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){$p.StartTime.ToFileTimeUtc()}`,
        ],
        { timeout: 15_000, windowsHide: true },
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  },
  async terminate(pid, force) {
    if (!validPid(pid)) return;
    const root = process.env.SystemRoot ?? "C:\\Windows";
    try {
      await execute(`${root}\\System32\\taskkill.exe`, ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
        timeout: 15_000,
        windowsHide: true,
      });
    } catch {
      /* Already gone, or verified by alive() below. */
    }
  },
  async alive(pid) {
    if (!validPid(pid)) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return errno(error) !== "ESRCH";
    }
  },
};

export interface HostProcessSandboxOptions {
  /** Private directory owned by this backend: its owner record and live command records for crash recovery. */
  readonly stateDirectory: string;
  /** Time between asking and forcing a command group to stop. */
  readonly terminateGraceMs?: number;
  readonly platform?: HostProcessPlatform;
}

interface Record {
  readonly pid: number;
  readonly start: string | null;
}
interface State {
  readonly owner: Record;
  readonly processes: readonly Record[];
}

/**
 * Explicitly selected local backend for hosts without a kernel resource domain
 * (macOS, Windows, or Linux without systemd). Commands run as ordinary host
 * processes in the selected cwd with exactly the selected environment.
 */
export function hostProcessSandboxBackend(options: HostProcessSandboxOptions): SandboxBackend {
  const platform =
    options.platform ?? (process.platform === "win32" ? windowsHostProcessPlatform : posixHostProcessPlatform);
  const grace = options.terminateGraceMs ?? 3000;
  if (!isAbsolute(options.stateDirectory) || !Number.isSafeInteger(grace) || grace < 0 || grace > 60_000)
    throw fault("SANDBOX_POLICY", "Invalid host-process sandbox options");
  const statePath = join(options.stateDirectory, "host-process.json");
  let policy: SandboxPoolPolicy | undefined, owner: Record | undefined;
  const environments = new Set<SandboxEnvironment>();
  const records = new Map<number, Record>();
  let writing = Promise.resolve();
  const persist = () =>
    (writing = writing
      .catch(() => {})
      .then(async () => {
        const temporary = `${statePath}.${process.pid}.tmp`;
        await writeFile(
          temporary,
          JSON.stringify({ owner: owner!, processes: [...records.values()] } satisfies State),
          { mode: 0o600 },
        );
        await rename(temporary, statePath);
      }));

  /** Ask, wait, force, then confirm nothing of the group remains. */
  const stopGroup = async (pid: number) => {
    if (!(await platform.alive(pid))) return;
    await platform.terminate(pid, false);
    for (const [force, wait] of [
      [false, grace],
      [true, 2000],
    ] as const) {
      if (force) await platform.terminate(pid, true);
      for (const deadline = Date.now() + wait; Date.now() < deadline; await delay(25))
        if (!(await platform.alive(pid))) return;
      if (!(await platform.alive(pid))) return;
    }
    throw fault("SANDBOX_CLEANUP", "Host process group did not stop");
  };

  /** Reclaim command groups left by an owner that is verifiably gone; refuse anything uncertain. */
  const recover = async () => {
    let previous: State;
    try {
      previous = JSON.parse(await readFile(statePath, "utf8")) as State;
    } catch (error) {
      if (errno(error) === "ENOENT") return;
      throw fault("SANDBOX_UNAVAILABLE", "Host-process sandbox state is unreadable; inspect before recovery");
    }
    if (
      !previous ||
      typeof previous !== "object" ||
      !Array.isArray(previous.processes) ||
      !previous.owner ||
      !validPid(previous.owner.pid)
    ) {
      throw fault("SANDBOX_UNAVAILABLE", "Host-process sandbox state is unreadable; inspect before recovery");
    }
    if (previous.owner.start !== null && (await platform.startIdentity(previous.owner.pid)) === previous.owner.start) {
      throw fault("SANDBOX_UNAVAILABLE", "Host-process sandbox state belongs to a live owner");
    }
    for (const row of previous.processes) {
      if (!row || !validPid(row.pid))
        throw fault("SANDBOX_UNAVAILABLE", "Host-process sandbox state is unreadable; inspect before recovery");
      const current = await platform.startIdentity(row.pid);
      // Same leader, or (POSIX) a leaderless group that still carries its number: ours.
      const ours = current !== null ? current === row.start : platform.detached && (await platform.alive(row.pid));
      if (!ours) continue;
      try {
        await stopGroup(row.pid);
      } catch {
        throw fault(
          "SANDBOX_UNAVAILABLE",
          "Processes left by a previous owner could not be reclaimed; inspect before recovery",
        );
      }
    }
  };

  return {
    id: "host-process",
    async initialize(input, signal) {
      if (policy) throw fault("SANDBOX_POLICY", "Sandbox backend already belongs to a Host");
      try {
        await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
        const directory = await lstat(options.stateDirectory);
        if (
          !directory.isDirectory() ||
          (process.getuid && (directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0))
        )
          throw Error();
      } catch {
        throw fault("SANDBOX_UNAVAILABLE", "Host-process sandbox requires a private owned state directory");
      }
      await recover();
      if (signal.aborted) throw fault("SANDBOX_CLOSED", "Sandbox initialization was cancelled");
      owner = { pid: process.pid, start: await platform.startIdentity(process.pid) };
      records.clear();
      try {
        await persist();
      } catch {
        throw fault("SANDBOX_UNAVAILABLE", "Host-process sandbox state could not be written");
      }
      policy = input;
    },
    async create(identity: SandboxIdentity, resources: SandboxResources, signal: AbortSignal) {
      if (!policy || signal.aborted) throw new SandboxCreationFault("not-created");
      let closing = false,
        cleanup: Promise<void> | undefined,
        sequence = 0;
      const starting = new Set<Promise<SandboxProcess>>();
      const running = new Map<string, { stop(): Promise<void>; exited: Promise<SandboxExit> }>();
      const start = async (
        command: SandboxCommand,
        onOutput?: (event: SandboxOutput) => void,
      ): Promise<SandboxProcess> => {
        if (closing || !isAbsolute(command.cwd))
          throw fault("SANDBOX_START", "Invalid host-process command or closed environment");
        const id = identity.id + "-" + ++sequence;
        const [file, ...args] = command.command as [string, ...string[]];
        let resolve!: (exit: SandboxExit) => void, reject!: (error: unknown) => void;
        const exited = new Promise<SandboxExit>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        void exited.catch(() => {});
        let pid = 0,
          ready = false,
          finished = false,
          observerFailed = false,
          termination: Promise<void> | undefined;
        let killRoot: () => void = () => {};
        const terminate = () =>
          (termination ??= stopGroup(pid).catch((error) => {
            killRoot();
            throw error;
          }));
        const output = (stream: "stdout" | "stderr", data: Uint8Array) => {
          try {
            onOutput?.({ stream, data });
          } catch {
            observerFailed = true;
            if (ready) void terminate().catch(() => {});
          }
        };
        // As in the systemd backend, a finished command takes what it left running with it.
        const finish = (code: number | null, signal?: string, drain?: () => Promise<void>) => {
          if (finished) return;
          finished = true;
          void (async () => {
            await started;
            await terminate();
            await drain?.();
            if (records.delete(pid)) await persist();
          })().then(
            () => {
              running.delete(id);
              if (observerFailed) reject(fault("SANDBOX_START", "Sandbox output consumer failed"));
              else resolve({ code, ...(signal ? { signal } : {}) });
            },
            () => reject(fault("SANDBOX_CLEANUP", "Host process cleanup is unverified")),
          );
        };
        let writeStdin: (data: Uint8Array) => Promise<void>,
          closeStdin: (() => Promise<void>) | undefined,
          resize: ((size: { cols: number; rows: number }) => Promise<void>) | undefined;
        let markStarted!: () => void;
        const started = new Promise<void>((yes) => {
          markStarted = yes;
        });
        if (command.terminal) {
          const { spawn: spawnPty } = await import("node-pty");
          if (closing) throw fault("SANDBOX_CLOSED", "Sandbox closed before terminal creation");
          let pty: ReturnType<typeof spawnPty>;
          try {
            pty = spawnPty(file, args, {
              cwd: command.cwd,
              env: { ...command.env },
              ...command.terminal,
              name: "xterm-256color",
            });
          } catch {
            throw fault("SANDBOX_START", "Host process could not start");
          }
          pid = pty.pid;
          killRoot = () => {
            try {
              pty.kill();
            } catch {}
          };
          pty.onData((data) => output("stdout", Buffer.from(data, "utf8")));
          pty.onExit((event) => finish(event.exitCode, event.signal ? String(event.signal) : undefined));
          writeStdin = async (data) => {
            try {
              pty.write(Buffer.from(data));
            } catch {
              throw fault("SANDBOX_START", "Sandbox stdin is unavailable");
            }
          };
          resize = async (size) => {
            if (![size.cols, size.rows].every((v) => Number.isInteger(v) && v > 0 && v <= 1000))
              throw fault("SANDBOX_POLICY", "Invalid sandbox terminal size");
            try {
              pty.resize(size.cols, size.rows);
            } catch {
              throw fault("SANDBOX_START", "Sandbox terminal resize failed");
            }
          };
        } else {
          const child = spawn(file, args, {
            cwd: command.cwd,
            env: { ...command.env },
            stdio: ["pipe", "pipe", "pipe"],
            detached: platform.detached,
            windowsHide: true,
          });
          try {
            await new Promise<void>((yes, no) => {
              child.once("spawn", yes);
              child.once("error", no);
            });
          } catch {
            throw fault("SANDBOX_START", "Host process could not start");
          }
          pid = child.pid ?? 0;
          killRoot = () => {
            child.kill("SIGKILL");
          };
          child.stdout!.on("data", (data) => output("stdout", data));
          child.stderr!.on("data", (data) => output("stderr", data));
          // The root's exit ends the command. Pipes can stay open in a descendant that
          // escaped its group, so after reclaiming the group, read briefly and then let go.
          const streamsClosed = new Promise<void>((yes) => child.once("close", () => yes()));
          child.once("exit", (code, signal) =>
            finish(code, signal ?? undefined, async () => {
              await Promise.race([streamsClosed, delay(500)]);
              child.stdout!.destroy();
              child.stderr!.destroy();
            }),
          );
          child.stdin!.on("error", () => {}); // write callback still rejects its caller.
          writeStdin = (data) =>
            new Promise<void>((yes, no) =>
              child.stdin!.write(Buffer.from(data), (error) =>
                error ? no(fault("SANDBOX_START", "Sandbox stdin failed")) : yes(),
              ),
            );
          closeStdin = () =>
            new Promise<void>((yes, no) => {
              if (child.stdin!.destroyed || child.stdin!.writableEnded) {
                yes();
                return;
              }
              child.stdin!.end((error?: Error | null) =>
                error ? no(fault("SANDBOX_START", "Sandbox stdin could not close")) : yes(),
              );
            });
        }
        running.set(id, { stop: terminate, exited });
        // Recorded before the caller sees the process, so a crashed owner's successor can reclaim it.
        try {
          if (!validPid(pid)) throw Error();
          records.set(pid, { pid, start: await platform.startIdentity(pid) });
          await persist();
        } catch {
          markStarted();
          await terminate().catch(() => {});
          throw fault("SANDBOX_START", "Host process could not be recorded for recovery");
        }
        markStarted();
        ready = true;
        if (closing || observerFailed) {
          await terminate();
          throw fault("SANDBOX_START", "Host process was cancelled");
        }
        const common = { id, exited, writeStdin, terminate };
        return resize
          ? { ...common, kind: "terminal", resize }
          : { ...common, kind: "process", closeStdin: closeStdin! };
      };
      const environment: SandboxEnvironment = {
        resources: Object.freeze({ ...resources }),
        enforcement: HOST_PROCESS_ENFORCEMENT,
        capabilities: { terminal: true },
        spawn(command, onOutput) {
          if (closing) return Promise.reject(fault("SANDBOX_CLOSED", "Sandbox environment is closed"));
          const operation = start(command, onOutput).catch((error) => {
            if (error instanceof SandboxFault) throw error;
            throw fault("SANDBOX_START", "Execution could not start in the selected environment");
          });
          starting.add(operation);
          void operation.finally(() => starting.delete(operation)).catch(() => {});
          return operation;
        },
        close() {
          if (cleanup) return cleanup;
          closing = true;
          return (cleanup = (async () => {
            await Promise.allSettled([...starting]);
            const commands = [...running.values()];
            const results = await Promise.allSettled([
              ...commands.map((p) => p.stop()),
              ...commands.map((p) => p.exited),
            ]);
            if (results.some((r) => r.status === "rejected"))
              throw fault("SANDBOX_CLEANUP", "Host processes could not be stopped");
            environments.delete(environment);
          })());
        },
      };
      environments.add(environment);
      return environment;
    },
    async close() {
      if (!policy) return;
      if (environments.size) throw fault("SANDBOX_CLEANUP", "Sandbox environments still own this backend");
      await writing.catch(() => {});
      await rm(statePath, { force: true });
      policy = undefined;
    },
  };
}
