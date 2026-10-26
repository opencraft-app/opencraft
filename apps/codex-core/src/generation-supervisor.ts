import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readlink, stat, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { CodexCoreControlClient, type CodexAppServerHealth } from "@opencraft/account-pool-host";
import { generationDirectory } from "./generation-files.js";
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
}
export interface GenerationSupervisor {
  start(generation: GenerationRecord, validation?: { homeCopy: string }): Promise<CodexAppServerHealth>;
  discardUnready(generation: GenerationRecord): Promise<void>;
  identify(generation: GenerationRecord, health: CodexAppServerHealth): Promise<GenerationProcessIdentity>;
  stop(generation: GenerationRecord, identity: GenerationProcessIdentity): Promise<void>;
  processesQuiet(identity: GenerationProcessIdentity): Promise<boolean>;
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
    const file = await stat(g.executable, { bigint: true });
    const stamp = JSON.stringify([pid, ownerStart, h.codexPid, nativeStart, g.executable, String(file.ino), String(file.size), String(file.mtimeNs), String(file.ctimeNs)]);
    const cached = this.identities.get(g.id);
    if (cached?.stamp === stamp) return cached.identity;
    const executable = await readlink(`/proc/${h.codexPid}/exe`);
    const expected = createHash("sha256").update(await readFile(g.executable)).digest("hex");
    const actual = createHash("sha256").update(await readFile(`/proc/${h.codexPid}/exe`)).digest("hex");
    if (actual !== expected) throw new Error("Generation CLI differs from its fixed executable");
    const cliVersion = (await execute(executable, ["--version"], { uid: g.executionUid ?? process.getuid!(), gid: g.executionGid ?? process.getgid!(), cwd: g.cwd,
      env: { PATH: "/usr/bin:/bin", HOME: g.runtimeDataDirectory, CODEX_HOME: `${g.runtimeDataDirectory}/runtime`, TMPDIR: `${g.runtimeDataDirectory}/tmp` } })).stdout.trim();
    const identity = { ownerPid: pid, ownerStart, nativePid: h.codexPid, nativeStart, cliSha256: actual, cliVersion, unit: this.unit(g) };
    this.identities.set(g.id, { stamp, identity }); return identity;
  }
  async stop(g: GenerationRecord, identity: GenerationProcessIdentity): Promise<void> {
    const unit = this.unit(g);
    const state = await this.unitState(unit);
    if (state.pid === 0) {
      let oldNativeAlive = false;
      try { const value = await readFile(`/proc/${identity.nativePid}/stat`, "utf8"); oldNativeAlive = value.slice(value.lastIndexOf(")") + 1).trim().split(/\s+/u)[19] === identity.nativeStart; }
      catch (reason) { if (!["ENOENT", "ESRCH"].includes((reason as NodeJS.ErrnoException).code ?? "")) throw reason; }
      if (oldNativeAlive) throw new Error("Generation native process outlived its unit");
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
        if (!(moduleIndex >= 0 && args[moduleIndex + 1] === "agent.transports.hermes_tools_mcp_server") && executable !== `${nativeDirectory}/codex-code-mode-host`) return false;
        pending.push(Number(child));
      }
    }
    return true;
  }
}
