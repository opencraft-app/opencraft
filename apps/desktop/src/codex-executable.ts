import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/**
 * The Codex binary OpenCraft starts: an explicit override, then the pinned
 * native Codex packaged with the desktop app (the protocol version its adapter
 * targets), then a user-installed Codex.
 */
export async function resolveCodexExecutable(options: {
  readonly explicit?: string | null;
  readonly bundled?: string | null;
  readonly path?: string | null;
  readonly homeDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly isExecutable?: (path: string) => boolean | Promise<boolean>;
}): Promise<string> {
  const isExecutable = options.isExecutable ?? ((path: string) => access(path, constants.X_OK).then(() => true, () => false));
  const explicit = options.explicit?.trim();
  if (explicit) return isAbsolute(explicit) ? resolve(explicit) : explicit;
  if (options.bundled && await isExecutable(options.bundled)) return options.bundled;
  const executableName = (options.platform ?? process.platform) === "win32" ? "codex.exe" : "codex";
  const candidates = [
    ...(options.path ?? "").split(delimiter).filter(Boolean).map(directory => join(directory, executableName)),
    join(options.homeDirectory, ".local", "bin", executableName),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  for (const candidate of candidates) if (await isExecutable(candidate)) return candidate;
  return executableName;
}
