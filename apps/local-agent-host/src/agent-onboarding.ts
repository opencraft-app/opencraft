import type { OnboardingActivity, OnboardingAgentId, OnboardingAgentSnapshot, OnboardingSnapshot } from "@opencraft/appserver-protocol";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ONBOARDING_AGENT_ENGINES = { codex: "codex", cursor: "cursor", claude: "claude-code", gemini: "gemini", codebuddy: "codebuddy", "codebuddy-ide": "codebuddy-ide", pi: "pi-cli", dsh: "dsh-acp" } as const;

/** Local CLIs the first-run agent step can see. Commands and packages are fixed. */
export const ONBOARDING_AGENTS = [
  {
    id: "codex",
    name: "Codex",
    commands: ["codex"],
    versionArgs: ["--version"],
    statusArgs: ["login", "status"],
    signInArgs: ["login"],
    signInEnv: { BROWSER: "/usr/bin/true" },
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
    signInEnv: { BROWSER: "/usr/bin/true" },
    installPackage: null,
    installUrl: "https://code.claude.com/docs/en/setup",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    commands: ["gemini"],
    versionArgs: ["--version"],
    statusArgs: [],
    signInArgs: [],
    signInEnv: {},
    installPackage: "@google/gemini-cli",
    installUrl: "https://github.com/google-gemini/gemini-cli",
  },
  {
    id: "codebuddy",
    name: "CodeBuddy CLI",
    commands: ["codebuddy", "cbc"],
    versionArgs: ["--version"],
    statusArgs: [],
    signInArgs: [],
    signInEnv: {},
    installPackage: "@tencent-ai/codebuddy-code",
    installUrl: "https://www.codebuddy.cn/cli/",
  },
  {id:"codebuddy-ide",name:"CodeBuddy IDE",commands:[],versionArgs:[],statusArgs:[],signInArgs:[],signInEnv:{},installPackage:null,installUrl:"https://www.codebuddy.cn/ide/"},
  { id: "pi", name: "Pi", commands: ["pi"], versionArgs: ["--version"], statusArgs: ["--list-models", "--offline"],
    signInArgs: [], signInEnv: {}, installPackage: "@earendil-works/pi-coding-agent", installUrl: "https://pi.dev" },
  { id: "dsh", name: "DSH", commands: ["dsh"], versionArgs: ["--version"], statusArgs: [],
    signInArgs: [], signInEnv: {}, installPackage: "@deepseek-ai/dsh", installUrl: "https://github.com/deepseek-ai/deepseek-harness" },
] as const;

