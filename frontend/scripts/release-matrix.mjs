import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_MATRIX_PATH = resolve(process.cwd(), "release-matrix.json");
const VALID_REGIONS = new Set(["cn", "global"]);
const VALID_CHANNELS = new Set(["cf", "eo"]);

function ensureNonEmptyString(value, fieldName, comboId) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`release matrix combo ${comboId} is missing required string field ${fieldName}`);
  }
  return value.trim();
}

function ensureStringArray(value, fieldName, comboId) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`release matrix combo ${comboId} must define ${fieldName} as a non-empty string array`);
  }
  return value.map((item) => item.trim());
}

function ensureStringMap(value, fieldName, comboId) {
  if (value == null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`release matrix combo ${comboId} must define ${fieldName} as a string map`);
  }

  const entries = Object.entries(value);
  for (const [key, item] of entries) {
    if (typeof key !== "string" || key.trim().length === 0 || typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`release matrix combo ${comboId} must define ${fieldName} as a string map`);
    }
  }
  return Object.fromEntries(entries.map(([key, item]) => [key.trim(), item.trim()]));
}

function ensureOptionalString(value, fieldName, comboId) {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`release matrix combo ${comboId} must define ${fieldName} as a non-empty string`);
  }
  return value.trim();
}

function ensureObservabilityConfig(value, comboId) {
  if (value == null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`release matrix combo ${comboId} must define observability as an object`);
  }

  const aegis = value.aegis;
  if (aegis == null) {
    return {};
  }
  if (typeof aegis !== "object" || Array.isArray(aegis)) {
    throw new Error(`release matrix combo ${comboId} must define observability.aegis as an object`);
  }

  const enabled = ensureOptionalString(aegis.enabled, "observability.aegis.enabled", comboId);
  if (enabled && !["true", "false", "auto"].includes(enabled)) {
    throw new Error(`release matrix combo ${comboId} has unsupported observability.aegis.enabled ${enabled}`);
  }
  const id = ensureOptionalString(aegis.id, "observability.aegis.id", comboId);
  const hostUrl = ensureOptionalString(aegis.hostUrl, "observability.aegis.hostUrl", comboId);
  if (enabled === "true" && (!id || !hostUrl)) {
    throw new Error(`release matrix combo ${comboId} must define observability.aegis.id and hostUrl when enabled=true`);
  }

  return {
    aegis: {
      enabled: enabled ?? "auto",
      id,
      hostUrl,
    },
  };
}

export function loadReleaseMatrix(matrixPath = process.env.FRONTEND_RELEASE_MATRIX_FILE?.trim() || DEFAULT_MATRIX_PATH) {
  const raw = JSON.parse(readFileSync(matrixPath, "utf8"));
  if (!raw || !Array.isArray(raw.combos)) {
    throw new Error(`release matrix file ${matrixPath} must contain a combos array`);
  }

  const seen = new Set();
  const combos = raw.combos.map((combo) => {
    const id = ensureNonEmptyString(combo.id, "id", "<unknown>");
    if (seen.has(id)) {
      throw new Error(`release matrix file ${matrixPath} contains duplicate combo id ${id}`);
    }
    seen.add(id);

    const region = ensureNonEmptyString(combo.region, "region", id);
    const channel = ensureNonEmptyString(combo.channel, "channel", id);
    if (!VALID_REGIONS.has(region)) {
      throw new Error(`release matrix combo ${id} has unsupported region ${region}`);
    }
    if (!VALID_CHANNELS.has(channel)) {
      throw new Error(`release matrix combo ${id} has unsupported channel ${channel}`);
    }

    const normalized = {
      id,
      region,
      channel,
      buildCommand: ensureNonEmptyString(combo.buildCommand, "buildCommand", id),
      deployCommand: ensureNonEmptyString(combo.deployCommand, "deployCommand", id),
      projectName: ensureNonEmptyString(combo.projectName, "projectName", id),
      requiredSecretEnv: ensureStringArray(combo.requiredSecretEnv, "requiredSecretEnv", id),
      authApiBaseUrl: ensureNonEmptyString(combo.authApiBaseUrl, "authApiBaseUrl", id),
      outputDir: ensureNonEmptyString(combo.outputDir, "outputDir", id),
      deployEnv: ensureStringMap(combo.deployEnv, "deployEnv", id),
      observability: ensureObservabilityConfig(combo.observability, id),
    };

    return normalized;
  });

  return { matrixPath, combos };
}

