import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SandboxCreationFault, SandboxFault, type SandboxBackend, type SandboxCommand, type SandboxEnvironment, type SandboxExit, type SandboxIdentity, type SandboxOutput, type SandboxPoolPolicy, type SandboxProcess, type SandboxResources } from "@opencraft/sandbox";
const execute = promisify(execFile);
export interface SystemdSandboxOptions {
  readonly scope: "system" | "user";
  readonly uid: number;
  readonly gid: number;
  /** Explicit compatibility policy for existing local execution identities. Not a security sandbox. */
  readonly inheritHostIdentity?: boolean;
  /** An operator-owned, bounded slice shared by every execution engine. */
  readonly parentSlice?: string;
  /** Root-compatible native bwrap requires UID/GID and root mapping capabilities in its bounding set. */
  readonly userNamespaceMapping?: boolean;
  /** Bind workload lifetime to its existing engine owner, never to Core/router. */
  readonly ownerUnit?: string;
  readonly tasksMax?: number;
  readonly poolTasksMax?: number;
  readonly fileDescriptorsPerProcess?: number;
}
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
const fault = (code: ConstructorParameters<typeof SandboxFault>[0], message: string) => new SandboxFault(code, message);

/** Optional local backend. No systemd/Node objects cross the shared sandbox port. */
export function systemdSandboxBackend(options: SystemdSandboxOptions): SandboxBackend {
  options = Object.freeze({ ...options });
  const scope = options.scope === "user" ? ["--user"] : [];
  const managementEnv: NodeJS.ProcessEnv = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };
  if (options.scope === "user") for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    if (process.env[key]) managementEnv[key] = process.env[key];
  }
  const tasks = options.tasksMax ?? 4096, poolTasks = options.poolTasksMax ?? 16384, descriptors = options.fileDescriptorsPerProcess ?? 65536;
  const description = "OpenCraft sandbox owner " + randomUUID();
  let policy: SandboxPoolPolicy | undefined, poolSlice = "", owned = false;
  let namespaceProperties: string[] = [];
  const environments = new Set<SandboxEnvironment>();
  const control = async (args: string[]) => {
    try { return (await execute("/usr/bin/systemctl", [...scope, ...args], { env: managementEnv, timeout: 10_000, maxBuffer: 64 * 1024 })).stdout; }
    catch { throw fault("SANDBOX_UNAVAILABLE", "Sandbox systemd control failed"); }
  };
  const state = async (unit: string) => Object.fromEntries((await control(["show", "--property=LoadState,ActiveState,MainPID,ControlGroup,Description,Transient,FragmentPath,DropInPaths,PrivateTmp", "--", unit])).trim().split("\n").map(l => {
    const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)];
  }));
  const stop = async (unit: string) => {
    const before = await state(unit);
    if (before.LoadState === "not-found" || before.ActiveState === "inactive" && !before.ControlGroup) return;
    if (before.Description !== description || before.Transient !== "yes") throw fault("SANDBOX_CLEANUP", "Sandbox resource owner changed; refusing to stop another owner");
    try { await control(["stop", "--", unit]); } catch { /* Verify an already collected unit below. */ }
    const after = await state(unit);
    if ((after.MainPID ?? "0") !== "0" || !["inactive", "failed"].includes(after.ActiveState ?? "")) throw fault("SANDBOX_CLEANUP", "Sandbox descendants have not stopped");
    for (const cg of new Set([before.ControlGroup, after.ControlGroup].filter(Boolean))) {
      if (!isAbsolute(cg!) || cg!.includes("..")) throw fault("SANDBOX_CLEANUP", "Sandbox resource group is unverified");
      try {
        if (/^populated 1$/mu.test(await readFile("/sys/fs/cgroup" + cg + "/cgroup.events", "utf8"))) throw Error();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw fault("SANDBOX_CLEANUP", "Sandbox descendants could not be verified");
      }
    }
    if (after.ActiveState === "failed") await control(["reset-failed", "--", unit]);
  };
  const group = async (slice: string, resources: SandboxResources, maxTasks: number, high: boolean) => {
    const current = await state(slice);
    if (!["inactive", "failed"].includes(current.ActiveState ?? "") || current.ControlGroup || current.FragmentPath || current.DropInPaths) {
      throw fault("SANDBOX_UNAVAILABLE", "Sandbox resource domain already exists; inspect its retained owner");
    }
    const properties = [
      ["Description", "s", description], ["StopWhenUnneeded", "b", "false"],
      ["CPUAccounting", "b", "true"], ["MemoryAccounting", "b", "true"], ["TasksAccounting", "b", "true"],
      ["CPUQuotaPerSecUSec", "t", String(resources.cpuMillis * 1000)],
      ["MemoryMax", "t", String(resources.memoryBytes)], ["MemorySwapMax", "t", "0"], ["TasksMax", "t", String(maxTasks)],
      ...(high ? [["MemoryHigh", "t", String(Math.floor(resources.memoryBytes * 0.75))]] : []),
    ];
    await execute("/usr/bin/busctl", [...scope, "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
      "StartTransientUnit", "ssa(sv)a(sa(sv))", slice, "fail", String(properties.length), ...properties.flat(), "0"], { env: managementEnv, timeout: 10_000, maxBuffer: 64 * 1024 });
    const cg = (await state(slice)).ControlGroup;
    if (!cg || !isAbsolute(cg) || cg.includes("..")) throw fault("SANDBOX_UNAVAILABLE", "Sandbox resource domain is unverified");
    const values = await Promise.all(["cpu.max", "memory.max", "pids.max"].map(n => readFile("/sys/fs/cgroup" + cg + "/" + n, "utf8")));
    const [quota, period] = values[0]!.trim().split(/\s+/u).map(Number);
    if (!quota || !period || Math.abs(quota / period * 1000 - resources.cpuMillis) > 1 || Number(values[1]!.trim()) !== resources.memoryBytes || Number(values[2]!.trim()) !== maxTasks) {
      throw fault("SANDBOX_UNAVAILABLE", "Sandbox resource limits were not applied");
    }
  };
  return {
    id: "linux-systemd",
    async initialize(input, signal) {
      if (policy) throw fault("SANDBOX_POLICY", "Sandbox backend already belongs to a Host");
      const identityAllowed = options.inheritHostIdentity === true
        ? options.uid === process.getuid?.() && options.gid === process.getgid?.()
        : positive(options.uid) && positive(options.gid);
      if (process.platform !== "linux" || !identityAllowed || ![tasks, poolTasks, descriptors].every(positive) || poolTasks < tasks
        || options.userNamespaceMapping !== undefined && (typeof options.userNamespaceMapping !== "boolean" || options.userNamespaceMapping && !(options.inheritHostIdentity && options.uid === 0))
        || !["system", "user"].includes(options.scope) || options.scope === "user" && (options.uid !== process.getuid?.() || options.gid !== process.getgid?.())) {
        throw fault("SANDBOX_UNAVAILABLE", "Local sandbox requires Linux systemd and an unprivileged workload identity");
      }
      try {
        await access("/sys/fs/cgroup/cgroup.controllers");
        const version = (await execute("/usr/bin/systemd-run", ["--version"], { env: managementEnv, timeout: 5000 })).stdout;
        if (!/^systemd \d+/u.test(version) || Number(/^systemd (\d+)/u.exec(version)?.[1]) < 254) throw Error();
      } catch { throw fault("SANDBOX_UNAVAILABLE", "Local sandbox requires cgroup v2 and systemd 254 or newer"); }
      if (options.parentSlice !== undefined) {
        if (typeof options.parentSlice !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}\.slice$/u.test(options.parentSlice)) throw fault("SANDBOX_POLICY", "Invalid shared workload slice");
        const parent = await state(options.parentSlice), cg = parent.ControlGroup;
        if (parent.ActiveState !== "active" || !cg || !isAbsolute(cg) || cg.includes("..")) throw fault("SANDBOX_UNAVAILABLE", "Shared workload resource domain is unavailable");
        const values = await Promise.all(["cpu.max", "memory.max", "pids.max"].map(n => readFile("/sys/fs/cgroup" + cg + "/" + n, "utf8")));
        const [quota, period] = values[0]!.trim().split(/\s+/u).map(Number);
        if (!positive(quota!) || !positive(period!) || !positive(Number(values[1])) || !positive(Number(values[2]))) throw fault("SANDBOX_POLICY", "Shared workload domain must have finite CPU, memory and task limits");
      }
      if (options.ownerUnit !== undefined) {
        if (typeof options.ownerUnit !== "string" || !/^[A-Za-z0-9_.@-]{1,192}\.service$/u.test(options.ownerUnit)) throw fault("SANDBOX_POLICY", "Invalid execution owner unit");
        const owner = await state(options.ownerUnit);
        if (owner.PrivateTmp === "yes") namespaceProperties = ["--property=JoinsNamespaceOf=" + options.ownerUnit, "--property=PrivateTmp=yes"];
        const location = (await readFile("/proc/self/cgroup", "utf8")).trim().split("\n").find(line => line.startsWith("0::"))?.slice(3);
        if (owner.ActiveState !== "active" || !owner.ControlGroup || !location || !(location === owner.ControlGroup || location.startsWith(owner.ControlGroup + "/"))) {
          throw fault("SANDBOX_UNAVAILABLE", "Execution owner does not match the sandbox controller");
        }
      }
      policy = input; poolSlice = (options.parentSlice?.slice(0, -6) ?? "opencraft-sandbox") + "-" + input.id + ".slice";
      // Inspect collision before assuming cleanup authority.
      if ((await state(poolSlice)).ControlGroup) throw fault("SANDBOX_UNAVAILABLE", "Sandbox pool has a retained owner; inspect before recovery");
      try { if (signal.aborted) throw Error(); await group(poolSlice, input.capacity, poolTasks, false); if (signal.aborted) throw Error(); owned = true; }
      catch {
        try { await stop(poolSlice); } catch { throw fault("SANDBOX_CLEANUP", "Sandbox pool initialization cleanup is unverified"); }
        throw fault("SANDBOX_UNAVAILABLE", "Sandbox pool limits could not be established");
      }
    },
    async create(identity: SandboxIdentity, resources: SandboxResources, signal: AbortSignal) {
      if (!owned || !policy || signal.aborted) throw new SandboxCreationFault("not-created");
      const slice = poolSlice.slice(0, -6) + "-" + identity.id + ".slice";
      try { await group(slice, resources, tasks, true); }
      catch {
        try { await stop(slice); } catch { throw new SandboxCreationFault("unknown"); }
        throw new SandboxCreationFault("not-created");
      }
      let closing = false, cleanup: Promise<void> | undefined, sequence = 0, uncertain = false;
      const starting = new Set<Promise<SandboxProcess>>();
      const privateFiles = new Set<string>();
      const running = new Map<string, { stop(): Promise<void>; exited: Promise<SandboxExit> }>();
      const start = async (command: SandboxCommand, onOutput?: (event: SandboxOutput) => void): Promise<SandboxProcess> => {
        if (closing || !isAbsolute(command.cwd) || command.command[0]!.startsWith("-")) throw fault("SANDBOX_START", "Invalid local sandbox command or closed environment");
        const id = identity.id + "-" + ++sequence, unit = "opencraft-sandbox-" + policy!.id + "-" + id + ".service";
        // The privileged launcher must never load task PATH/LD_PRELOAD/DBus settings.
        // PID1 reads selected values from a private file only for the limited unit.
        const inherited = await control(["show-environment"]);
        const unset = [...new Set([...inherited.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gmu)].map(m => m[1]!))].filter(key => !Object.hasOwn(command.env, key));
        const directory = await mkdtemp(join(tmpdir(), "opencraft-sandbox-env-")); privateFiles.add(directory);
        const environmentFile = join(directory, "environment");
        const environment = Object.entries(command.env).map(([key, value]) => key + '="' + value.replace(/["\\$`]/gu, char => "\\" + char) + '"\n').join("");
        await writeFile(environmentFile, environment, { mode: 0o600 });
        const args = [...scope, "--quiet", "--wait", command.terminal ? "--pty" : "--pipe", "--service-type=exec", "--expand-environment=no",
          "--unit=" + unit, "--slice=" + slice, "--working-directory=" + command.cwd, "--property=Description=" + description,
          "--property=EnvironmentFile=/proc/" + process.pid + "/root" + environmentFile, "--property=UnsetEnvironment=" + unset.join(" "), "--property=Restart=no",
          "--property=LimitNOFILE=" + descriptors, "--property=IOWeight=100", "--property=KillMode=control-group", "--property=TimeoutStopSec=3s",
          "--property=NoNewPrivileges=yes", "--property=CapabilityBoundingSet=" + (options.userNamespaceMapping ? "CAP_SETUID CAP_SETGID CAP_SETFCAP" : ""), "--property=ProtectControlGroups=yes", "--property=UMask=0077", "--property=OOMScoreAdjust=0",
          "--property=InaccessiblePaths=-/run/systemd/private -/run/dbus/system_bus_socket",
          ...namespaceProperties,
          ...(options.ownerUnit ? ["--property=BindsTo=" + options.ownerUnit, "--property=After=" + options.ownerUnit] : []),
          ...(options.scope === "system" ? ["--uid=" + options.uid, "--gid=" + options.gid] : []),
          "--", "/usr/bin/env", "--", ...command.command];
        let resolve!: (exit: SandboxExit) => void, reject!: (error: unknown) => void;
        const exited = new Promise<SandboxExit>((yes, no) => { resolve = yes; reject = no; });
        void exited.catch(() => {});
        let finished = false, launchFailed = false, observerFailed = false, ready = false, termination: Promise<void> | undefined;
        let killLauncher: () => void = () => {};
        const terminate = () => termination ??= (async () => { await stop(unit); if (!finished) killLauncher(); })();
        const output = (stream: "stdout" | "stderr", data: Uint8Array) => {
          try { onOutput?.({ stream, data }); }
          catch { observerFailed = true; if (ready) void terminate().catch(() => {}); }
        };
        const finish = (code: number | null, signal?: string) => {
          finished = true;
          void terminate().then(() => {
            running.delete(id);
            if (observerFailed) reject(fault("SANDBOX_START", "Sandbox output consumer failed"));
            else resolve({ code, ...(signal ? { signal } : {}) });
          }, () => reject(fault("SANDBOX_CLEANUP", "Sandbox command cleanup is unverified")));
        };
        let writeStdin: (data: Uint8Array) => Promise<void>, closeStdin: (() => Promise<void>) | undefined, resize: ((size: { cols: number; rows: number }) => Promise<void>) | undefined;
        if (command.terminal) {
          const { spawn: spawnPty } = await import("node-pty");
          if (closing) throw fault("SANDBOX_CLOSED", "Sandbox closed before terminal creation");
          const pty = spawnPty("/usr/bin/systemd-run", args, { cwd: "/", env: managementEnv as Record<string, string>, ...command.terminal, name: "xterm-256color" });
          killLauncher = () => { try { pty.kill(); } catch {} };
          pty.onData(data => output("stdout", Buffer.from(data, "utf8")));
          pty.onExit(event => finish(event.exitCode, event.signal ? String(event.signal) : undefined));
          writeStdin = async data => { try { pty.write(Buffer.from(data)); } catch { throw fault("SANDBOX_START", "Sandbox stdin is unavailable"); } };
          resize = async size => {
            if (![size.cols, size.rows].every(v => Number.isInteger(v) && v > 0 && v <= 1000)) throw fault("SANDBOX_POLICY", "Invalid sandbox terminal size");
            try { pty.resize(size.cols, size.rows); } catch { throw fault("SANDBOX_START", "Sandbox terminal resize failed"); }
          };
        } else {
          const child = spawn("/usr/bin/systemd-run", args, { cwd: "/", env: managementEnv, stdio: ["pipe", "pipe", "pipe"] });
          killLauncher = () => { child.kill("SIGTERM"); };
          child.stdout.on("data", data => output("stdout", data)); child.stderr.on("data", data => output("stderr", data));
          child.once("error", () => { launchFailed = true; finish(null); });
          child.once("close", (code, signal) => { if (!finished) finish(code, signal ?? undefined); });
          child.stdin.on("error", () => {}); // write callback still rejects its caller.
          writeStdin = data => new Promise<void>((yes, no) => child.stdin.write(Buffer.from(data), error => error ? no(fault("SANDBOX_START", "Sandbox stdin failed")) : yes()));
          closeStdin = () => new Promise<void>((yes, no) => {
            if (child.stdin.destroyed || child.stdin.writableEnded) { yes(); return; }
            child.stdin.end((error?: Error | null) => error ? no(fault("SANDBOX_START", "Sandbox stdin could not close")) : yes());
          });
        }
        running.set(id, { stop: terminate, exited });
        // Close cannot race a launcher whose StartTransientUnit has not reached PID1.
        const deadline = Date.now() + 15_000;
        try {
          while (!finished) {
            const current = await state(unit);
            if (current.LoadState === "loaded" && ["active", "failed"].includes(current.ActiveState ?? "")) break;
            if (Date.now() >= deadline) throw Error();
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        } catch {
          uncertain = true; killLauncher();
          throw fault("SANDBOX_START", "Sandbox command creation is unconfirmed; environment retained");
        }
        ready = true;
        await rm(directory, { recursive: true }); privateFiles.delete(directory);
        if (launchFailed || closing || observerFailed) { await terminate(); throw fault("SANDBOX_START", "Sandbox command could not start or was cancelled"); }
        const common = { id, exited, writeStdin, terminate };
        return resize ? { ...common, kind: "terminal", resize } : { ...common, kind: "process", closeStdin: closeStdin! };
      };
      const environment: SandboxEnvironment = {
        resources: Object.freeze({ ...resources }), capabilities: { terminal: true }, processLimits: { tasks, fileDescriptorsPerProcess: descriptors },
        spawn(command, onOutput) {
          if (closing) return Promise.reject(fault("SANDBOX_CLOSED", "Sandbox environment is closed"));
          const operation = start(command, onOutput).catch(error => {
            if (error instanceof SandboxFault) throw error;
            throw fault("SANDBOX_START", "Execution could not start in the selected environment");
          }); starting.add(operation);
          void operation.finally(() => starting.delete(operation)).catch(() => {});
          return operation;
        },
        close() {
          if (cleanup) return cleanup;
          closing = true;
          return cleanup = (async () => {
            await Promise.allSettled([...starting]);
            const results = await Promise.allSettled([...running.values()].map(p => p.stop()));
            if (results.some(r => r.status === "rejected")) throw fault("SANDBOX_CLEANUP", "Sandbox commands could not be stopped");
            await stop(slice);
            if (uncertain) throw fault("SANDBOX_CLEANUP", "Sandbox had an unconfirmed command creation; budget retained");
            for (const directory of privateFiles) { await rm(directory, { recursive: true }); privateFiles.delete(directory); }
            environments.delete(environment);
          })();
        },
      };
      environments.add(environment);
      return environment;
    },
    async close() {
      if (!owned) return;
      if (environments.size) throw fault("SANDBOX_CLEANUP", "Sandbox environments still own this backend");
      await stop(poolSlice); owned = false;
    },
  };
}
