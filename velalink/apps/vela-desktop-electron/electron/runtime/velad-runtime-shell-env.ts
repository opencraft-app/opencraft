import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { basename } from "node:path";

export const LOGIN_SHELL_ENV_MARKER = "__VELA_LOGIN_SHELL_ENV__";

export interface RuntimeProcessEnvResult {
  env: NodeJS.ProcessEnv;
  loginShellEnvApplied: boolean;
  loginShellEnvError?: string;
}

export interface BuildRuntimeProcessEnvOptions {
  baseEnv?: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
  shell?: string;
  spawnSyncImpl?: typeof spawnSync;
  timeoutMs?: number;
  userInfoImpl?: typeof userInfo;
}

export function buildRuntimeProcessEnv(options: BuildRuntimeProcessEnvOptions = {}): RuntimeProcessEnvResult {
  const baseEnv = options.baseEnv ?? process.env;
  const shellEnv = resolveLoginShellEnv(options);
  if (!shellEnv.env) {
    return {
      env: { ...baseEnv },
      loginShellEnvApplied: false,
      loginShellEnvError: shellEnv.error,
    };
  }
  const env = {
    ...baseEnv,
    ...shellEnv.env,
  };
  preserveHostControlEnv(env, baseEnv);
  return {
    env,
    loginShellEnvApplied: true,
  };
}

function resolveLoginShellEnv(options: BuildRuntimeProcessEnvOptions): {
  env?: NodeJS.ProcessEnv;
  error?: string;
} {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return { error: "login shell env is not used on Windows" };
  }

  const baseEnv = options.baseEnv ?? process.env;
  const shell = options.shell ?? baseEnv.SHELL ?? resolveUserShell(options.userInfoImpl ?? userInfo);
  if (!shell) {
    return { error: "SHELL is not set" };
  }

  const execPath = options.execPath ?? process.execPath;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const command = `${shellQuote(execPath)} -p ${shellQuote(
    `${JSON.stringify(LOGIN_SHELL_ENV_MARKER)} + JSON.stringify(process.env) + ${JSON.stringify(LOGIN_SHELL_ENV_MARKER)}`,
  )}`;
  const args = loginShellArgs(shell, command);
  const env = {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
  };
  const result = spawnSyncImpl(shell, args, {
    encoding: "utf8",
    env,
    timeout: options.timeoutMs ?? 10_000,
    windowsHide: true,
  });
  if (result.error) {
    return { error: result.error.message };
  }
  if (typeof result.status === "number" && result.status !== 0) {
    return { error: `login shell exited with status ${result.status}` };
  }

  const stdout = String(result.stdout ?? "");
  const parsed = parseMarkedEnv(stdout);
  if (!parsed.env) {
    return { error: parsed.error };
  }
  return { env: sanitizeLoginShellEnv(parsed.env, baseEnv) };
}

function loginShellArgs(shell: string, command: string) {
  const name = basename(shell);
  if (name === "fish") return ["-l", "-c", command];
  return ["-i", "-l", "-c", command];
}

function resolveUserShell(userInfoImpl: typeof userInfo) {
  try {
    return userInfoImpl().shell ?? undefined;
  } catch {
    return undefined;
  }
}

function parseMarkedEnv(stdout: string): { env?: NodeJS.ProcessEnv; error?: string } {
  const start = stdout.indexOf(LOGIN_SHELL_ENV_MARKER);
  if (start < 0) return { error: "login shell env marker was not found" };
  const jsonStart = start + LOGIN_SHELL_ENV_MARKER.length;
  const end = stdout.indexOf(LOGIN_SHELL_ENV_MARKER, jsonStart);
  if (end < 0) return { error: "login shell env end marker was not found" };

  const raw = stdout.slice(jsonStart, end);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { error: `login shell env JSON parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "login shell env JSON was not an object" };
  }

  const env: NodeJS.ProcessEnv = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") env[key] = entry;
  }
  return { env };
}

function sanitizeLoginShellEnv(shellEnv: NodeJS.ProcessEnv, baseEnv: NodeJS.ProcessEnv) {
  const env = { ...shellEnv };
  restoreOrDelete(env, baseEnv, "ELECTRON_RUN_AS_NODE");
  restoreOrDelete(env, baseEnv, "ELECTRON_NO_ATTACH_CONSOLE");
  delete env.XDG_RUNTIME_DIR;
  return env;
}

function preserveHostControlEnv(env: NodeJS.ProcessEnv, baseEnv: NodeJS.ProcessEnv) {
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (key.startsWith("VELA_DESKTOP_")) env[key] = value;
    if (key === "VELAD_DATABASE_URL") env[key] = value;
  }
}

function restoreOrDelete(env: NodeJS.ProcessEnv, baseEnv: NodeJS.ProcessEnv, key: string) {
  if (baseEnv[key] === undefined) {
    delete env[key];
    return;
  }
  env[key] = baseEnv[key];
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
