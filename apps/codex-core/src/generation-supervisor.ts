import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readlink, stat, readdir, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { CodexCoreControlClient, type CodexAppServerHealth } from "@opencraft/account-pool-host";
import { generationDirectory } from "./generation-files.js";
import { generationArtifactDigest } from "./generation-artifact-digest.js";
import type { GenerationRecord } from "./generation-registry.js";

const execute = promisify(execFile);
export interface GenerationProcessIdentity {
  readonly ownerPid: number;
  readonly ownerStart: string;
  readonly nativePid: number;
  readonly nativeStart: string;
  readonly cliSha256: string;
  readonly cliVersion: string;
  readonly unit: string;
  readonly launcher?: { readonly nodeSha256: string; readonly entrypointSha256: string; readonly wrapperSha256: string;
    readonly childPid: number; readonly childStart: string; readonly childExecutable: string };
}
export interface GenerationSupervisor {
  inspect?(generation: GenerationRecord): Promise<CodexAppServerHealth>;
  start(generation: GenerationRecord, validation?: { homeCopy: string }): Promise<CodexAppServerHealth>;
  discardUnready(generation: GenerationRecord): Promise<void>;
  identify(generation: GenerationRecord, health: CodexAppServerHealth): Promise<GenerationProcessIdentity>;
  verifyHostRestart?(generation: GenerationRecord, health: CodexAppServerHealth, identity: GenerationProcessIdentity): Promise<unknown>;
  stop(generation: GenerationRecord, identity: GenerationProcessIdentity): Promise<void>;
  processesQuiet(identity: GenerationProcessIdentity): Promise<boolean>;
}

export async function collectDelegatedOwnerPids(root: string, io = {
  members: (path: string) => readFile(`${path}/cgroup.procs`, "utf8"),
  children: async (path: string) => (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name),
}): Promise<Set<number> | null> {
  const snapshot = async () => {
    const records: [string, string[], number[]][] = [];
    const members = new Set<number>();
    const collect = async (path: string): Promise<void> => {
      const children = (await io.children(path)).sort();
      const pids = (await io.members(path)).trim().split(/\s+/u).filter(Boolean).map(Number).sort((a, b) => a - b);
      for (const pid of pids) {
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid delegated cgroup member");
        members.add(pid);
      }
      records.push([path, children, pids]);
      for (const child of children) await collect(`${path}/${child}`);
    };
    await collect(root);
    return { signature: JSON.stringify(records), members };
  };
  const first = await snapshot(), second = await snapshot();
  return first.signature === second.signature ? second.members : null;
}

