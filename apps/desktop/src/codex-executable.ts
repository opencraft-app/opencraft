import { constants, accessSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export function resolveCodexExecutable(options: {
  readonly explicit?: string | null;
  readonly path?: string | null;
  readonly homeDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly isExecutable?: (path: string) => boolean;
}): string {
  const isExecutable = options.isExecutable ?? ((path: string) => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
  const explicit = options.explicit?.trim();
  if (explicit) return isAbsolute(explicit) ? resolve(explicit) : explicit;
  const executableName = (options.platform ?? process.platform) === "win32" ? "codex.exe" : "codex";
  const candidates = [
    ...(options.path ?? "").split(delimiter).filter(Boolean).map(directory => join(directory, executableName)),
    join(options.homeDirectory, ".local", "bin", executableName),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  return candidates.find(isExecutable) ?? executableName;
}