export function resolveSelectedComboIds(selection = process.env.FRONTEND_RELEASE_MATRIX?.trim() || "") {
  if (!selection) {
    return null;
  }
  const ids = selection
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    return null;
  }
  return [...new Set(ids)];
}

export function selectReleaseCombos(combos, selectedIds) {
  if (!selectedIds || selectedIds.length === 0) {
    return combos;
  }

  const byId = new Map(combos.map((combo) => [combo.id, combo]));
  const missing = selectedIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`unknown frontend release matrix combo id(s): ${missing.join(", ")}`);
  }
  return selectedIds.map((id) => byId.get(id));
}

export function resolveComboProjectName(combo, env = process.env) {
  return combo.projectName;
}

export function validateRequiredSecrets(combo, env = process.env) {
  const missing = combo.requiredSecretEnv.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`release matrix combo ${combo.id} is missing required env var(s): ${missing.join(", ")}`);
  }
}

export function createComboEnvironment(combo, projectName, env = process.env) {
  const nextEnv = {
    ...env,
    ...combo.deployEnv,
    FRONTEND_RELEASE_COMBO_ID: combo.id,
    FRONTEND_RELEASE_REGION: combo.region,
    FRONTEND_RELEASE_CHANNEL: combo.channel,
    VITE_AUTH_API_BASE_URL: combo.authApiBaseUrl,
  };

  const aegis = combo.observability?.aegis;
  if (aegis) {
    nextEnv.VITE_AEGIS_ENABLED = aegis.enabled ?? "auto";
    if (aegis.id) {
      nextEnv.VITE_AEGIS_ID = aegis.id;
    } else {
      delete nextEnv.VITE_AEGIS_ID;
    }
    if (aegis.hostUrl) {
      nextEnv.VITE_AEGIS_HOST_URL = aegis.hostUrl;
    } else {
      delete nextEnv.VITE_AEGIS_HOST_URL;
    }
  } else {
    nextEnv.VITE_AEGIS_ENABLED = "false";
    delete nextEnv.VITE_AEGIS_ID;
    delete nextEnv.VITE_AEGIS_HOST_URL;
  }

  if (combo.channel === "cf") {
    nextEnv.CLOUDFLARE_PAGES_PROJECT_NAME = projectName;
    nextEnv.CLOUDFLARE_PAGES_DIR = combo.outputDir;
  } else if (combo.channel === "eo") {
    nextEnv.EDGEONE_PAGES_PROJECT_NAME = projectName;
    nextEnv.EDGEONE_PAGES_DIR = combo.outputDir;
  }

  return nextEnv;
}

function runPnpmScript(scriptName, env) {
  const pnpmBin = env.PNPM_BIN?.trim() || "pnpm";
  const result = spawnSync(pnpmBin, ["run", scriptName], {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`pnpm run ${scriptName} failed with exit code ${result.status ?? 1}`);
  }
}

export function formatComboSummary(combo, projectName) {
  return `${combo.id} (region=${combo.region}, channel=${combo.channel}, project=${projectName}, outputDir=${combo.outputDir})`;
}

export function executeReleaseMatrix({ env = process.env, log = console.log } = {}) {
  const { matrixPath, combos } = loadReleaseMatrix();
  const selectedIds = resolveSelectedComboIds(env.FRONTEND_RELEASE_MATRIX);
  const selectedCombos = selectReleaseCombos(combos, selectedIds);

  log(`frontend release matrix file: ${matrixPath}`);
  log(
    `frontend release matrix selection: ${selectedCombos
      .map((combo) => combo.id)
      .join(", ")}`,
  );

  for (const combo of selectedCombos) {
    validateRequiredSecrets(combo, env);
    const projectName = resolveComboProjectName(combo, env);
    const comboEnv = createComboEnvironment(combo, projectName, env);

    log(`frontend release combo start: ${formatComboSummary(combo, projectName)}`);
    runPnpmScript(combo.buildCommand, comboEnv);
    runPnpmScript(combo.deployCommand, comboEnv);
    log(`frontend release combo done: ${combo.id}`);
  }
}

const currentModulePath = import.meta.url.startsWith("file:")
  ? fileURLToPath(import.meta.url)
  : resolve(process.cwd(), "scripts/release-matrix.mjs");
const isMainModule = process.argv[1] && resolve(process.argv[1]) === currentModulePath;

if (isMainModule) {
  executeReleaseMatrix();
}