/** Units are siblings of the routing owner, so its replacement cannot kill native tasks. */
export class SystemdGenerationSupervisor implements GenerationSupervisor {
  private readonly prefix: string;
  private readonly identities = new Map<string, { stamp: string; identity: GenerationProcessIdentity }>();
  constructor(private readonly options: {
    registryDirectory: string; coreEndpoint: string; dataDirectory: string; tokenFile: string; token: string;
    scope: "user" | "system";
  }) { this.prefix = createHash("sha256").update(options.registryDirectory).digest("hex").slice(0, 12); }
  private scope(): string[] { return this.options.scope === "user" ? ["--user"] : []; }
  private unit(g: GenerationRecord): string { return g.externalUnit ?? `opencraft-codex-${this.prefix}-${g.id}.service`; }
  private async unitState(unit: string): Promise<{ pid: number; active: string; file: string }> {
    const output = (await execute("systemctl", [...this.scope(), "show", "--property=LoadState", "--property=ActiveState", "--property=MainPID", "--property=UnitFileState", "--", unit])).stdout;
    const values = Object.fromEntries(output.trim().split("\n").map(line => { const split = line.indexOf("="); return [line.slice(0, split), line.slice(split + 1)]; }));
    const pid = Number(values.MainPID);
    if (!Number.isSafeInteger(pid) || pid < 0 || !values.LoadState || !values.ActiveState) throw new Error("Generation unit state is unverified");
    return { pid, active: values.ActiveState, file: values.UnitFileState ?? "" };
  }
  private async disableBoot(unit: string, fileState: string): Promise<void> {
    if (["enabled", "enabled-runtime"].includes(fileState)) await execute("systemctl", [...this.scope(), "disable", "--", unit]);
  }
  async inspect(g: GenerationRecord): Promise<CodexAppServerHealth> { return this.health(g); }
  private async health(g: GenerationRecord): Promise<CodexAppServerHealth> {
    return new CodexCoreControlClient(g.endpoint, this.options.token).appServerHealth();
  }
  async start(g: GenerationRecord, validation?: { homeCopy: string }): Promise<CodexAppServerHealth> {
    try { return await this.health(g); } catch { /* Readiness below never signals an existing unit. */ }
    const unit = this.unit(g);
    const status = await this.unitState(unit);
    if (!["active", "activating", "reloading"].includes(status.active)) {
      if (g.externalUnit) {
        if (g.state === "candidate") throw new Error("An adopted generation must already be running");
        await execute("systemctl", [...this.scope(), "start", "--", unit]);
      } else {
      if ([g.node, g.bundle, g.executable, g.cwd, g.runtimeDataDirectory, g.endpoint, this.options.coreEndpoint, this.options.dataDirectory, this.options.tokenFile].some(path => path.startsWith("/tmp/"))) throw new Error("Generation payload, runtime and account endpoints must be outside private /tmp");
      const managed = new Set(["NOTIFY_SOCKET", "LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES", "INVOCATION_ID", "MANAGERPID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "WATCHDOG_PID", "WATCHDOG_USEC"]);
      const identity = { uid: g.executionUid ?? process.getuid!(), gid: g.executionGid ?? process.getgid!() };
      const sameUser = identity.uid === process.getuid!();
      const publicEnvironment = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"]);
      const environment = Object.keys(process.env).filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && !managed.has(name)
        && (sameUser || publicEnvironment.has(name))).map(name => `--setenv=${name}`);
      const temporary = `${g.runtimeDataDirectory}/tmp`; generationDirectory(temporary, identity.uid, identity.gid);
      // NAME without '=value' copies the private process environment; no secret is an argv value.
      await execute("systemd-run", [...this.scope(), "--quiet", "--collect", "--no-block", "--service-type=exec", `--unit=${unit}`,
        "--property=PrivateTmp=yes", "--property=Restart=on-failure", "--property=RestartSec=3", "--property=KillMode=control-group", "--property=TimeoutStopSec=infinity",
        "--property=UMask=0077", `--uid=${identity.uid}`, `--gid=${identity.gid}`, `--working-directory=${g.cwd}`,
        ...(validation ? [`--property=BindPaths=${validation.homeCopy}:${g.runtimeDataDirectory}/runtime`] : []), ...environment, `--setenv=TMPDIR=${temporary}`, "--", g.node, g.bundle,
        "--endpoint", g.endpoint, "--core-endpoint", this.options.coreEndpoint, "--token-file", this.options.tokenFile,
        "--data-directory", this.options.dataDirectory, "--runtime-data-directory", g.runtimeDataDirectory,
        "--runtime-directory", g.cwd, "--codex-executable", g.executable]);
      }
    }
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { return await this.health(g); } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    throw new Error("Generation did not become ready; its unit is retained for inspection");
  }
  async discardUnready(g: GenerationRecord): Promise<void> {
    if (g.externalUnit || g.state !== "candidate") throw new Error("Only an unadmitted owned candidate can be discarded");
    try { await execute("systemctl", [...this.scope(), "stop", "--", this.unit(g)], { timeout: 0 }); }
    catch (reason) {
      const state = await this.unitState(this.unit(g));
      if (state.pid !== 0 || !["inactive", "failed"].includes(state.active)) throw reason;
    }
  }
  async identify(g: GenerationRecord, h: CodexAppServerHealth): Promise<GenerationProcessIdentity> {
    const pid = (await this.unitState(this.unit(g))).pid;
    if (pid !== h.pid || pid < 1) throw new Error("Generation unit owner identity mismatch");
    const start = async (pid: number) => { const value = await readFile(`/proc/${pid}/stat`, "utf8"); return value.slice(value.lastIndexOf(")") + 1).trim().split(/\s+/u)[19]!; };
    for (const currentPid of [pid, h.codexPid]) {
      const owner = await stat(`/proc/${currentPid}`);
      if (owner.uid !== (g.executionUid ?? process.getuid!()) || owner.gid !== (g.executionGid ?? process.getgid!())) throw new Error("Generation execution identity differs from its fixed UID/GID");
    }
    const ownerStart = await start(pid), nativeStart = await start(h.codexPid);
    if (g.nativeLauncher) {
      const digest = (path: string) => generationArtifactDigest.sha256(path);
      const args = (await readFile(`/proc/${h.codexPid}/cmdline`, "utf8")).split("\0");
      const ownerArgs = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0"), selector = ownerArgs.indexOf("--codex-executable");
      if (selector < 0 || await realpath(ownerArgs[selector + 1]!) !== await realpath(g.executable)
        || !args[1] || await realpath(args[1]) !== await realpath(g.nativeLauncher.entrypoint)
        || args[2] !== "app-server") throw new Error("Generation CLI launcher command differs from its fixed definition");
      const nodeSha256 = await digest(g.node);
      if (await digest(`/proc/${h.codexPid}/exe`) !== nodeSha256) throw new Error("Generation CLI launcher Node differs from its fixed executable");
      const children = new Set<string>();
      for (const task of await readdir(`/proc/${h.codexPid}/task`)) {
        for (const child of (await readFile(`/proc/${h.codexPid}/task/${task}/children`, "utf8")).trim().split(/\s+/u).filter(Boolean)) children.add(child);
      }
      if (children.size !== 1) throw new Error("Generation CLI launcher child is missing or ambiguous");
      const childPid = Number([...children][0]), childStart = await start(childPid), childOwner = await stat(`/proc/${childPid}`);
      if (childOwner.uid !== (g.executionUid ?? process.getuid!()) || childOwner.gid !== (g.executionGid ?? process.getgid!())) throw new Error("Generation CLI child execution identity differs");
      const childExecutable = await realpath(g.nativeLauncher.executable), cliSha256 = await digest(childExecutable);
      if (await realpath(`/proc/${childPid}/exe`) !== childExecutable || await digest(`/proc/${childPid}/exe`) !== cliSha256) throw new Error("Generation CLI child differs from its fixed executable");
      const cliVersion = (await execute(childExecutable, ["--version"], { uid: childOwner.uid, gid: childOwner.gid, cwd: g.cwd,
        env: { PATH: "/usr/bin:/bin", HOME: g.runtimeDataDirectory, CODEX_HOME: `${g.runtimeDataDirectory}/runtime`, TMPDIR: `${g.runtimeDataDirectory}/tmp` } })).stdout.trim();
      if (await start(pid) !== ownerStart || await start(h.codexPid) !== nativeStart || await start(childPid) !== childStart) throw new Error("Generation CLI launcher changed during observation");
      return { ownerPid: pid, ownerStart, nativePid: h.codexPid, nativeStart, cliSha256, cliVersion, unit: this.unit(g),
        launcher: { nodeSha256, entrypointSha256: await digest(g.nativeLauncher.entrypoint), wrapperSha256: await digest(g.executable), childPid, childStart, childExecutable } };
    }
    const file = await stat(g.executable, { bigint: true });
    const stamp = JSON.stringify([pid, ownerStart, h.codexPid, nativeStart, g.executable, String(file.ino), String(file.size), String(file.mtimeNs), String(file.ctimeNs)]);
    const cached = this.identities.get(g.id);
    if (cached?.stamp === stamp) return cached.identity;
    const executable = await readlink(`/proc/${h.codexPid}/exe`);
    const expected = await generationArtifactDigest.sha256(g.executable);
    const actual = await generationArtifactDigest.sha256(`/proc/${h.codexPid}/exe`);
    if (actual !== expected) throw new Error("Generation CLI differs from its fixed executable");
    const cliVersion = (await execute(executable, ["--version"], { uid: g.executionUid ?? process.getuid!(), gid: g.executionGid ?? process.getgid!(), cwd: g.cwd,
      env: { PATH: "/usr/bin:/bin", HOME: g.runtimeDataDirectory, CODEX_HOME: `${g.runtimeDataDirectory}/runtime`, TMPDIR: `${g.runtimeDataDirectory}/tmp` } })).stdout.trim();
    const identity = { ownerPid: pid, ownerStart, nativePid: h.codexPid, nativeStart, cliSha256: actual, cliVersion, unit: this.unit(g) };
    this.identities.set(g.id, { stamp, identity }); return identity;
  }
  /** A new kernel identity is adopted only after observing its actual program
   * and Native HOME. Hashing the registered files alone is not this proof. */
  async verifyHostRestart(g: GenerationRecord, h: CodexAppServerHealth, identity: GenerationProcessIdentity) {
    const args = (await readFile(`/proc/${identity.ownerPid}/cmdline`, "utf8")).split("\0").filter(Boolean);
    const selector = (name: string) => {
      const indices = args.flatMap((value, index) => value === name || value.startsWith(name + "=") ? [index] : []);
      if (!indices.length) return undefined;
      if (indices.length !== 1 || args[indices[0]!] !== name || !args[indices[0]! + 1] || args[indices[0]! + 1]!.startsWith("--")) throw Error("Host APP selector is ambiguous");
      return args[indices[0]! + 1]!;
    };
    const samePath = async (actual: string | undefined, expected: string) => !!actual && actual.startsWith("/") && await realpath(actual) === await realpath(expected);
    const digest = (path: string) => generationArtifactDigest.sha256(path);
    if (h.pid !== identity.ownerPid || h.codexPid !== identity.nativePid || !await samePath(args[1], g.bundle)
      || !await samePath(`/proc/${identity.ownerPid}/exe`, g.node)
      || await digest(`/proc/${identity.ownerPid}/exe`) !== await digest(g.node)) throw Error("Host APP program differs from its fixed definition");
    const runtimeDataDirectory = await realpath(g.runtimeDataDirectory), codexHome = await realpath(`${runtimeDataDirectory}/runtime`);
    if (!await samePath(selector("--runtime-data-directory") ?? selector("--data-directory"), runtimeDataDirectory)
      || !await samePath(selector("--runtime-directory"), g.cwd)
      || !await samePath(selector("--codex-executable"), g.executable)
      || h.runtimeDataDirectory !== undefined && !await samePath(h.runtimeDataDirectory, runtimeDataDirectory)
      || h.codexHome !== undefined && !await samePath(h.codexHome, codexHome)) throw Error("Host APP HOME or launch selectors differ from its fixed definition");
    for (const [pid, parent, executable, started] of [
      [identity.nativePid, identity.ownerPid, g.nativeLauncher ? g.node : g.executable, identity.nativeStart],
      ...(identity.launcher ? [[identity.launcher.childPid, identity.nativePid, identity.launcher.childExecutable, identity.launcher.childStart]] : []),
    ] as [number, number, string, string][]) {
      const fields = (await readFile(`/proc/${pid}/stat`, "utf8")).replace(/^.*\)\s/u, "").trim().split(/\s+/u);
      const homes = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0").filter(entry => entry.startsWith("CODEX_HOME="));
      if (Number(fields[1]) !== parent || fields[19] !== started || !await samePath(`/proc/${pid}/exe`, executable)
        || homes.length !== 1 || !await samePath(homes[0]!.slice("CODEX_HOME=".length), codexHome)) throw Error("Host Native parent, program or HOME differs from its fixed definition");
    }
    if (JSON.stringify(await this.identify(g, h)) !== JSON.stringify(identity)) throw Error("Host APP changed during program observation");
    return { nodeSha256: await digest(g.node), bundleSha256: await digest(g.bundle), runtimeDataDirectory, codexHome };
  }
  async stop(g: GenerationRecord, identity: GenerationProcessIdentity): Promise<void> {
    const unit = this.unit(g);
    const state = await this.unitState(unit);
    if (state.pid === 0) {
      for (const [nativePid, nativeStart] of [[identity.nativePid, identity.nativeStart], ...(identity.launcher ? [[identity.launcher.childPid, identity.launcher.childStart]] : [])]) {
        let oldNativeAlive = false;
        try { const value = await readFile(`/proc/${nativePid}/stat`, "utf8"); oldNativeAlive = value.slice(value.lastIndexOf(")") + 1).trim().split(/\s+/u)[19] === nativeStart; }
        catch (reason) { if (!["ENOENT", "ESRCH"].includes((reason as NodeJS.ErrnoException).code ?? "")) throw reason; }
        if (oldNativeAlive) throw new Error("Generation native process outlived its unit");
      }
      if (g.externalUnit) await this.disableBoot(unit, state.file);
      return;
    }
    const current = await this.identify(g, await this.health(g));
    if (JSON.stringify(current) !== JSON.stringify(identity) && (g.state !== "retiring" || current.unit !== identity.unit || current.cliSha256 !== identity.cliSha256)) throw new Error("Generation changed before retirement");
    await execute("systemctl", [...this.scope(), "stop", "--", current.unit], { timeout: 0 });
    const after = await this.unitState(current.unit);
    if (after.pid !== 0 || !["inactive", "failed"].includes(after.active)) throw new Error("Generation owner is still running");
    if (g.externalUnit) await this.disableBoot(current.unit, state.file);
  }
  async processesQuiet(identity: GenerationProcessIdentity): Promise<boolean> {
    const pending = [identity.nativePid];
    let launcherSeen = !identity.launcher;
    const allowed = new Set([identity.ownerPid, identity.nativePid]);
    const nativeDirectory = (await readlink(`/proc/${identity.nativePid}/exe`)).replace(/\/[^/]+$/u, "");
    while (pending.length) {
      const parent = pending.pop()!;
      const children = new Set<string>();
      for (const task of await readdir(`/proc/${parent}/task`)) {
        try { for (const child of (await readFile(`/proc/${parent}/task/${task}/children`, "utf8")).trim().split(/\s+/u).filter(Boolean)) children.add(child); }
        catch (reason) { if (!["ENOENT", "ESRCH"].includes((reason as NodeJS.ErrnoException).code ?? "")) throw reason; }
      }
      for (const child of children) {
        let args: string[], executable: string;
        try { args = (await readFile(`/proc/${child}/cmdline`, "utf8")).split("\0"); executable = await readlink(`/proc/${child}/exe`); }
        catch (reason) { if (["ENOENT", "ESRCH"].includes((reason as NodeJS.ErrnoException).code ?? "")) continue; throw reason; }
        const moduleIndex = args.indexOf("-m");
        let launcherChild = false;
        if (identity.launcher && Number(child) === identity.launcher.childPid && executable === identity.launcher.childExecutable) {
          const value = await readFile(`/proc/${child}/stat`, "utf8"), started = value.slice(value.lastIndexOf(")") + 1).trim().split(/\s+/u)[19];
          launcherChild = started === identity.launcher.childStart && await generationArtifactDigest.sha256(`/proc/${child}/exe`) === identity.cliSha256;
          if (launcherChild) launcherSeen = true;
        }
        const codeModeDirectory = identity.launcher ? identity.launcher.childExecutable.replace(/\/[^/]+$/u, "") : nativeDirectory;
        if (!launcherChild && !(moduleIndex >= 0 && args[moduleIndex + 1] === "agent.transports.hermes_tools_mcp_server") && executable !== `${codeModeDirectory}/codex-code-mode-host`) return false;
        allowed.add(Number(child));
        pending.push(Number(child));
      }
    }
    // A delegated tool may have daemonized and lost its Native parent. Keep
    // retirement fail-closed over the whole owning service, not just the tree.
    const relative = (await readFile(`/proc/${identity.nativePid}/cgroup`, "utf8")).trim().match(/^0::(\/[^\n]+)$/mu)?.[1];
    const delegated = relative?.match(/^(\/.*\.service)\/app(?:\/.*)?$/u)?.[1];
    if (delegated) {
      const members = await collectDelegatedOwnerPids(`/sys/fs/cgroup${delegated}`);
      if (!members || [...members].some(pid => !allowed.has(pid))) return false;
    }
    return launcherSeen;
  }
}
