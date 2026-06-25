import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DesktopBackendKind =
  | "vela_engine"
  | "codex"
  | "cloudagent"
  | "claude_code"
  | "pi"
  | "opencode"
  | "acp"
  | "qoder";

export interface DesktopSettings {
  defaultBackend: DesktopBackendKind | "";
}

const DEFAULT_SETTINGS: DesktopSettings = {
  defaultBackend: "",
};

export function desktopSettingsPath(userDataPath: string) {
  return join(userDataPath, "desktop-settings.json");
}

export function readDesktopSettings(userDataPath: string): DesktopSettings {
  const path = desktopSettingsPath(userDataPath);
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeDesktopSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeDesktopSettings(
  userDataPath: string,
  settings: Partial<DesktopSettings>,
) {
  const next = normalizeDesktopSettings({
    ...readDesktopSettings(userDataPath),
    ...settings,
  });
  const path = desktopSettingsPath(userDataPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function normalizeDesktopSettings(value: unknown): DesktopSettings {
  const record = isRecord(value) ? value : {};
  return {
    defaultBackend: backendKindValue(record.defaultBackend),
  };
}

function backendKindValue(value: unknown): DesktopSettings["defaultBackend"] {
  if (typeof value !== "string") return "";
  return isDesktopBackendKind(value) ? value : "";
}

function isDesktopBackendKind(value: string): value is DesktopBackendKind {
  return (
    value === "vela_engine" ||
    value === "codex" ||
    value === "cloudagent" ||
    value === "claude_code" ||
    value === "pi" ||
    value === "opencode" ||
    value === "acp" ||
    value === "qoder"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
