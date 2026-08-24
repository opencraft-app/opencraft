import type { BotRepository } from "@/repositories/types";
import { isExecCommandSucceeded, truncateExecOutput } from "@/pages/marketing/agent-reset-config";

export const HERMES_COMMON_SETTINGS_TIMEOUT_MS = 120_000;
export const HERMES_COMMON_SETTINGS_JSON_START = "__LIGHTVELA_HERMES_COMMON_SETTINGS_JSON_START__";
export const HERMES_COMMON_SETTINGS_JSON_END = "__LIGHTVELA_HERMES_COMMON_SETTINGS_JSON_END__";

export const HERMES_COMMON_SETTING_KEYS = [
  "persistentMemory",
  "userProfile",
  "autoCompression",
  "compressionThreshold",
  "compressionTarget",
  "protectedRecentMessages",
] as const;

export type HermesCommonSettingKey = (typeof HERMES_COMMON_SETTING_KEYS)[number];
export type HermesCommonSettingValue = boolean | number;

export const HERMES_COMMON_SETTING_KEYS_BY_GROUP = {
  memory: ["persistentMemory", "userProfile"],
  context: [
    "autoCompression",
    "compressionThreshold",
    "compressionTarget",
    "protectedRecentMessages",
  ],
} as const satisfies Record<string, readonly HermesCommonSettingKey[]>;

export type HermesCommonSettingGroup = keyof typeof HERMES_COMMON_SETTING_KEYS_BY_GROUP;

export function getHermesCommonSettingKeysForGroup(
  group: HermesCommonSettingGroup,
): readonly HermesCommonSettingKey[] {
  return HERMES_COMMON_SETTING_KEYS_BY_GROUP[group];
}

export interface HermesCommonSettingsValues {
  persistentMemory: boolean;
  userProfile: boolean;
  autoCompression: boolean;
  compressionThreshold: number;
  compressionTarget: number;
  protectedRecentMessages: number;
}

export interface HermesCommonSettingsSnapshot {
  values: HermesCommonSettingsValues;
  defaultedKeys: HermesCommonSettingKey[];
  unsupportedKeys: HermesCommonSettingKey[];
}

export type HermesCommonSettingValidation =
  | { ok: true; value: HermesCommonSettingValue }
  | { ok: false; reason: "empty" | "number" | "integer" | "range" | "type" };

const HERMES_CONFIG_KEY_BY_SETTING: Record<HermesCommonSettingKey, string> = {
  persistentMemory: "memory.memory_enabled",
  userProfile: "memory.user_profile_enabled",
  autoCompression: "compression.enabled",
  compressionThreshold: "compression.threshold",
  compressionTarget: "compression.target_ratio",
  protectedRecentMessages: "compression.protect_last_n",
};

const PYTHON_COMMON_SETTINGS_READER = String.raw`import json, os, subprocess
from pathlib import Path

try:
    import yaml
except ModuleNotFoundError:
    raise SystemExit("PyYAML is unavailable. Repair the Hermes runtime environment and try again.")

root = Path(os.environ["HERMES_ROOT"])
config_path = root / "config.yaml"
try:
    path_result = subprocess.run(
        ["hermes", "config", "path"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )
    if path_result.returncode == 0 and path_result.stdout.strip():
        config_path = Path(path_result.stdout.strip())
except (FileNotFoundError, subprocess.TimeoutExpired):
    pass
config_payload = {}
if config_path.exists():
    config_payload = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
if not isinstance(config_payload, dict):
    raise ValueError("Hermes config root must be a mapping")

fields = {
    "persistentMemory": ("memory.memory_enabled", True),
    "userProfile": ("memory.user_profile_enabled", True),
    "autoCompression": ("compression.enabled", True),
    "compressionThreshold": ("compression.threshold", 0.5),
    "compressionTarget": ("compression.target_ratio", 0.2),
    "protectedRecentMessages": ("compression.protect_last_n", 20),
}

def is_explicit(dotted_key):
    current = config_payload
    for part in dotted_key.split("."):
        if not isinstance(current, dict) or part not in current:
            return False
        current = current[part]
    return True

values = {}
defaulted_keys = []
unsupported_keys = []

def valid_value(field, value):
    if field in ("persistentMemory", "userProfile", "autoCompression"):
        return isinstance(value, bool)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if field == "compressionThreshold":
        return 0 <= value <= 1
    if field == "compressionTarget":
        return 0.1 <= value <= 0.8
    return isinstance(value, int) and value >= 1

for field, (dotted_key, fallback) in fields.items():
    values[field] = fallback
    if not is_explicit(dotted_key):
        defaulted_keys.append(field)
    try:
        result = subprocess.run(
            ["hermes", "config", "get", dotted_key, "--json"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
        if result.returncode != 0:
            unsupported_keys.append(field)
            continue
        resolved_value = json.loads(result.stdout.strip())
        if not valid_value(field, resolved_value):
            unsupported_keys.append(field)
            continue
        values[field] = resolved_value
    except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError):
        unsupported_keys.append(field)

print("${HERMES_COMMON_SETTINGS_JSON_START}")
print(json.dumps({
    "values": values,
    "defaultedKeys": defaulted_keys,
    "unsupportedKeys": unsupported_keys,
}, ensure_ascii=False))
print("${HERMES_COMMON_SETTINGS_JSON_END}")`;

