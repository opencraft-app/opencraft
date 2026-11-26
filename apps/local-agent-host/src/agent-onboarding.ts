import { AGENT_PROVIDERS, externalSource } from "@opencraft/agent-bridge-protocol";
import type { OnboardingActivity, OnboardingAgentId, OnboardingAgentSnapshot, OnboardingSnapshot } from "@opencraft/appserver-protocol";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

type ProviderEntry = (typeof AGENT_PROVIDERS)[number];

/** Engine identity per agent, from the shared provider catalog. */
export const ONBOARDING_AGENT_ENGINES = Object.fromEntries(AGENT_PROVIDERS.map(provider => [provider.id, provider.engineId])) as
  { readonly [P in ProviderEntry as P["id"]]: P["engineId"] };

/** Local CLIs the first-run agent step can see: each provider's user-installed source. */
export const ONBOARDING_AGENTS = AGENT_PROVIDERS.flatMap(provider => {
  const source = externalSource(provider);
  return source ? [{
    id: provider.id, name: provider.displayName, commands: source.commands, versionArgs: source.versionArgs,
    statusArgs: source.statusArgs, signInArgs: source.signInArgs, signInEnv: source.signInEnv,
    installPackage: source.installPackage, installUrl: source.installUrl,
  }] : [];
});

export type { OnboardingActivity, OnboardingAgentId, OnboardingAgentSnapshot, OnboardingSnapshot };

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface ManagedProcess {
  kill(): void;
  readonly exited: Promise<{ code: number | null }>;
  onOutput(listener: (chunk: string) => void): void;
}

export interface OnboardingDeps {
  env: NodeJS.ProcessEnv;
  homedir: string;
  exists(file: string): Promise<boolean>;
  cursorVersions(): Promise<readonly string[]>;
  nodeBinDirectories?(): Promise<readonly string[]>;
  exec(command: string, args: readonly string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<CommandResult>;
  spawn(command: string, args: readonly string[], env: NodeJS.ProcessEnv): ManagedProcess;
}

const STATUS_TIMEOUT_MS = 8_000;
const INSTALL_TIMEOUT_MS = 180_000;
const SIGN_IN_TIMEOUT_MS = 300_000;
const LOG_LIMIT = 8_000;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;
const HYPERLINK = /\u001b\]8;[^;\u0007\u001b]*;(https:\/\/[^\u0007\u001b]+)(?:\u0007|\u001b\\)/u;
const URL = /https:\/\/[^\s\u0007\u001b"'<>]+/u;
const USER_CODE = /(?<![A-Za-z0-9-])[A-Z0-9]{4,6}-[A-Z0-9]{4,6}(?![A-Za-z0-9-])/u;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;

export function stripTerminal(text: string): string {
  return text.replace(OSC, "").replace(ANSI, "").replace(/\r/gu, "");
}

export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret)["'\s:=]+)[^\s"']+/giu, "$1[redacted]");
}

export function parseSignInOutput(output: string): { url: string | null; userCode: string | null } {
  const text = stripTerminal(output);
  const url = HYPERLINK.exec(output)?.[1] ?? URL.exec(text)?.[0] ?? null;
  const withoutUrls = text.replace(new RegExp(URL.source, "gu"), " ");
  return { url, userCode: USER_CODE.exec(withoutUrls)?.[0] ?? null };
}

export function interpretAuth(id: OnboardingAgentId, stdout: string, stderr: string, code: number): { authenticated: boolean | null; account: string | null } {
  const text = stripTerminal(`${stdout}\n${stderr}`).trim();
  if (id === "claude") {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as { loggedIn?: unknown };
        if (typeof parsed.loggedIn === "boolean") return { authenticated: parsed.loggedIn, account: null };
      } catch { /* Status text is not JSON. */ }
    }
  }
  if (!text) return { authenticated: null, account: null };
  const account = EMAIL.exec(text)?.[0] ?? null;
  if (/not (?:logged|signed) in|logged out|sign in required|authentication required/iu.test(text)) return { authenticated: false, account: null };
  if (/(?:^|[^a-z])(?:logged|signed) in/iu.test(text)) return { authenticated: true, account };
  return { authenticated: null, account: null };
}

