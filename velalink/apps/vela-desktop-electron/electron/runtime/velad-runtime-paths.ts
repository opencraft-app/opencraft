import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface RuntimePathHost {
  getPath(name: "home" | "userData"): string;
}

export function bundledVeladPath(resourcesPath: string) {
  const binaryName = process.platform === "win32" ? "velad.exe" : "velad";
  const packagedPath = join(resourcesPath, "bin", binaryName);
  if (existsSync(packagedPath)) return packagedPath;
  return null;
}

export function bundledVeladDatabaseUrl(host: RuntimePathHost, configuredDatabaseUrl?: string) {
  if (configuredDatabaseUrl) return configuredDatabaseUrl;

  const dataDir = join(host.getPath("userData"), "runtime", "velad");
  mkdirSync(dataDir, { recursive: true });
  return `${pathToFileURL(join(dataDir, "vela.sqlite")).href.replace(/^file:/, "sqlite:")}?mode=rwc`;
}

export function desktopRuntimeEnv(host: RuntimePathHost, baseEnv: NodeJS.ProcessEnv) {
  const home = baseEnv.HOME ?? host.getPath("home");
  const pathEntries = [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    baseEnv.PATH ?? "",
  ].filter(Boolean);
  return {
    ...baseEnv,
    PATH: Array.from(new Set(pathEntries.flatMap((entry) => entry.split(":")).filter(Boolean))).join(":"),
  };
}
