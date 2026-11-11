import type { OnboardingActivity, OnboardingAgentId, OnboardingAgentSnapshot, OnboardingSnapshot } from "@opencraft/appserver-protocol";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const ONBOARDING_AGENT_ENGINES = { codex: "codex", cursor: "cursor", claude: "claude-code", codebuddy: "codebuddy" } as const;

/** Local CLIs the first-run agent step can see. Commands and packages are fixed. */
export const ONBOARDING_AGENTS = [
  {
    id: "codex",
    name: "Codex",
    commands: ["codex"],
    versionArgs: ["--version"],
    statusArgs: ["login", "status"],
    signInArgs: ["login"],
    signInEnv: {},
    installPackage: "@openai/codex",
    installUrl: "https://developers.openai.com/codex/cli",
  },
  {
    id: "cursor",
    name: "Cursor",
    commands: ["cursor-agent"],
    versionArgs: ["--version"],
    statusArgs: ["status"],
    signInArgs: ["login"],
    signInEnv: { NO_OPEN_BROWSER: "1" },
    installPackage: null,
    installUrl: "https://cursor.com/docs/cli/installation",
  },
  {
    id: "claude",
    name: "Claude Code",
    commands: ["claude"],
    versionArgs: ["--version"],
    statusArgs: ["auth", "status"],
    signInArgs: ["auth", "login"],
    signInEnv: {},
    installPackage: null,
    installUrl: "https://code.claude.com/docs/en/setup",
  },
  {
    id: "codebuddy",
    name: "CodeBuddy",
    commands: ["codebuddy", "cbc"],
    versionArgs: ["--version"],
    statusArgs: ["auth", "status"],
    signInArgs: ["auth", "login"],
    signInEnv: {},
    installPackage: "@tencent-ai/codebuddy-code",
    installUrl: "https://www.codebuddy.cn/cli/",
  },
] as const;

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
  if (/not (?:logged|signed) in|logged out|sign in required/iu.test(text)) return { authenticated: false, account: null };
  if (/(?:^|[^a-z])(?:logged|signed) in/iu.test(text)) return { authenticated: true, account };
  return { authenticated: code === 0 ? null : false, account: null };
}

export function firstVersionLine(stdout: string): string | null {
  const line = stripTerminal(stdout).split("\n").map(item => item.trim()).find(Boolean);
  return line ? line.slice(0, 80) : null;
}

export async function resolveExecutable(commands: readonly string[], deps: Pick<OnboardingDeps, "env" | "homedir" | "exists" | "cursorVersions">): Promise<string | null> {
  const dirs = [...new Set([...(deps.env.PATH ?? "").split(delimiter), join(deps.homedir, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean))];
  for (const command of commands) {
    for (const dir of dirs) {
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
    const args = kind === "install" ? ["install", "-g", agent.installPackage!] : agent.signInArgs;
    const env = { ...this.deps.env, ...agent.signInEnv, PATH: augmentedPath(this.deps.env, this.deps.homedir) };
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
    const env = { ...this.deps.env, PATH: augmentedPath(this.deps.env, this.deps.homedir) };
    const [version, status] = await Promise.all([
      this.deps.exec(executable, agent.versionArgs, STATUS_TIMEOUT_MS, env).catch(() => ({ stdout: "", stderr: "", code: 1 })),
      this.deps.exec(executable, agent.statusArgs, STATUS_TIMEOUT_MS, env).catch(() => ({ stdout: "", stderr: "", code: 1 })),
    ]);
    const auth = interpretAuth(agent.id, status.stdout, status.stderr, status.code);
    return {
      ...base,
      installed: true,
      version: firstVersionLine(version.stdout),
      authenticated: auth.authenticated,
      account: auth.account,
    };
  }
}

function augmentedPath(env: NodeJS.ProcessEnv, home: string): string {
  const extras = [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const extra of extras) if (!parts.includes(extra)) parts.unshift(extra);
  return parts.join(delimiter);
}

export function createOnboardingDeps(env: NodeJS.ProcessEnv = process.env): OnboardingDeps {
  const home = homedir();
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