function decodeJwtEmail(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { email?: unknown };
    return typeof payload?.email === "string" && EMAIL.test(payload.email) ? payload.email : null;
  } catch {
    return null;
  }
}

export async function readLocalCodexAuth(env: NodeJS.ProcessEnv, home: string): Promise<{ authenticated: true; account: string | null } | null> {
  if (env.OPENAI_API_KEY?.trim()) return { authenticated: true, account: null };
  const codexHome = env.CODEX_HOME?.trim() || join(home, ".codex");
  try {
    const parsed = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8")) as {
      OPENAI_API_KEY?: unknown;
      tokens?: { access_token?: unknown; refresh_token?: unknown; id_token?: unknown };
    };
    const apiKey = typeof parsed?.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim().length > 0;
    const accessToken = typeof parsed?.tokens?.access_token === "string" && parsed.tokens.access_token.trim().length > 0;
    const refreshToken = typeof parsed?.tokens?.refresh_token === "string" && parsed.tokens.refresh_token.trim().length > 0;
    if (apiKey || accessToken || refreshToken) {
      return {
        authenticated: true,
        account: decodeJwtEmail(parsed?.tokens?.id_token) ?? decodeJwtEmail(parsed?.tokens?.access_token),
      };
    }
  } catch {
    /* Fall back to CLI status probe (for example macOS Keychain-only storage). */
  }
  return null;
}

export async function readLocalCursorAuth(env: NodeJS.ProcessEnv, home: string): Promise<{ authenticated: true; account: string | null } | null> {
  for (const candidate of [
    join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "cursor", "auth.json"),
    join(env.CURSOR_CONFIG_DIR?.trim() || join(home, ".cursor"), "cli-config.json"),
  ]) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as Record<string, any>;
      if (typeof parsed?.accessToken === "string" && parsed.accessToken.trim()) {
        return { authenticated: true, account: typeof parsed.email === "string" ? parsed.email : null };
      }
      const authInfo = parsed?.authInfo;
      if (authInfo && typeof authInfo === "object" && ((typeof authInfo.accessToken === "string" && authInfo.accessToken.trim()) || (typeof authInfo.email === "string" && authInfo.email.trim()))) {
        return { authenticated: true, account: typeof authInfo.email === "string" ? authInfo.email : null };
      }
    } catch {
      /* Ignore missing or unreadable local config. */
    }
  }
  return null;
}

const codeBuddyAuthCache = new Map<string, { at: number; authenticated: boolean }>();
async function probeCodeBuddyAcpAuth(executable: string, env: NodeJS.ProcessEnv): Promise<boolean | null> {
  if (env.CODEBUDDY_API_KEY?.trim()) return true;
  const cached = codeBuddyAuthCache.get(executable);
  if (cached && Date.now() - cached.at < 30_000) return cached.authenticated;
  return new Promise(resolvePromise => {
    let settled = false;
    const finish = (value: boolean | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof value === "boolean") codeBuddyAuthCache.set(executable, { at: Date.now(), authenticated: value });
      try { child.kill("SIGTERM"); } catch {}
      resolvePromise(value);
    };
    const child = spawn(executable, ["--acp"], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => finish(null), 5000);
    timer.unref();
    let buffer = "";
    let sentSession = false;
    child.once("error", () => finish(null));
    child.once("exit", () => finish(null));
    child.stdin.on("error", () => {});
    child.stderr.resume();
    child.stdout.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, any>;
          if (msg.id === 1 && msg.result && !sentSession) {
            sentSession = true;
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: homedir(), mcpServers: [] } }) + "\n");
          } else if (msg.id === 2) {
            if (msg.result?.sessionId) finish(true);
            else if (msg.error && (/auth/iu.test(String(msg.error.message ?? "")) || msg.error.data?.category === "auth")) finish(false);
            else finish(null);
          }
        } catch {}
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "opencraft", version: "1" } } }) + "\n");
  });
}