export function buildHermesCommonSettingsReadCommand(): string {
  return [
    'HERMES_ROOT="${HERMES_HOME:-$HOME/.hermes}"',
    "export HERMES_ROOT",
    'HERMES_PYTHON="$HERMES_ROOT/hermes-agent/venv/bin/python"',
    'if [ ! -x "$HERMES_PYTHON" ]; then HERMES_PYTHON="python3"; fi',
    '"$HERMES_PYTHON" - <<\'PY\'',
    PYTHON_COMMON_SETTINGS_READER,
    "PY",
  ].join("\n");
}

function isHermesCommonSettingKey(value: unknown): value is HermesCommonSettingKey {
  return typeof value === "string" && HERMES_COMMON_SETTING_KEYS.includes(value as HermesCommonSettingKey);
}

function parseJsonObject(output: string): Record<string, unknown> {
  const start = output.indexOf(HERMES_COMMON_SETTINGS_JSON_START);
  const end = output.indexOf(
    HERMES_COMMON_SETTINGS_JSON_END,
    start + HERMES_COMMON_SETTINGS_JSON_START.length,
  );
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("common settings JSON block was not found");
  }
  const parsed = JSON.parse(
    output.slice(start + HERMES_COMMON_SETTINGS_JSON_START.length, end).trim(),
  ) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("common settings payload is not an object");
  }
  return parsed as Record<string, unknown>;
}

function readKeyArray(payload: Record<string, unknown>, key: string): HermesCommonSettingKey[] {
  const value = payload[key];
  if (!Array.isArray(value) || !value.every(isHermesCommonSettingKey)) {
    throw new Error(`common settings payload field ${key} is invalid`);
  }
  return [...new Set(value)];
}

export function validateHermesCommonSetting(
  key: HermesCommonSettingKey,
  input: string | HermesCommonSettingValue,
): HermesCommonSettingValidation {
  if (key === "persistentMemory" || key === "userProfile" || key === "autoCompression") {
    return typeof input === "boolean" ? { ok: true, value: input } : { ok: false, reason: "type" };
  }

  if (typeof input === "string" && input.trim() === "") {
    return { ok: false, reason: "empty" };
  }
  if (typeof input === "boolean") {
    return { ok: false, reason: "type" };
  }
  const value = typeof input === "number" ? input : Number(input.trim());
  if (!Number.isFinite(value)) {
    return { ok: false, reason: "number" };
  }

  if (key === "compressionThreshold") {
    return value >= 0 && value <= 1 ? { ok: true, value } : { ok: false, reason: "range" };
  }
  if (key === "compressionTarget") {
    return value >= 0.1 && value <= 0.8 ? { ok: true, value } : { ok: false, reason: "range" };
  }
  if (!Number.isSafeInteger(value)) {
    return { ok: false, reason: "integer" };
  }
  return value >= 1 ? { ok: true, value } : { ok: false, reason: "range" };
}

export function parseHermesCommonSettingsSnapshot(output: string): HermesCommonSettingsSnapshot {
  const payload = parseJsonObject(output);
  const rawValues = payload.values;
  if (!rawValues || typeof rawValues !== "object" || Array.isArray(rawValues)) {
    throw new Error("common settings payload field values is invalid");
  }

  const valuesPayload = rawValues as Record<string, unknown>;
  const values = {} as HermesCommonSettingsValues;
  for (const key of HERMES_COMMON_SETTING_KEYS) {
    const rawValue = valuesPayload[key];
    if (typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") {
      throw new Error(`common settings payload field ${key} is invalid`);
    }
    const validation = validateHermesCommonSetting(key, rawValue);
    if (!validation.ok) {
      throw new Error(`common settings payload field ${key} is invalid`);
    }
    Object.assign(values, { [key]: validation.value });
  }

  return {
    values,
    defaultedKeys: readKeyArray(payload, "defaultedKeys"),
    unsupportedKeys: readKeyArray(payload, "unsupportedKeys"),
  };
}

export function buildHermesCommonSettingCommand(
  key: HermesCommonSettingKey,
  value: HermesCommonSettingValue,
): string {
  const validation = validateHermesCommonSetting(key, value);
  if (!validation.ok) {
    throw new Error("invalid Hermes common setting");
  }
  return `hermes config set ${HERMES_CONFIG_KEY_BY_SETTING[key]} ${String(validation.value)}`;
}

export function buildHermesCommonSettingUnsetCommand(key: HermesCommonSettingKey): string {
  return `hermes config unset ${HERMES_CONFIG_KEY_BY_SETTING[key]}`;
}

export async function fetchHermesCommonSettingsSnapshot(
  bots: BotRepository,
  botId: string,
): Promise<HermesCommonSettingsSnapshot> {
  const result = await bots.execDebugCommand(
    botId,
    buildHermesCommonSettingsReadCommand(),
    { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
  );
  if (!isExecCommandSucceeded(result)) {
    throw new Error(`Hermes common settings command failed: ${truncateExecOutput(result.output, result.status)}`);
  }
  return parseHermesCommonSettingsSnapshot(result.output);
}
