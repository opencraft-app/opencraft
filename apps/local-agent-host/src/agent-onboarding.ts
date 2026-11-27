import { AGENT_PROVIDERS, externalSource } from "@opencraft/agent-bridge-protocol";
import type { OnboardingActivity, OnboardingAgentId, OnboardingAgentSnapshot, OnboardingSnapshot } from "@opencraft/appserver-protocol";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { arch, homedir, platform as osPlatform } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

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
  write?(input: string): void;
  readonly exited: Promise<{ code: number | null }>;
  onOutput(listener: (chunk: string) => void): void;
}

export interface FileFingerprint {
  readonly realpath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

export interface OnboardingDeps {
  env: NodeJS.ProcessEnv;
  homedir: string;
  dataDirectory?: string;
  exists(file: string): Promise<boolean>;
  cursorVersions(): Promise<readonly string[]>;
  nodeBinDirectories?(): Promise<readonly string[]>;
  shellEnvironment?(): Promise<Readonly<Record<string, string>>>;
  invalidateShellEnvironment?(): void;
  statFile?(file: string): Promise<FileFingerprint | null>;
  readTextFile?(file: string): Promise<string | null>;
  writeTextFile?(file: string, content: string): Promise<void>;
  installManagedAgent?(id: OnboardingAgentId, onLog: (chunk: string) => void, signal: AbortSignal): Promise<boolean>;
  exec(command: string, args: readonly string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<CommandResult>;
  spawn(command: string, args: readonly string[], env: NodeJS.ProcessEnv): ManagedProcess;
}

const STATUS_TIMEOUT_MS = 8_000;
const SHELL_PROBE_TIMEOUT_MS = 3_000;
const AUTH_CACHE_TTL_MS = 45_000;
const INSTALL_TIMEOUT_MS = 180_000;
const SIGN_IN_TIMEOUT_MS = 300_000;
const LOG_LIMIT = 8_000;

const SHELL_CAPTURED_ENV_KEYS = [
  "PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

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

export async function readLocalClaudeAuth(
  env: NodeJS.ProcessEnv,
  home: string,
  exec?: OnboardingDeps["exec"],
): Promise<{ authenticated: boolean; account: string | null }> {
  if (env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()) {
    return { authenticated: true, account: null };
  }
  const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  try {
    const creds = JSON.parse(await readFile(join(claudeDir, ".credentials.json"), "utf8")) as Record<string, any>;
    if (creds?.claudeAiOauth?.accessToken || creds?.accessToken) {
      return { authenticated: true, account: null };
    }
  } catch { /* Ignore missing credentials file. */ }
  try {
    const cfg = JSON.parse(await readFile(join(home, ".claude.json"), "utf8")) as Record<string, any>;
    const email = typeof cfg?.oauthAccount?.emailAddress === "string" ? cfg.oauthAccount.emailAddress : null;
    if (cfg?.oauthAccount?.accountUuid || email || (typeof cfg?.primaryApiKey === "string" && cfg.primaryApiKey.trim())) {
      return { authenticated: true, account: email };
    }
  } catch { /* Ignore missing config file. */ }
  if (process.platform === "darwin" && exec) {
    const kc = await exec("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials"], 3000, env).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (kc.code === 0) return { authenticated: true, account: null };
  }
  return { authenticated: false, account: null };
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

function userShimDirectories(env: NodeJS.ProcessEnv, home: string): string[] {
  const pnpmHome = env.PNPM_HOME?.trim()
    || (process.platform === "darwin" ? join(home, "Library", "pnpm") : join(home, ".local", "share", "pnpm"));
  return [
    join(home, ".local", "bin"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".asdf", "shims"),
    join(home, ".asdf", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".bun", "bin"),
    pnpmHome,
    join(home, ".cargo", "bin"),
    join(home, ".codebuddy", "bin"),
  ];
}

function explicitExecutableCandidates(commands: readonly string[], env: NodeJS.ProcessEnv, dataDirectory?: string): string[] {
  const candidates: string[] = [];
  if (commands.includes("codex")) {
    for (const raw of [env.OPENCRAFT_CODEX_EXECUTABLE, env.CODEX_CLI_PATH]) {
      if (raw?.trim()) candidates.push(raw.trim());
    }
    if (dataDirectory) {
      const binName = process.platform === "win32" ? "codex.exe" : "codex";
      candidates.push(
        join(dataDirectory, "tools", "codex", "current", "bin", binName),
        join(dataDirectory, "tools", "codex", "current", binName),
        join(dataDirectory, "tools", "codex", "bin", binName),
      );
    }
  }
  if (commands.includes("claude") && env.OPENCRAFT_CLAUDE_EXECUTABLE?.trim()) {
    candidates.push(env.OPENCRAFT_CLAUDE_EXECUTABLE.trim());
  }
  if (commands.includes("cursor-agent") && env.OPENCRAFT_CURSOR_EXECUTABLE?.trim()) {
    candidates.push(env.OPENCRAFT_CURSOR_EXECUTABLE.trim());
  }
  return candidates;
}

function desktopAppBundleCandidates(commands: readonly string[], home: string): string[] {
  const candidates: string[] = [];
  if (commands.includes("codex")) {
    candidates.push(
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
      join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex"),
      "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
      join(home, "Applications", "Codex.app", "Contents", "Resources", "codex-cli", "bin", "codex"),
      "/Applications/Codex.app/Contents/Resources/codex",
      join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
    );
  }
  if (commands.includes("cursor-agent")) {
    candidates.push(
      "/Applications/Cursor.app/Contents/Resources/app/bin/cursor-agent",
      join(home, "Applications", "Cursor.app", "Contents", "Resources", "app", "bin", "cursor-agent"),
    );
  }
  return candidates;
}

export async function resolveExecutable(
  commands: readonly string[],
  deps: Pick<OnboardingDeps, "env" | "homedir" | "dataDirectory" | "exists" | "cursorVersions" | "nodeBinDirectories" | "shellEnvironment">,
): Promise<string | null> {
  for (const explicit of explicitExecutableCandidates(commands, deps.env, deps.dataDirectory)) {
    if (await deps.exists(explicit)) return explicit;
  }
  const shellEnv = await deps.shellEnvironment?.().catch(() => ({} as Readonly<Record<string, string>>));
  const dirs = [...new Set([
    ...(deps.env.PATH ?? "").split(delimiter),
    ...(shellEnv?.PATH ?? "").split(delimiter),
    dirname(process.execPath),
    ...userShimDirectories(deps.env, deps.homedir),
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
  if (commands.includes("cursor-agent")) {
    const versions = [...await deps.cursorVersions()].sort((left, right) => right.localeCompare(left));
    for (const version of versions) {
      const candidate = join(deps.homedir, ".local", "share", "cursor-agent", "versions", version, "cursor-agent");
      if (await deps.exists(candidate)) return candidate;
    }
  }
  for (const appCandidate of desktopAppBundleCandidates(commands, deps.homedir)) {
    if (await deps.exists(appCandidate)) return appCandidate;
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

function fingerprintKey(fp: FileFingerprint | null): string | null {
  return fp ? `${fp.realpath}:${fp.size}:${Math.trunc(fp.mtimeMs)}:${fp.ino}` : null;
}

interface PersistedProbeEntry {
  executable: string;
  binaryFingerprint: string;
  version: string | null;
  authFingerprint?: string | null;
  authenticated?: boolean | null;
  account?: string | null;
  checkedAt?: number;
}

interface PersistedProbeCacheFile {
  schemaVersion: 1;
  entries: Record<string, PersistedProbeEntry>;
}

interface LiveTask {
  kind: "sign-in" | "install" | "upgrade";
  phase: "running" | "failed";
  message: string | null;
  log: string;
  process: ManagedProcess | null;
  abort: AbortController | null;
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
  private readonly probeCache = new Map<string, PersistedProbeEntry>();
  private readonly expiredAuth = new Set<OnboardingAgentId>();
  private cacheLoaded: Promise<void> | null = null;
  private cacheWrite: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly deps: OnboardingDeps = createOnboardingDeps(),
    private readonly onSignedIn?: (id: OnboardingAgentId) => void,
  ) {}

  private get probeCachePath(): string | null {
    return this.deps.dataDirectory ? join(this.deps.dataDirectory, "connected-agents", "probe-cache.json") : null;
  }

  private async ensureProbeCacheLoaded(): Promise<void> {
    const cachePath = this.probeCachePath;
    if (!cachePath || !this.deps.readTextFile) return;
    await (this.cacheLoaded ??= (async () => {
      try {
        const raw = await this.deps.readTextFile!(cachePath);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Partial<PersistedProbeCacheFile>;
        if (parsed.schemaVersion !== 1 || !parsed.entries || typeof parsed.entries !== "object") return;
        for (const [id, entry] of Object.entries(parsed.entries)) {
          if (entry && typeof entry.executable === "string" && typeof entry.binaryFingerprint === "string" && !this.probeCache.has(id)) {
            this.probeCache.set(id, entry);
          }
        }
      } catch {
        /* Corrupt or missing cache is rebuilt lazily. */
      }
    })());
  }

  private persistProbeCache(): void {
    const cachePath = this.probeCachePath;
    const writer = this.deps.writeTextFile;
    if (!cachePath || !writer || this.closed) return;
    const payload: PersistedProbeCacheFile = {
      schemaVersion: 1,
      entries: Object.fromEntries(this.probeCache.entries()),
    };
    const serialized = JSON.stringify(payload);
    this.cacheWrite = this.cacheWrite.catch(() => undefined).then(() => writer(cachePath, serialized)).catch(() => undefined);
  }

  invalidateProbeCache(id?: OnboardingAgentId): void {
    if (id) this.probeCache.delete(id);
    else this.probeCache.clear();
    if (!id || id === "codebuddy") codeBuddyAuthCache.clear();
    this.deps.invalidateShellEnvironment?.();
    this.persistProbeCache();
  }

  /** Record a runtime 401/auth failure so stale local session probes do not report Ready. */
  markAuthenticationExpired(id: OnboardingAgentId): void {
    this.expiredAuth.add(id);
    this.invalidateProbeCache(id);
  }

  async status(): Promise<OnboardingSnapshot> {
    if (this.closed) throw new Error("Agent onboarding is closed");
    await this.ensureProbeCacheLoaded();
    const agents = await Promise.all(ONBOARDING_AGENTS.map(agent => this.probe(agent)));
    return { agents };
  }

  async act(input: unknown): Promise<OnboardingSnapshot> {
    if (this.closed) throw new Error("Agent onboarding is closed");
    const params = input && typeof input === "object" ? input as { id?: unknown; action?: unknown; code?: unknown } : {};
    const agent = definition(typeof params.id === "string" ? params.id : "");
    if (!agent) throw new Error("Unknown agent");
    const action = params.action;
    this.invalidateProbeCache(agent.id);
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
      this.invalidateProbeCache(agent.id);
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
    task.abort?.abort();
    task.process?.kill();
    this.tasks.delete(id);
  }

  private startManagedFallbackInstall(agent: (typeof ONBOARDING_AGENTS)[number], kind: "install" | "upgrade", initialLog = ""): void {
    const abort = new AbortController();
    const task: LiveTask = {
      kind,
      phase: "running",
      message: null,
      log: initialLog || `$ install standalone ${agent.id}\n`,
      process: null,
      abort,
      timer: null,
    };
    this.tasks.set(agent.id, task);
    task.timer = setTimeout(() => this.fail(agent.id, "Timed out"), INSTALL_TIMEOUT_MS);
    void this.deps.installManagedAgent!(agent.id, chunk => { task.log += chunk; }, abort.signal)
      .then(ok => {
        if (this.tasks.get(agent.id) !== task) return;
        if (task.timer) clearTimeout(task.timer);
        task.timer = null;
        task.abort = null;
        this.invalidateProbeCache(agent.id);
        if (ok) this.tasks.delete(agent.id);
        else this.fail(agent.id, failureMessage(task.log) ?? "Managed installation failed");
      })
      .catch(error => {
        if (this.tasks.get(agent.id) !== task) return;
        this.fail(agent.id, error instanceof Error ? error.message : "Managed installation failed");
      });
  }

  private async start(agent: (typeof ONBOARDING_AGENTS)[number], kind: "sign-in" | "install" | "upgrade"): Promise<void> {
    const current = this.tasks.get(agent.id);
    if (current?.phase === "running") return;
    if (kind === "sign-in") this.expiredAuth.delete(agent.id);
    this.clear(agent.id);
    const installing = kind === "install" || kind === "upgrade";
    if (installing && agent.installPackage === null) throw new Error("This agent is installed from its own site");
    const executable = installing
      ? await resolveExecutable([process.platform === "win32" ? "npm.cmd" : "npm"], this.deps)
      : await resolveExecutable(agent.commands, this.deps);
    if (!executable) {
      if (installing && agent.id === "codex" && this.deps.installManagedAgent) {
        this.startManagedFallbackInstall(agent, kind);
        return;
      }
      throw new Error(installing ? "npm is not available" : "Agent is not installed");
    }
    const headlessLinuxCodex = kind === "sign-in" && agent.id === "codex" && process.platform === "linux" && !this.deps.env.DISPLAY && !this.deps.env.WAYLAND_DISPLAY;
    const args = kind === "upgrade"
      ? ["install", "-g", `${agent.installPackage!}@latest`]
      : kind === "install"
        ? ["install", "-g", agent.installPackage!]
        : headlessLinuxCodex
          ? [...agent.signInArgs, "--device-auth"]
          : agent.signInArgs;
    const env = { ...await localAgentEnvironment(this.deps, executable), ...agent.signInEnv };
    const child = this.deps.spawn(executable, args, env);
    const task: LiveTask = { kind, phase: "running", message: null, log: `$ ${args.join(" ")}\n`, process: child, abort: null, timer: null };
    this.tasks.set(agent.id, task);
    child.onOutput(chunk => { task.log += chunk; });
    task.timer = setTimeout(() => this.fail(agent.id, "Timed out"), installing ? INSTALL_TIMEOUT_MS : SIGN_IN_TIMEOUT_MS);
    void child.exited.then(result => {
      if (this.tasks.get(agent.id) !== task) return;
      if (task.timer) clearTimeout(task.timer);
      task.process = null;
      task.timer = null;
      this.invalidateProbeCache(agent.id);
      if (result.code === 0) {
        this.tasks.delete(agent.id);
        if (kind === "sign-in") {
          this.expiredAuth.delete(agent.id);
          this.onSignedIn?.(agent.id);
        }
      } else if (installing && agent.id === "codex" && this.deps.installManagedAgent && /EACCES|EPERM|permission denied/iu.test(task.log)) {
        this.startManagedFallbackInstall(agent, kind, `${task.log}\n$ fallback standalone ${agent.id}\n`);
      } else {
        this.fail(agent.id, failureMessage(task.log) ?? `Exited with code ${result.code ?? "unknown"}`);
      }
    });
  }

  private fail(id: OnboardingAgentId, message: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.timer) clearTimeout(task.timer);
    task.timer = null;
    task.abort?.abort();
    task.abort = null;
    task.process?.kill();
    task.process = null;
    task.phase = "failed";
    task.message = redactSecrets(message).slice(0, 180);
  }

  private async authFileFingerprint(id: OnboardingAgentId): Promise<string | null> {
    if (!this.deps.statFile) return null;
    if (id === "codex") {
      const codexHome = this.deps.env.CODEX_HOME?.trim() || join(this.deps.homedir, ".codex");
      return fingerprintKey(await this.deps.statFile(join(codexHome, "auth.json")));
    }
    if (id === "cursor") {
      const a = await this.deps.statFile(join(this.deps.env.XDG_CONFIG_HOME?.trim() || join(this.deps.homedir, ".config"), "cursor", "auth.json"));
      const b = await this.deps.statFile(join(this.deps.env.CURSOR_CONFIG_DIR?.trim() || join(this.deps.homedir, ".cursor"), "cli-config.json"));
      return `${fingerprintKey(a) ?? "none"}|${fingerprintKey(b) ?? "none"}`;
    }
    return null;
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
    if (this.expiredAuth.has(agent.id)) {
      const cachedEntry = this.probeCache.get(agent.id);
      return { ...base, installed: true, version: cachedEntry?.version ?? null, authenticated: false, account: null };
    }
    const binaryFp = this.deps.statFile ? fingerprintKey(await this.deps.statFile(executable)) : null;
    const authFp = binaryFp ? await this.authFileFingerprint(agent.id) : null;
    const cached = binaryFp ? this.probeCache.get(agent.id) : undefined;
    const cachedVersionValid = Boolean(cached && cached.executable === executable && cached.binaryFingerprint === binaryFp && cached.version);
    const cachedAuthValid = Boolean(
      cachedVersionValid
      && cached?.checkedAt
      && Date.now() - cached.checkedAt < AUTH_CACHE_TTL_MS
      && (cached.authFingerprint ?? null) === authFp
      && typeof cached.authenticated === "boolean",
    );
    if (cachedVersionValid && cachedAuthValid) {
      return {
        ...base,
        installed: true,
        version: cached!.version,
        authenticated: cached!.authenticated ?? null,
        account: cached!.account ?? null,
      };
    }

    const isRealLocalDeps = this.deps.homedir === homedir();
    const localFastCodex = agent.id === "codex" && isRealLocalDeps ? await readLocalCodexAuth(this.deps.env, this.deps.homedir) : null;
    const localFastCursor = agent.id === "cursor" && isRealLocalDeps ? await readLocalCursorAuth(this.deps.env, this.deps.homedir) : null;
    const env = await localAgentEnvironment(this.deps, executable);
    const statusTimeout = 15_000;
    const versionResult = cachedVersionValid
      ? { stdout: cached!.version ?? "", stderr: "", code: 0 }
      : await this.deps.exec(executable, agent.versionArgs, statusTimeout, env).catch(() => ({ stdout: "", stderr: "", code: 1 }));
    const version = cachedVersionValid ? cached!.version : firstVersionLine(versionResult.stdout);
    // Claude Code 1.x lacks the `auth status` subcommand and opens an interactive TUI prompt instead.
    const legacyClaudeCli = agent.id === "claude" && Boolean(version && /^1\./u.test(version.trim()));
    const skipStatusProcess = Boolean(localFastCodex) || (legacyClaudeCli && isRealLocalDeps);
    const status = agent.statusArgs.length && !skipStatusProcess
      ? await this.deps.exec(executable, agent.statusArgs, statusTimeout, env).catch(() => ({ stdout: "", stderr: "", code: 1 }))
      : { stdout: "", stderr: "", code: 0 };
    const auth = localFastCodex
      ? localFastCodex
      : legacyClaudeCli && isRealLocalDeps
        ? await readLocalClaudeAuth(this.deps.env, this.deps.homedir, this.deps.exec)
        : agent.id === "codebuddy"
          ? {
              authenticated: versionResult.code !== 0
                ? null
                : isRealLocalDeps
                  ? await probeCodeBuddyAcpAuth(executable, env)
                  : interpretAuth(agent.id, status.stdout, status.stderr, status.code).authenticated,
              account: null,
            }
          : await (async () => {
              const interpreted = interpretAuth(agent.id, status.stdout, status.stderr, status.code);
              if (interpreted.authenticated === null && localFastCursor) return localFastCursor;
              if (interpreted.authenticated === null && agent.id === "claude" && isRealLocalDeps) {
                return readLocalClaudeAuth(this.deps.env, this.deps.homedir, this.deps.exec);
              }
              return interpreted;
            })();
    if (binaryFp && version) {
      this.probeCache.set(agent.id, {
        executable,
        binaryFingerprint: binaryFp,
        version,
        authFingerprint: authFp,
        authenticated: auth.authenticated,
        account: auth.account,
        checkedAt: Date.now(),
      });
      this.persistProbeCache();
    }
    return {
      ...base,
      installed: true,
      version,
      authenticated: auth.authenticated,
      account: auth.account,
    };
  }
}

export function augmentedAgentPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), extraPaths: readonly string[] = []): string {
  const extras = [
    ...extraPaths,
    dirname(process.execPath),
    ...userShimDirectories(env, home),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (let index = extras.length - 1; index >= 0; index--) {
    const extra = extras[index];
    if (extra && !parts.includes(extra)) parts.unshift(extra);
  }
  return parts.join(delimiter);
}
const augmentedPath = augmentedAgentPath;

/** GUI and service PATHs can omit the Node installation or companion tools that own an agent. */
export async function localAgentEnvironment(
  deps: Pick<OnboardingDeps, "env" | "homedir" | "exists" | "nodeBinDirectories" | "shellEnvironment">,
  executable: string,
  extraExecutables: readonly string[] = [],
): Promise<NodeJS.ProcessEnv> {
  const [bins, shellEnv] = await Promise.all([
    deps.nodeBinDirectories?.() ?? Promise.resolve([] as readonly string[]),
    deps.shellEnvironment?.().catch(() => ({} as Readonly<Record<string, string>>)) ?? Promise.resolve({} as Readonly<Record<string, string>>),
  ]);
  const companionDirs: string[] = [];
  const rgName = process.platform === "win32" ? "rg.exe" : "rg";
  for (const target of [executable, ...extraExecutables]) {
    if (!target) continue;
    const binDir = dirname(target);
    companionDirs.push(binDir);
    if (deps.exists) {
      const siblingCodexPath = resolve(binDir, "..", "codex-path");
      if (await deps.exists(join(siblingCodexPath, rgName))) {
        companionDirs.push(siblingCodexPath);
      }
    }
  }
  const mergedEnv: NodeJS.ProcessEnv = { ...deps.env };
  for (const key of SHELL_CAPTURED_ENV_KEYS) {
    if (key === "PATH") continue;
    if (!mergedEnv[key] && shellEnv[key]) mergedEnv[key] = shellEnv[key];
  }
  const shellPathParts = (shellEnv.PATH ?? "").split(delimiter).filter(Boolean);
  return {
    ...mergedEnv,
    PATH: [...new Set([
      ...companionDirs,
      ...augmentedPath(mergedEnv, deps.homedir).split(delimiter),
      ...shellPathParts,
      ...bins,
    ].filter(Boolean))].join(delimiter),
  };
}

function execCapture(command: string, args: readonly string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise(resolvePromise => {
    execFile(command, [...args], { timeout: timeoutMs, env, maxBuffer: 128 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const rawCode = (error as { code?: string | number } | null)?.code;
      const code: number = typeof rawCode === "number" ? rawCode : error ? 1 : 0;
      resolvePromise({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
    });
  });
}

async function probeLoginShellEnvironment(baseEnv: NodeJS.ProcessEnv, home: string): Promise<Readonly<Record<string, string>>> {
  if (process.platform === "win32") return {};
  const shell = baseEnv.SHELL?.trim() || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const startMarker = "__OPENCRAFT_ENV_START__";
  const endMarker = "__OPENCRAFT_ENV_END__";
  const script = `printf '%s\\n' '${startMarker}'; env; printf '%s\\n' '${endMarker}'`;
  const captured: Record<string, string> = {};
  for (const flags of [["-ilc", script], ["-lc", script]] as const) {
    const res = await execCapture(shell, flags, SHELL_PROBE_TIMEOUT_MS, { ...baseEnv, HOME: home });
    const startIdx = res.stdout.indexOf(startMarker);
    const endIdx = res.stdout.indexOf(endMarker);
    if (startIdx >= 0 && endIdx > startIdx) {
      const slice = res.stdout.slice(startIdx + startMarker.length, endIdx);
      for (const line of slice.split(/\r?\n/u)) {
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1);
        if ((SHELL_CAPTURED_ENV_KEYS as readonly string[]).includes(key) && val) {
          captured[key] = val;
        }
      }
      if (captured.PATH) break;
    }
  }
  if (process.platform === "darwin" && !captured.PATH) {
    const launchctl = await execCapture("/bin/launchctl", ["getenv", "PATH"], 1500, baseEnv);
    if (launchctl.code === 0 && launchctl.stdout.trim()) {
      captured.PATH = launchctl.stdout.trim();
    }
  }
  return captured;
}

function codexArchiveAssetName(): string | null {
  const p = osPlatform();
  const a = arch();
  if (p === "darwin" && a === "arm64") return "codex-aarch64-apple-darwin.tar.gz";
  if (p === "darwin" && a === "x64") return "codex-x86_64-apple-darwin.tar.gz";
  if (p === "linux" && a === "x64") return "codex-x86_64-unknown-linux-musl.tar.gz";
  if (p === "linux" && a === "arm64") return "codex-aarch64-unknown-linux-musl.tar.gz";
  return null;
}

async function installStandaloneCodex(dataDirectory: string, env: NodeJS.ProcessEnv, onLog: (chunk: string) => void, signal: AbortSignal): Promise<boolean> {
  const asset = codexArchiveAssetName();
  if (!asset) {
    onLog("Standalone Codex archive is not available for this platform.\n");
    return false;
  }
  const url = `https://github.com/openai/codex/releases/latest/download/${asset}`;
  const versionStamp = `release-${Date.now()}`;
  const toolsRoot = join(dataDirectory, "tools", "codex");
  const stageDir = join(toolsRoot, versionStamp);
  const binDir = join(stageDir, "bin");
  const archivePath = join(stageDir, asset);
  await mkdir(binDir, { recursive: true, mode: 0o755 });
  onLog(`Downloading ${url}\n`);
  try {
    const response = await fetch(url, { signal, redirect: "follow" });
    if (!response.ok) {
      onLog(`Download failed with HTTP ${response.status}\n`);
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      return false;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(archivePath, bytes);
    const extract = await execCapture("tar", ["-xzf", archivePath, "-C", binDir], 60_000, env);
    if (extract.code !== 0) {
      onLog(`${extract.stderr || "Archive extraction failed"}\n`);
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      return false;
    }
    await rm(archivePath, { force: true }).catch(() => undefined);
    const entries = await readdir(binDir);
    const binaryEntry = entries.find(item => item === "codex" || item.startsWith("codex-"));
    if (!binaryEntry) {
      onLog("Downloaded archive did not contain a codex executable.\n");
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      return false;
    }
    const targetBin = join(binDir, "codex");
    if (binaryEntry !== "codex") await rename(join(binDir, binaryEntry), targetBin);
    await chmod(targetBin, 0o755);
    const currentLink = join(toolsRoot, "current");
    const nextLink = `${currentLink}.tmp-${process.pid}`;
    await rm(nextLink, { recursive: true, force: true }).catch(() => undefined);
    await symlink(stageDir, nextLink);
    await rename(nextLink, currentLink);
    onLog(`Installed Codex CLI to ${targetBin}\n`);
    return true;
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    onLog(`${error instanceof Error ? error.message : "Installation failed"}\n`);
    return false;
  }
}

export function createOnboardingDeps(env: NodeJS.ProcessEnv = process.env, dataDirectory?: string): OnboardingDeps {
  const home = env.HOME || env.USERPROFILE || homedir();
  let shellEnvFlight: Promise<Readonly<Record<string, string>>> | null = null;
  const invalidateShellEnvironment = () => { shellEnvFlight = null; };
  return {
    env,
    homedir: home,
    ...(dataDirectory ? { dataDirectory } : {}),
    async exists(file) {
      try { await access(file, constants.X_OK); return true; } catch { return false; }
    },
    async cursorVersions() {
      try { return await readdir(join(home, ".local", "share", "cursor-agent", "versions")); }
      catch { return []; }
    },
    async nodeBinDirectories() {
      const found: string[] = [];
      const nvmRoot = join(env.NVM_DIR || join(home, ".nvm"), "versions", "node");
      try {
        const nvmDirs = (await readdir(nvmRoot, { withFileTypes: true })).filter(entry => entry.isDirectory())
          .map(entry => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
          .map(version => join(nvmRoot, version, "bin"));
        found.push(...nvmDirs);
      } catch { /* Ignore missing nvm root. */ }
      for (const fnmRoot of [
        join(home, ".local", "share", "fnm", "node-versions"),
        join(home, "Library", "Application Support", "fnm", "node-versions"),
      ]) {
        try {
          const fnmDirs = (await readdir(fnmRoot, { withFileTypes: true })).filter(entry => entry.isDirectory())
            .map(entry => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
            .map(version => join(fnmRoot, version, "installation", "bin"));
          found.push(...fnmDirs);
        } catch { /* Ignore missing fnm root. */ }
      }
      return found;
    },
    shellEnvironment() {
      return shellEnvFlight ??= probeLoginShellEnvironment(env, home);
    },
    invalidateShellEnvironment,
    async statFile(file) {
      try {
        const [resolved, info] = await Promise.all([realpath(file), stat(file)]);
        if (!info.isFile()) return null;
        return { realpath: resolved, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino };
      } catch {
        return null;
      }
    },
    async readTextFile(file) {
      try { return await readFile(file, "utf8"); } catch { return null; }
    },
    async writeTextFile(file, content) {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, content, { mode: 0o600 });
      await rename(tmp, file);
    },
    ...(dataDirectory ? {
      installManagedAgent(id: OnboardingAgentId, onLog: (chunk: string) => void, signal: AbortSignal) {
        if (id === "codex") return installStandaloneCodex(dataDirectory, env, onLog, signal);
        return Promise.resolve(false);
      },
    } : {}),
    exec(command, args, timeoutMs, commandEnv) {
      return new Promise((resolvePromise, reject) => {
        execFile(command, args, { timeout: timeoutMs, env: commandEnv, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout, stderr) => {
          const rawCode = (error as { code?: string | number } | null)?.code;
          const code: number = typeof rawCode === "number" ? rawCode : error ? 1 : 0;
          if (rawCode === "ENOENT" || code === 127) {
            invalidateShellEnvironment();
          }
          if (rawCode === "ENOENT") reject(error);
          else resolvePromise({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
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
      child.once("error", err => {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") invalidateShellEnvironment();
        if (!exit) { exit = { code: 1 }; resolveExit(exit); }
      });
      child.once("exit", code => {
        if (code === 127) invalidateShellEnvironment();
        if (!exit) { exit = { code }; resolveExit(exit); }
      });
      return {
        kill() { if (child.exitCode === null && !child.killed) child.kill("SIGTERM"); },
        write(input: string) { if (child.exitCode === null && !child.killed) child.stdin?.write(input); },
        exited,
        onOutput(listener) { listeners.add(listener); },
      };
    },
  };
}
