import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface VelaEngineSettings {
  endpoint: string;
  apiKey: string;
  model: string;
}

const DEFAULT_SETTINGS: VelaEngineSettings = {
  endpoint: "",
  apiKey: "",
  model: "",
};

export function velaEngineSettingsPath(userDataPath: string) {
  return join(userDataPath, "vela-engine-settings.json");
}

export function readVelaEngineSettings(userDataPath: string): VelaEngineSettings {
  const path = velaEngineSettingsPath(userDataPath);
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeVelaEngineSettings(
  userDataPath: string,
  settings: Partial<VelaEngineSettings>,
) {
  const next = normalizeSettings({
    ...readVelaEngineSettings(userDataPath),
    ...settings,
  });
  const path = velaEngineSettingsPath(userDataPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function velaEngineSettingsEnv(settings: VelaEngineSettings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (settings.endpoint.trim()) env.VELAD_VELA_ENGINE_ENDPOINT = settings.endpoint.trim();
  if (settings.apiKey.trim()) env.VELAD_VELA_ENGINE_API_KEY = settings.apiKey.trim();
  if (settings.model.trim()) env.VELAD_VELA_ENGINE_MODEL = settings.model.trim();
  return env;
}

function normalizeSettings(value: unknown): VelaEngineSettings {
  const record = isRecord(value) ? value : {};
  return {
    endpoint: stringValue(record.endpoint),
    apiKey: stringValue(record.apiKey),
    model: stringValue(record.model),
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
