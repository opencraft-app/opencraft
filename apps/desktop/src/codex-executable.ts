import { constants, accessSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/**
 * The Codex binary OpenCraft starts: an explicit override, then the pinned
 * native Codex packaged with the desktop app (the protocol version its adapter
 * targets), then a user-installed Codex.
 */
/** Where the Codex the desktop starts came from. Builtin is the pinned bundled Codex. */
export type CodexExecutableSource = "explicit" | "builtin" | "user-installed" | "unresolved";

export function resolveCodexExecutable(options: Parameters<typeof resolveCodexLaunch>[0]): string {
  return resolveCodexLaunch(options).executable;
}

/**
 * Same order as {@link resolveCodexExecutable}, also naming the source. A packaged
 * app whose bundled Codex is missing falls back to a user-installed one; the
 * source keeps that visible instead of treating it as the builtin Codex.
 */
export function resolveCodexLaunch(options: {
  readonly explicit?: string | null;
  readonly bundled?: string | null;
  readonly path?: string | null;
  readonly homeDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly isExecutable?: (path: string) => boolean;
}): { readonly executable: string; readonly source: CodexExecutableSource } {
  const isExecutable = options.isExecutable ?? ((path: string) => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
  const explicit = options.explicit?.trim();
  if (explicit) return { executable: isAbsolute(explicit) ? resolve(explicit) : explicit, source: "explicit" };
  if (options.bundled && isExecutable(options.bundled)) return { executable: options.bundled, source: "builtin" };
  const executableName = (options.platform ?? process.platform) === "win32" ? "codex.exe" : "codex";
  const candidates = [
    ...(options.path ?? "").split(delimiter).filter(Boolean).map(directory => join(directory, executableName)),
    join(options.homeDirectory, ".local", "bin", executableName),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  const found = candidates.find(isExecutable);
  return found ? { executable: found, source: "user-installed" } : { executable: executableName, source: "unresolved" };
}