export function firstVersionLine(stdout: string): string | null {
  const line = stripTerminal(stdout).split("\n").map(item => item.trim()).find(Boolean);
  return line ? line.slice(0, 80) : null;
}

export async function resolveExecutable(commands: readonly string[], deps: Pick<OnboardingDeps, "env" | "homedir" | "exists" | "cursorVersions" | "nodeBinDirectories">): Promise<string | null> {
  const dirs = [...new Set([
    ...(deps.env.PATH ?? "").split(delimiter),
    dirname(process.execPath),
    join(deps.homedir, ".local", "bin"),
    join(deps.homedir, ".codebuddy", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter(Boolean))];
  for (const command of commands) {
    for (const dir of dirs) {
      const candidate = join(dir, command);
      if (await deps.exists(candidate)) return candidate;
    }
  }
  for (const dir of await deps.nodeBinDirectories?.() ?? []) {
    for (const command of commands) {
      const candidate = join(dir, command);
      if (await deps.exists(candidate)) return candidate;
    }
  }
  if (!commands.includes("cursor-agent")) return null;
  const versions = [...await deps.cursorVersions()].sort((left, right) => right.localeCompare(left));
  for (const version of versions) {
    const candidate = join(deps.homedir, ".local", "share", "cursor-agent", "versions", version, "cursor-agent");
    if (await deps.exists(candidate)) return candidate;
  }
  return null;
}

function definition(id: string) {
  return ONBOARDING_AGENTS.find(agent => agent.id === id);
}

function tail(text: string): string {
  const clean = redactSecrets(stripTerminal(text)).trim();
  return clean.length <= LOG_LIMIT ? clean : clean.slice(-LOG_LIMIT);
}

function failureMessage(log: string): string | null {
  const line = log.split("\n").map(item => item.trim()).find(item => item && !item.startsWith("$ "));
  return line ? line.slice(0, 180) : null;
}

interface LiveTask {
  kind: "sign-in" | "install";
  phase: "running" | "failed";
  message: string | null;
  log: string;
  process: ManagedProcess | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function activityOf(task: LiveTask | undefined): OnboardingActivity | null {
  if (!task) return null;
  const guide = task.kind === "sign-in" ? parseSignInOutput(task.log) : { url: null, userCode: null };
  return {
    kind: task.kind,
    phase: task.phase,
    message: task.message,
    url: guide.url,
    userCode: guide.userCode,
    log: tail(task.log),
  };
}

export class AgentOnboardingService {
  private readonly tasks = new Map<OnboardingAgentId, LiveTask>();
  private closed = false;

  constructor(private readonly deps: OnboardingDeps = createOnboardingDeps()) {}

  async status(): Promise<OnboardingSnapshot> {
    if (this.closed) throw new Error("Agent onboarding is closed");
    const agents = await Promise.all(ONBOARDING_AGENTS.map(agent => this.probe(agent)));
    return { agents };
  }

  async act(input: unknown): Promise<OnboardingSnapshot> {
    if (this.closed) throw new Error("Agent onboarding is closed");
    const params = input && typeof input === "object" ? input as { id?: unknown; action?: unknown } : {};
    const agent = definition(typeof params.id === "string" ? params.id : "");
    if (!agent) throw new Error("Unknown agent");
    const action = params.action;
    if (action === "cancel") this.clear(agent.id);
    else if (action === "sign-in") await this.start(agent, "sign-in");
    else if (action === "install") await this.start(agent, "install");
    else throw new Error("Unknown onboarding action");
    return this.status();
  }

  close(): void {
    this.closed = true;
    for (const id of [...this.tasks.keys()]) this.clear(id);
  }

  private clear(id: OnboardingAgentId): void {
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.timer) clearTimeout(task.timer);
    task.process?.kill();
    this.tasks.delete(id);
  }

  private async start(agent: (typeof ONBOARDING_AGENTS)[number], kind: "sign-in" | "install"): Promise<void> {
    const current = this.tasks.get(agent.id);
    if (current?.phase === "running") return;
    this.clear(agent.id);
    if (kind === "install" && agent.installPackage === null) throw new Error("This agent is installed from its own site");
    const executable = kind === "install"
      ? await resolveExecutable([process.platform === "win32" ? "npm.cmd" : "npm"], this.deps)
      : await resolveExecutable(agent.commands, this.deps);
    if (!executable) throw new Error(kind === "install" ? "npm is not available" : "Agent is not installed");
    const headlessLinuxCodex = kind === "sign-in" && agent.id === "codex" && process.platform === "linux" && !this.deps.env.DISPLAY && !this.deps.env.WAYLAND_DISPLAY;
    const args = kind === "install"
      ? ["install", "-g", agent.installPackage!]
      : headlessLinuxCodex
        ? [...agent.signInArgs, "--device-auth"]
        : agent.signInArgs;
    const env = { ...await localAgentEnvironment(this.deps, executable), ...agent.signInEnv };
    const child = this.deps.spawn(executable, args, env);
    const task: LiveTask = { kind, phase: "running", message: null, log: `$ ${args.join(" ")}\n`, process: child, timer: null };
    this.tasks.set(agent.id, task);
    child.onOutput(chunk => { task.log += chunk; });
    task.timer = setTimeout(() => this.fail(agent.id, "Timed out"), kind === "install" ? INSTALL_TIMEOUT_MS : SIGN_IN_TIMEOUT_MS);
    void child.exited.then(result => {
      if (this.tasks.get(agent.id) !== task) return;
      if (task.timer) clearTimeout(task.timer);
      task.process = null;
      task.timer = null;
      if (result.code === 0) this.tasks.delete(agent.id);
      else this.fail(agent.id, failureMessage(task.log) ?? `Exited with code ${result.code ?? "unknown"}`);
    });
  }

  private fail(id: OnboardingAgentId, message: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.timer) clearTimeout(task.timer);
    task.timer = null;
    task.process?.kill();
    task.process = null;
    task.phase = "failed";
    task.message = redactSecrets(message).slice(0, 180);
  }

  private async probe(agent: (typeof ONBOARDING_AGENTS)[number]): Promise<OnboardingAgentSnapshot> {
    const executable = await resolveExecutable(agent.commands, this.deps);
    const base = {
      id: agent.id,
      engineId: ONBOARDING_AGENT_ENGINES[agent.id],
      displayName: agent.name,
      installUrl: agent.installUrl,
      canInstallPackage: agent.installPackage !== null,
      activity: activityOf(this.tasks.get(agent.id)),
    };
    if (!executable) {
      return { ...base, installed: false, version: null, authenticated: null, account: null };
    }
    const runningSignIn = this.tasks.get(agent.id);
    if (runningSignIn?.phase === "running" && runningSignIn.kind === "sign-in") {
      return { ...base, installed: true, version: null, authenticated: null, account: null };
    }
    const isRealLocalDeps = this.deps.homedir === homedir();
    const localFastCodex = agent.id === "codex" && isRealLocalDeps ? await readLocalCodexAuth(this.deps.env, this.deps.homedir) : null;
    const localFastCursor = agent.id === "cursor" && isRealLocalDeps ? await readLocalCursorAuth(this.deps.env, this.deps.homedir) : null;
    const env = await localAgentEnvironment(this.deps, executable);
    const statusTimeout = 15_000;
    const skipStatusProcess = Boolean(localFastCodex);
    const [version, status] = await Promise.all([
      this.deps.exec(executable, agent.versionArgs, statusTimeout, env).catch(() => ({ stdout: "", stderr: "", code: 1 })),
      agent.statusArgs.length && !skipStatusProcess
        ? this.deps.exec(executable, agent.statusArgs, statusTimeout, env).catch(() => ({ stdout: "", stderr: "", code: 1 }))
        : Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    ]);
    const auth = localFastCodex
      ? localFastCodex
      : agent.id === "codebuddy"
        ? {
            authenticated: version.code !== 0
              ? null
              : isRealLocalDeps
                ? await probeCodeBuddyAcpAuth(executable, env)
                : interpretAuth(agent.id, status.stdout, status.stderr, status.code).authenticated,
            account: null,
          }
        : (() => {
            const interpreted = interpretAuth(agent.id, status.stdout, status.stderr, status.code);
            if (interpreted.authenticated === null && localFastCursor) return localFastCursor;
            return interpreted;
          })();
    return {
      ...base,
      installed: true,
      version: firstVersionLine(version.stdout),
      authenticated: auth.authenticated,
      account: auth.account,
    };
  }
}

export function augmentedAgentPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const extras = [
    dirname(process.execPath),
    join(home, ".local", "bin"),
    join(home, ".codebuddy", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const extra of extras) if (extra && !parts.includes(extra)) parts.unshift(extra);
  return parts.join(delimiter);
}
const augmentedPath = augmentedAgentPath;

/** GUI and service PATHs can omit the Node installation that owns an agent. */
export async function localAgentEnvironment(deps: Pick<OnboardingDeps,'env'|'homedir'|'nodeBinDirectories'>, executable: string): Promise<NodeJS.ProcessEnv> {
  const bins = await deps.nodeBinDirectories?.() ?? [];
  return {...deps.env, PATH:[...new Set([dirname(executable), ...augmentedPath(deps.env,deps.homedir).split(delimiter), ...bins])].join(delimiter)};
}

export function createOnboardingDeps(env: NodeJS.ProcessEnv = process.env): OnboardingDeps {
  const home = env.HOME || env.USERPROFILE || homedir();
  return {
    env,
    homedir: home,
    async exists(file) {
      try { await access(file, constants.X_OK); return true; } catch { return false; }
    },
    async cursorVersions() {
      try { return await readdir(join(home, ".local", "share", "cursor-agent", "versions")); }
      catch { return []; }
    },
    async nodeBinDirectories() {
      const root = join(env.NVM_DIR || join(home, '.nvm'), 'versions', 'node');
      try {
        return (await readdir(root, {withFileTypes:true})).filter(entry => entry.isDirectory())
          .map(entry => entry.name).sort((a,b) => b.localeCompare(a, undefined, {numeric:true}))
          .map(version => join(root, version, 'bin'));
      } catch { return []; }
    },
    exec(command, args, timeoutMs, commandEnv) {
      return new Promise((resolve, reject) => {
        execFile(command, args, { timeout: timeoutMs, env: commandEnv, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout, stderr) => {
          const code = typeof (error as NodeJS.ErrnoException | null)?.code === "number"
            ? (error as NodeJS.ErrnoException & { code?: number }).code ?? 1
            : error ? 1 : 0;
          if (error && (error as NodeJS.ErrnoException).code === "ENOENT") reject(error);
          else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
        });
      });
    },
    spawn(command, args, commandEnv) {
      const child: ChildProcess = spawn(command, args, { env: commandEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const listeners = new Set<(chunk: string) => void>();
      let exit: { code: number | null } | null = null;
      let resolveExit: (result: { code: number | null }) => void = () => undefined;
      const exited = new Promise<{ code: number | null }>(resolvePromise => { resolveExit = resolvePromise; });
      const emit = (chunk: Buffer) => { const text = chunk.toString("utf8"); for (const listener of listeners) listener(text); };
      child.stdout?.on("data", emit);
      child.stderr?.on("data", emit);
      child.once("error", () => { if (!exit) { exit = { code: 1 }; resolveExit(exit); } });
      child.once("exit", code => { if (!exit) { exit = { code }; resolveExit(exit); } });
      return {
        kill() { if (child.exitCode === null && !child.killed) child.kill("SIGTERM"); },
        exited,
        onOutput(listener) { listeners.add(listener); },
      };
    },
  };
}