export type { OnboardingActivity, OnboardingAgentId, OnboardingAgentSnapshot, OnboardingSnapshot };

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface ManagedProcess {
  kill(): void;
  write?(input: string): void;
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
  if (id === "pi") {
    if (code !== 0) return { authenticated: null, account: null };
    const lines = stripTerminal(stdout).split("\n"), header = lines.findIndex(line => /^provider\s+model\s+/iu.test(line.trim()));
    return { authenticated: header >= 0 && lines.slice(header + 1).some(line => /^\S+\s+\S+\s+[\d,.]+[km]?\s+/iu.test(line.trim())), account: null };
  }
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
  if (id === "gemini") {
    if (/please sign in|not (?:logged|signed) in|sign in required/iu.test(text)) return { authenticated: false, account: null };
    if (code === 0 && text.length > 0) return { authenticated: true, account: EMAIL.exec(text)?.[0] ?? null };
    return { authenticated: false, account: null };
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

async function readLocalCodexAuth(env: NodeJS.ProcessEnv, home: string): Promise<{ authenticated: true; account: string | null } | null> {
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

async function readLocalCursorAuth(env: NodeJS.ProcessEnv, home: string): Promise<{ authenticated: true; account: string | null } | null> {
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
      if (authInfo && typeof authInfo === "object" && (typeof authInfo.accessToken === "string" && authInfo.accessToken.trim() || typeof authInfo.email === "string" && authInfo.email.trim())) {
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

export async function resolveExecutable(commands: readonly string[], deps: Pick<OnboardingDeps, "env" | "homedir" | "exists" | "cursorVersions">): Promise<string | null> {
  const bundledNodeBin = fileURLToPath(new globalThis.URL("../../../node_modules/.bin", import.meta.url));
  const bundledDshBin = fileURLToPath(new globalThis.URL("../../../runtime/dsh/node_modules/.bin", import.meta.url));
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
      // The bundled Pi SDK and internal DSH runtime also expose bins. npm-run PATH injection
      // must not masquerade as the user's installed native CLI or shadow its version.
      const resolvedDir = resolve(dir);
      if ((command === "pi" || command === "dsh") && (resolvedDir === bundledNodeBin || resolvedDir === bundledDshBin)) continue;
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
  kind: "sign-in" | "install" | "upgrade";
  phase: "running" | "failed";
  message: string | null;
  log: string;
  process: ManagedProcess | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function activityOf(task: LiveTask | undefined): OnboardingActivity | null {
  if (!task) return null;
  const guide = task.kind === "sign-in" ? parseSignInOutput(task.log) : { url: null, userCode: null };
  const awaitingCode = task.kind === "sign-in" && task.phase === "running" && /paste (?:the authorization )?code/iu.test(stripTerminal(task.log));
  return {
    kind: task.kind,
    phase: task.phase,
    message: task.message,
    url: guide.url,
    userCode: guide.userCode,
    ...(awaitingCode ? { awaitingCode: true } : {}),
    log: tail(task.log),
  };
}

export class AgentOnboardingService {
  private readonly tasks = new Map<OnboardingAgentId, LiveTask>();
  private closed = false;
  private latestVersionsCache: { versions: Record<string, string | null>; checkedAt: number } | null = null;
  private latestVersionsFlight: Promise<{ versions: Record<string, string | null>; checkedAt: number }> | null = null;
  private readonly native = new Map<OnboardingAgentId,{probe():Promise<OnboardingAgentSnapshot>;historyProbe?():Promise<OnboardingAgentSnapshot>;act(action:unknown):Promise<void>}>();
  registerNative(id:OnboardingAgentId,adapter:{probe():Promise<OnboardingAgentSnapshot>;historyProbe?():Promise<OnboardingAgentSnapshot>;act(action:unknown):Promise<void>}) { this.native.set(id,adapter); }

  constructor(private readonly deps: OnboardingDeps = createOnboardingDeps()) {}

  async packageVersions(force = false): Promise<{ versions: Readonly<Record<string, string | null>>; checkedAt: number }> {
    if (this.closed) throw new Error("Agent onboarding is closed");
    if (!force && this.latestVersionsCache && Date.now() - this.latestVersionsCache.checkedAt < 10 * 60_000) {
      return this.latestVersionsCache;
    }
    if (!force && this.latestVersionsFlight) return this.latestVersionsFlight;
    const flight = (async () => {
      const entries = await Promise.all(ONBOARDING_AGENTS.map(async agent => {
        if (!agent.installPackage) return [agent.id, null] as const;
        try {
          const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(agent.installPackage)}/latest`, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(4000),
          });
          if (!response.ok) return [agent.id, null] as const;
          const body = await response.json() as { version?: unknown };
          return [agent.id, typeof body?.version === "string" && body.version.trim() ? body.version.trim() : null] as const;
        } catch {
          return [agent.id, this.latestVersionsCache?.versions[agent.id] ?? null] as const;
        }
      }));
      const result = { versions: Object.fromEntries(entries), checkedAt: Date.now() };
      this.latestVersionsCache = result;
      return result;
    })().finally(() => {
      if (this.latestVersionsFlight === flight) this.latestVersionsFlight = null;
    });
    this.latestVersionsFlight = flight;
    return flight;
  }

  async historyStatus(): Promise<OnboardingSnapshot> {
    if (this.closed) throw new Error("Agent onboarding is closed");
    return { historyImport: true, agents: await Promise.all(ONBOARDING_AGENTS.map(async agent => {
      const native = this.native.get(agent.id);
      if (native?.historyProbe) return native.historyProbe();
      return { id: agent.id, engineId: ONBOARDING_AGENT_ENGINES[agent.id], displayName: agent.name,
        installed: !!await resolveExecutable(agent.commands, this.deps), version: null, authenticated: null,
        account: null, activity: null, installUrl: agent.installUrl, canInstallPackage: agent.installPackage !== null,
        historyImport: agent.id !== "codebuddy-ide" && agent.id !== "dsh" && agent.id !== "gemini" };
    })) };
  }

  async status(): Promise<OnboardingSnapshot> {
    if (this.closed) throw new Error("Agent onboarding is closed");
    const agents = await Promise.all(ONBOARDING_AGENTS.map(agent => this.probe(agent)));
    return { agents };
  }

  async act(input: unknown): Promise<OnboardingSnapshot> {
    if (this.closed) throw new Error("Agent onboarding is closed");
    const params = input && typeof input === "object" ? input as { id?: unknown; action?: unknown; code?: unknown } : {};
    const agent = definition(typeof params.id === "string" ? params.id : "");
    if (!agent) throw new Error("Unknown agent");
    const native = this.native.get(agent.id);
    if(native){await native.act(params.action);return this.status();}
    const action = params.action;
    if (action === "cancel") this.clear(agent.id);
    else if (action === "sign-in") await this.start(agent, "sign-in");
    else if (action === "install") await this.start(agent, "install");
    else if (action === "upgrade") await this.start(agent, "upgrade");
    else if (action === "submit-code") {
      const code = typeof params.code === "string" ? params.code.trim() : "";
      if (!code || code.length > 4096 || /[\r\n]/u.test(code)) throw new Error("Invalid authorization code");
      const task = this.tasks.get(agent.id);
      if (!task || task.phase !== "running" || !task.process?.write) throw new Error("No active sign-in is waiting for a code");
      task.process.write(`${code}\n`);
      await Promise.race([task.process.exited, new Promise(resolvePromise => setTimeout(resolvePromise, 4000))]);
    }
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

  private async start(agent: (typeof ONBOARDING_AGENTS)[number], kind: "sign-in" | "install" | "upgrade"): Promise<void> {
    const current = this.tasks.get(agent.id);
    if (current?.phase === "running") return;
    this.clear(agent.id);
    const installing = kind === "install" || kind === "upgrade";
    if (installing && agent.installPackage === null) throw new Error("This agent is installed from its own site");
    const executable = installing
      ? await resolveExecutable([process.platform === "win32" ? "npm.cmd" : "npm"], this.deps)
      : await resolveExecutable(agent.commands, this.deps);
    if (!executable) throw new Error(installing ? "npm is not available" : "Agent is not installed");
    if (kind === "sign-in" && agent.signInArgs.length === 0) throw new Error("Sign in from the native agent client before connecting");
    const headlessLinuxCodex = kind === "sign-in" && agent.id === "codex" && process.platform === "linux" && !this.deps.env.DISPLAY && !this.deps.env.WAYLAND_DISPLAY;
    const args = kind === "upgrade"
      ? ["install", "-g", `${agent.installPackage!}@latest`]
      : kind === "install"
        ? ["install", "-g", agent.installPackage!]
        : headlessLinuxCodex
          ? [...agent.signInArgs, "--device-auth"]
          : agent.signInArgs;
    const env = { ...this.deps.env, ...agent.signInEnv, PATH: augmentedPath(this.deps.env, this.deps.homedir) };
    const child = this.deps.spawn(executable, args, env);
    const task: LiveTask = { kind, phase: "running", message: null, log: `$ ${args.join(" ")}\n`, process: child, timer: null };
    this.tasks.set(agent.id, task);
    child.onOutput(chunk => { task.log += chunk; });
    task.timer = setTimeout(() => this.fail(agent.id, "Timed out"), installing ? INSTALL_TIMEOUT_MS : SIGN_IN_TIMEOUT_MS);
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
    const native=this.native.get(agent.id);if(native)return native.probe();
    const executable = await resolveExecutable(agent.commands, this.deps);
    const isStandaloneGeminiCli = agent.id === "gemini";
    const base = {
      id: agent.id,
      engineId: ONBOARDING_AGENT_ENGINES[agent.id], historyImport: agent.id !== "codebuddy-ide" && agent.id !== "dsh" && agent.id !== "gemini",
      displayName: agent.name,
      installUrl: agent.installUrl,
      canInstallPackage: agent.installPackage !== null,
      ...(agent.id === "pi" ? { setupCommand: "pi" } : agent.id === "dsh" ? { setupCommand: "dsh web" } : agent.id === "codebuddy" ? { setupCommand: "codebuddy" } : isStandaloneGeminiCli ? { setupCommand: "gemini" } : {}),
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
    const env = { ...this.deps.env, PATH: augmentedPath(this.deps.env, this.deps.homedir) };
    const statusTimeout = 15_000;
    const skipStatusProcess = isStandaloneGeminiCli || Boolean(localFastCodex);
    const [version, status] = await Promise.all([
      this.deps.exec(executable, agent.versionArgs, statusTimeout, env).catch(() => ({ stdout: "", stderr: "", code: 1 })),
      agent.statusArgs.length && !skipStatusProcess ? this.deps.exec(executable, agent.statusArgs, statusTimeout, env).catch(() => ({ stdout: "", stderr: "", code: 1 })) : Promise.resolve({stdout:"",stderr:"",code:0}),
    ]);
    const auth = localFastCodex
      ? localFastCodex
      : agent.id === "dsh"
        ? {
            authenticated: version.code !== 0
              ? null
              : Boolean(this.deps.env.DEEPSEEK_API_KEY?.trim()) || await this.deps.exists(this.deps.env.DSH_HOME?.trim() || join(this.deps.homedir, ".dsh")),
            account: null,
          }
        : isStandaloneGeminiCli
          ? {
              authenticated: version.code !== 0
                ? null
                : Boolean(this.deps.env.GEMINI_API_KEY?.trim() || this.deps.env.GOOGLE_API_KEY?.trim())
                  || await access(join(this.deps.homedir, ".gemini", "oauth_creds.json"), constants.R_OK).then(() => true, () => false),
              account: null,
            }
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
      const child: ChildProcess = spawn(command, args, { env: commandEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const listeners = new Set<(chunk: string) => void>();
      let exit: { code: number | null } | null = null;
      let resolveExit: (result: { code: number | null }) => void = () => undefined;
      const exited = new Promise<{ code: number | null }>(resolvePromise => { resolveExit = resolvePromise; });
      const emit = (chunk: Buffer) => { const text = chunk.toString("utf8"); for (const listener of listeners) listener(text); };
      child.stdout?.on("data", emit);
      child.stderr?.on("data", emit);
      child.stdin?.on("error", () => {});
      child.once("error", () => { if (!exit) { exit = { code: 1 }; resolveExit(exit); } });
      child.once("exit", code => { if (!exit) { exit = { code }; resolveExit(exit); } });
      return {
        kill() { if (child.exitCode === null && !child.killed) child.kill("SIGTERM"); },
        write(input: string) { if (child.exitCode === null && !child.killed) child.stdin?.write(input); },
        exited,
        onOutput(listener) { listeners.add(listener); },
      };
    },
  };
}
