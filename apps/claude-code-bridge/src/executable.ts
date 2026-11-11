import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where to look for the Claude Code CLI. The launch environment owns this
 * choice; command-supplied session env must not be passed in.
 */
export interface ClaudeExecutableResolveInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  /** Caller pin. When set, it must be an executable file; search does not continue. */
  readonly explicit?: string;
}

/** The CLI could not be resolved. The SDK bundled binary is intentionally not a candidate. */
export class ClaudeExecutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeExecutableError";
  }
}

const INSTALL_HINT = "Install Claude Code, or set CLAUDE_CODE_EXECUTABLE to the claude binary.";

/**
 * Resolve the Claude Code CLI the Agent SDK must run.
 *
 * Order: an explicit path, then `CLAUDE_CODE_EXECUTABLE`, then `PATH`
 * (`claude.exe` on Windows), then per-user and npm-global install locations.
 * A set-but-unusable pin is an error. Nothing here falls back to the binary
 * shipped inside `@anthropic-ai/claude-agent-sdk`.
 */
export function resolveClaudeCodeExecutable(input: ClaudeExecutableResolveInput = {}): string {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  const name = executableName(platform);

  if (input.explicit !== undefined) {
    return requireExecutable(input.explicit, platform, "Claude executable path");
  }
  if (env.CLAUDE_CODE_EXECUTABLE !== undefined) {
    return requireExecutable(env.CLAUDE_CODE_EXECUTABLE, platform, "CLAUDE_CODE_EXECUTABLE");
  }

  const fromPath = findOnPath(env, platform, name);
  if (fromPath !== undefined) return fromPath;

  for (const candidate of homeCandidates(home, name)) {
    if (isExecutableFile(candidate, platform)) return candidate;
  }
  const npmDirectory = npmGlobalDirectory(env, platform);
  if (npmDirectory !== undefined) {
    const candidate = join(npmDirectory, name);
    if (isExecutableFile(candidate, platform)) return candidate;
  }

  throw new ClaudeExecutableError(
    `Claude Code executable was not found. ${INSTALL_HINT} This bridge does not use the Agent SDK bundled binary.`,
  );
}

function executableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "claude.exe" : "claude";
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function requireExecutable(filePath: string, platform: NodeJS.Platform, label: string): string {
  const candidate = filePath.trim();
  if (candidate.length === 0 || !isExecutableFile(candidate, platform)) {
    throw new ClaudeExecutableError(
      `${label} is set but does not point to an executable file. ${INSTALL_HINT}`,
    );
  }
  return candidate;
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    const info = statSync(filePath);
    if (!info.isFile()) return false;
    // Windows execution is by file type, not the Unix mode bit.
    if (platform === "win32") return true;
    return (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function pathEntries(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): readonly string[] {
  const raw = env.PATH ?? (platform === "win32" ? env.Path : undefined) ?? "";
  return raw.split(pathDelimiter(platform));
}

function findOnPath(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  name: string,
): string | undefined {
  for (const entry of pathEntries(env, platform)) {
    if (entry.length === 0) continue;
    const candidate = join(entry, name);
    if (isExecutableFile(candidate, platform)) return candidate;
  }
  return undefined;
}

function homeCandidates(home: string, name: string): readonly string[] {
  return [
    join(home, ".claude", "local", name),
    join(home, ".local", "bin", name),
  ];
}

/**
 * npm's global bin directory. Windows puts shims in the prefix itself;
 * other platforms use `prefix/bin`. `npm prefix -g` runs only after the
 * per-user locations miss, and only in this bridge process.
 */
function npmGlobalDirectory(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string | undefined {
  const configured = env.npm_config_prefix?.trim();
  const prefix = configured !== undefined && configured.length > 0 ? configured : probeNpmPrefix(env);
  if (prefix === undefined) return undefined;
  return platform === "win32" ? prefix : join(prefix, "bin");
}

function probeNpmPrefix(env: Readonly<Record<string, string | undefined>>): string | undefined {
  try {
    const stdout = execFileSync("npm", ["prefix", "-g"], {
      env: stringEnv(env),
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const prefix = stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0).at(-1);
    return prefix === undefined || prefix.length === 0 ? undefined : prefix;
  } catch {
    return undefined;
  }
}

function stringEnv(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") copy[key] = value;
  }
  return copy;
}
