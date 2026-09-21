// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type { BotRepository } from "../../repositories/types";
import { isExecCommandSucceeded, truncateExecOutput } from "./agent-reset-config";
import { getHermesProfileRootCommand, withHermesProfile } from "../../lib/hermes-agent-command";

export const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
export const DEFAULT_USER_CHAR_LIMIT = 1375;
export const HERMES_MEMORY_LIMIT_MIN = 500;
export const HERMES_MEMORY_CHAR_LIMIT_MAX = 4000;
export const HERMES_USER_CHAR_LIMIT_MAX = 3000;
export const HERMES_MEMORY_LIMIT_SAFE_BUFFER = 200;
export const HERMES_MEMORY_COMMAND_TIMEOUT_MS = 120_000;
export const HERMES_MEMORY_JSON_START = "__LIGHTVELA_HERMES_MEMORY_JSON_START__";
export const HERMES_MEMORY_JSON_END = "__LIGHTVELA_HERMES_MEMORY_JSON_END__";

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

const PYTHON_MEMORY_READER = String.raw`import json, os
from pathlib import Path

try:
    import yaml
except ModuleNotFoundError:
    raise SystemExit("PyYAML is unavailable. Repair the Hermes runtime environment and try again.")

root = Path(os.environ["HERMES_ROOT"])
config = root / "config.yaml"
memory_file = root / "memories" / "MEMORY.md"
user_file = root / "memories" / "USER.md"

def read_optional_text(path):
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None

config_text = read_optional_text(config)
config_payload = yaml.safe_load(config_text) if config_text is not None else {}
if config_payload is None:
    config_payload = {}
if not isinstance(config_payload, dict):
    raise ValueError("Hermes config root must be a mapping")

memory_config = config_payload.get("memory", {})
if memory_config is None:
    memory_config = {}
if not isinstance(memory_config, dict):
    raise ValueError("Hermes memory config must be a mapping")

def read_limit(key, default):
    if key not in memory_config:
        return default, True
    value = memory_config[key]
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"Hermes memory config {key} must be a positive integer")
    return value, False

memory_text = read_optional_text(memory_file) or ""
user_text = read_optional_text(user_file) or ""
memory_limit, memory_fallback = read_limit("memory_char_limit", ${DEFAULT_MEMORY_CHAR_LIMIT})
user_limit, user_fallback = read_limit("user_char_limit", ${DEFAULT_USER_CHAR_LIMIT})

print("${HERMES_MEMORY_JSON_START}")
print(json.dumps({
    "memoryCharLimit": memory_limit,
    "userCharLimit": user_limit,
    "memoryChars": len(memory_text),
    "userChars": len(user_text),
    "memoryText": memory_text,
    "userText": user_text,
    "usedFallbackLimits": config_text is None or memory_fallback or user_fallback,
}, ensure_ascii=False))
print("${HERMES_MEMORY_JSON_END}")`;

export function buildHermesMemoryReadCommand(profileId = "main"): string {
  return [
    'HERMES_BASE="${HERMES_HOME:-$HOME/.hermes}"',
    getHermesProfileRootCommand(profileId, "HERMES_ROOT"),
    "export HERMES_ROOT",
    'HERMES_PYTHON="$HERMES_BASE/hermes-agent/venv/bin/python"',
    'if [ ! -x "$HERMES_PYTHON" ]; then HERMES_PYTHON="python3"; fi',
    '"$HERMES_PYTHON" - <<\'PY\'',
    PYTHON_MEMORY_READER,
    "PY",
  ].join("\n");
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

export function buildHermesMemoryLimitCommand(target: HermesMemoryLimitTarget, value: number, existingChars = 0, profileId = "main"): string {
  const validation = validateHermesMemoryLimit(target, String(value), existingChars);
  if (!validation.ok) {
    throw new Error("invalid Hermes memory limit");
  }

  const key = target === "memory" ? "memory.memory_char_limit" : "memory.user_char_limit";
  return withHermesProfile(`config set ${key} ${validation.value}`, profileId);
}

export function isHermesMemoryLimitNearUsage(value: number, used: number, currentLimit: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(used) || !Number.isFinite(currentLimit)) return false;
  return value < currentLimit && value - used < HERMES_MEMORY_LIMIT_SAFE_BUFFER;
}

function parseJsonObject(output: string): Record<string, unknown> {
  const start = output.indexOf(HERMES_MEMORY_JSON_START);
  const end = output.indexOf(HERMES_MEMORY_JSON_END, start + HERMES_MEMORY_JSON_START.length);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("memory JSON block was not found");
  }

  const jsonText = output.slice(start + HERMES_MEMORY_JSON_START.length, end).trim();
  const parsed = JSON.parse(jsonText) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("memory payload is not an object");
  }
  return parsed as Record<string, unknown>;
}

function readInteger(payload: Record<string, unknown>, key: string, minimum: number): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`memory payload field ${key} is invalid`);
  }
  return value;
}

function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new Error(`memory payload field ${key} is invalid`);
  }
  return value;
}

export function parseHermesMemorySnapshot(output: string): HermesMemorySnapshot {
  const payload = parseJsonObject(output);
  const memoryCharLimit = readInteger(payload, "memoryCharLimit", 1);
  const userCharLimit = readInteger(payload, "userCharLimit", 1);
  const memoryChars = readInteger(payload, "memoryChars", 0);
  const userChars = readInteger(payload, "userChars", 0);
  const memoryText = readString(payload, "memoryText");
  const userText = readString(payload, "userText");
  if (typeof payload.usedFallbackLimits !== "boolean") {
    throw new Error("memory payload field usedFallbackLimits is invalid");
  }
  return {
    memoryCharLimit,
    userCharLimit,
    memoryChars,
    userChars,
    memoryText,
    userText,
    usedFallbackLimits: payload.usedFallbackLimits,
  };
}

export async function fetchHermesMemorySnapshot(
  bots: BotRepository,
  botId: string,
  profileId = "main",
): Promise<HermesMemorySnapshot> {
  const result = await bots.execDebugCommand(
    botId,
    buildHermesMemoryReadCommand(profileId),
    { timeoutMs: HERMES_MEMORY_COMMAND_TIMEOUT_MS },
  );
  if (!isExecCommandSucceeded(result)) {
    throw new Error(`Hermes memory command failed: ${truncateExecOutput(result.output, result.status)}`);
  }
  return parseHermesMemorySnapshot(result.output);
}

export function splitHermesMemoryEntries(text: string): string[] {
  return text
    .split("§")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getMemoryUsagePercent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}
