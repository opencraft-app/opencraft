export const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
export const DEFAULT_USER_CHAR_LIMIT = 1375;
export const HERMES_MEMORY_LIMIT_MIN = 500;
export const HERMES_MEMORY_CHAR_LIMIT_MAX = 4000;
export const HERMES_USER_CHAR_LIMIT_MAX = 3000;

export type HermesMemoryLimitTarget = "memory" | "user";

export type HermesMemoryLimitValidation =
  | { ok: true; value: number; min: number; max: number }
  | { ok: false; reason: "empty" | "integer" | "too_small" | "too_large"; min: number; max: number };

export interface HermesMemorySnapshot {
  memoryCharLimit: number;
  userCharLimit: number;
  memoryChars: number;
  userChars: number;
  memoryText: string;
  userText: string;
  usedFallbackLimits: boolean;
}

const PYTHON_MEMORY_READER = String.raw`import json, re
from pathlib import Path

home = Path.home()
config = home / ".hermes" / "config.yaml"
memory_file = home / ".hermes" / "memories" / "MEMORY.md"
user_file = home / ".hermes" / "memories" / "USER.md"

try:
    config_text = config.read_text(encoding="utf-8")
except Exception:
    config_text = ""

def yaml_int(key, default):
    match = re.search(r"^\s*" + re.escape(key) + r":\s*(\d+)\s*$", config_text, re.M)
    return int(match.group(1)) if match else default

def read_text(path):
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""

memory_text = read_text(memory_file)
user_text = read_text(user_file)
memory_limit = yaml_int("memory_char_limit", ${DEFAULT_MEMORY_CHAR_LIMIT})
user_limit = yaml_int("user_char_limit", ${DEFAULT_USER_CHAR_LIMIT})

print(json.dumps({
    "memoryCharLimit": memory_limit,
    "userCharLimit": user_limit,
    "memoryChars": len(memory_text),
    "userChars": len(user_text),
    "memoryText": memory_text,
    "userText": user_text,
    "usedFallbackLimits": not config_text or memory_limit == ${DEFAULT_MEMORY_CHAR_LIMIT} and "memory_char_limit" not in config_text or user_limit == ${DEFAULT_USER_CHAR_LIMIT} and "user_char_limit" not in config_text,
}, ensure_ascii=False))`;

export function buildHermesMemoryReadCommand(): string {
  return `python3 - <<'PY'\n${PYTHON_MEMORY_READER}\nPY`;
}

function normalizeExistingChars(existingChars: number): number {
  return Number.isFinite(existingChars) && existingChars > 0 ? Math.ceil(existingChars) : 0;
}

export function getHermesMemoryLimitBounds(target: HermesMemoryLimitTarget, existingChars = 0): { min: number; max: number } {
  const contentMin = normalizeExistingChars(existingChars);
  return {
    min: Math.max(HERMES_MEMORY_LIMIT_MIN, contentMin),
    max: target === "memory" ? HERMES_MEMORY_CHAR_LIMIT_MAX : HERMES_USER_CHAR_LIMIT_MAX,
  };
}

export function validateHermesMemoryLimit(target: HermesMemoryLimitTarget, input: string, existingChars = 0): HermesMemoryLimitValidation {
  const { min, max } = getHermesMemoryLimitBounds(target, existingChars);
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty", min, max };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, reason: "integer", min, max };
  }

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, reason: "integer", min, max };
  }
  if (value < min) {
    return { ok: false, reason: "too_small", min, max };
  }
  if (value > max) {
    return { ok: false, reason: "too_large", min, max };
  }

  return { ok: true, value, min, max };
}

export function buildHermesMemoryLimitCommand(target: HermesMemoryLimitTarget, value: number, existingChars = 0): string {
  const validation = validateHermesMemoryLimit(target, String(value), existingChars);
  if (!validation.ok) {
    throw new Error("invalid Hermes memory limit");
  }

  const key = target === "memory" ? "memory.memory_char_limit" : "memory.user_char_limit";
  return `hermes config set ${key} ${validation.value}`;
}

function parseJsonObject(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the bounded parse below. debug/exec may prepend transport noise.
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("memory payload is not valid JSON");
  }

  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("memory payload is not an object");
  }
  return parsed as Record<string, unknown>;
}

function readNumber(payload: Record<string, unknown>, key: string, fallback: number): number {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

export function parseHermesMemorySnapshot(output: string): HermesMemorySnapshot {
  const payload = parseJsonObject(output);
  return {
    memoryCharLimit: readNumber(payload, "memoryCharLimit", DEFAULT_MEMORY_CHAR_LIMIT),
    userCharLimit: readNumber(payload, "userCharLimit", DEFAULT_USER_CHAR_LIMIT),
    memoryChars: readNumber(payload, "memoryChars", 0),
    userChars: readNumber(payload, "userChars", 0),
    memoryText: readString(payload, "memoryText"),
    userText: readString(payload, "userText"),
    usedFallbackLimits: payload.usedFallbackLimits === true,
  };
}

export function splitHermesMemoryEntries(text: string): string[] {
  return text
    .split("§")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function toSingleLineMemoryEntry(entry: string): string {
  return entry.replace(/\s+/g, " ").trim();
}

export function getMemoryUsagePercent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}
