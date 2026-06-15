import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARTIFACT_MODE_REQUIRED,
  archiveAndVerifyFrontendArtifact,
  colorText,
  highlightArtifactRef,
  highlightComboId,
  logReleaseHint,
  logReleaseHintSummary,
  normalizeComboIdForTag,
  resolveArtifactMode,
  validateArtifactPrerequisites,
} from "./frontend-artifact.mjs";
import {
  createComboEnvironment,
  formatComboSummary,
  loadReleaseMatrix,
  resolveComboProjectName,
  resolveSelectedComboIds,
  selectReleaseCombos,
} from "./release-matrix.mjs";

const DEFAULT_BUILD_CONCURRENCY = 2;

function resolveArtifactMatrixSelection(env) {
  const artifactMatrix = env.FRONTEND_ARTIFACT_MATRIX?.trim();
  if (artifactMatrix) return resolveSelectedComboIds(artifactMatrix);
  return resolveSelectedComboIds(env.FRONTEND_RELEASE_MATRIX);
}

function resolvePositiveInteger(value, fallback, name) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function resolveBuildConcurrency(env, selectedCombos) {
  return Math.min(
    selectedCombos.length,
    resolvePositiveInteger(
      env.FRONTEND_ARTIFACT_BUILD_CONCURRENCY,
      DEFAULT_BUILD_CONCURRENCY,
      "FRONTEND_ARTIFACT_BUILD_CONCURRENCY",
    ),
  );
}

function resolveBuildOutputRoot(env) {
  const configured = env.FRONTEND_ARTIFACT_BUILD_OUTPUT_ROOT?.trim();
  if (configured) return resolve(configured);
  return mkdtempSync(join(tmpdir(), "lightvela-frontend-artifact-builds-"));
}

function resolveComboBuildOutputDir(combo, buildOutputRoot) {
  return join(buildOutputRoot, normalizeComboIdForTag(combo.id));
}

function pnpmBin(env) {
  return env.PNPM_BIN?.trim() || "pnpm";
}

function nodeBin(env) {
  return env.NODE_BIN?.trim() || process.execPath;
}

function runCommand(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? 1}`));
    });
  });
}

function modeForBuildCommand(scriptName) {
  if (scriptName === "build:cn") return "cn";
  if (scriptName === "build:global") return "global";
  throw new Error(`frontend artifact parallel build only supports build:cn/build:global, got ${scriptName}`);
}

export async function runFrontendArtifactTypecheck(env = process.env) {
  await runCommand(pnpmBin(env), ["run", "check"], env);
}

export async function runFrontendArtifactBuildCommand(scriptName, env = process.env, runner = runCommand) {
  const outputDir = env.FRONTEND_BUILD_OUTPUT_DIR?.trim();
  if (!outputDir) {
    throw new Error("FRONTEND_BUILD_OUTPUT_DIR is required for frontend artifact builds");
  }
  const mode = modeForBuildCommand(scriptName);
  await runner(pnpmBin(env), ["exec", "vite", "build", "--mode", mode, "--outDir", outputDir], env);
  await runner(nodeBin(env), ["scripts/optimize-static-assets.mjs", outputDir], env);
  await runner(nodeBin(env), ["scripts/generate-static-site.mjs", "--region", mode, "--dist", outputDir], env);
}

async function runWithConcurrency(items, concurrency, task) {
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(items[index], index);
    }
  });
  await Promise.all(workers);
}

export async function executeBuildReleaseArtifacts({
  env = process.env,
  log = console.log,
  runScript = runFrontendArtifactBuildCommand,
  runTypecheck = runFrontendArtifactTypecheck,
  validateArtifacts = validateArtifactPrerequisites,
  archiveAndVerifyArtifact = archiveAndVerifyFrontendArtifact,
} = {}) {
  const { matrixPath, combos } = loadReleaseMatrix();
  const selectedIds = resolveArtifactMatrixSelection(env);
  const selectedCombos = selectReleaseCombos(combos, selectedIds);
  const artifactMode = resolveArtifactMode(env);

  if (artifactMode !== ARTIFACT_MODE_REQUIRED) {
    throw new Error("FRONTEND_ARTIFACT_MODE=required is required for build:release-artifacts");
  }
  validateArtifacts(env);
  const releaseHints = [];

  log(`${colorText("frontend artifact build matrix file:", "bold", env)} ${matrixPath}`);
  log(`${colorText("frontend artifact build selection:", "bold", env)} ${selectedCombos.map((combo) => highlightComboId(combo.id, env)).join(", ")}`);
  const concurrency = resolveBuildConcurrency(env, selectedCombos);
  const buildOutputRoot = resolveBuildOutputRoot(env);
  rmSync(buildOutputRoot, { recursive: true, force: true });
  log(`${colorText("frontend artifact build concurrency:", "bold", env)} ${concurrency}`);
  log(`${colorText("frontend artifact build output root:", "bold", env)} ${buildOutputRoot}`);

  log(`${colorText("frontend artifact build typecheck start", "bold", env)}`);
  await runTypecheck(env);
  log(`${colorText("frontend artifact build typecheck done", "green", env)}`);

  const buildResults = new Array(selectedCombos.length);
  await runWithConcurrency(selectedCombos, concurrency, async (combo, index) => {
    const projectName = resolveComboProjectName(combo, env);
    const outputDir = resolveComboBuildOutputDir(combo, buildOutputRoot);
    const comboEnv = {
      ...createComboEnvironment(combo, projectName, env),
      FRONTEND_BUILD_OUTPUT_DIR: outputDir,
    };
    if (combo.channel === "cf") {
      comboEnv.CLOUDFLARE_PAGES_DIR = outputDir;
    } else if (combo.channel === "eo") {
      comboEnv.EDGEONE_PAGES_DIR = outputDir;
    }

    log(`${colorText("frontend artifact build combo start:", "bold", env)} ${formatComboSummary(combo, projectName)} buildOutputDir=${outputDir}`);
    await runScript(combo.buildCommand, comboEnv);
    buildResults[index] = { combo, projectName, comboEnv };
    log(`${colorText("frontend artifact build combo built:", "green", env)} ${highlightComboId(combo.id, env)}`);
  });

  for (const { combo, projectName, comboEnv } of buildResults) {
    const result = archiveAndVerifyArtifact({
      combo,
      projectName,
      comboEnv,
      env,
      log,
    });
    log(`${colorText("frontend artifact build combo archived:", "green", env)} ${highlightArtifactRef(result.ref, env)}`);
    releaseHints.push({ combo, result });
    logReleaseHint({ combo, result, env, log });
    log(`${colorText("frontend artifact build combo done:", "green", env)} ${highlightComboId(combo.id, env)}`);
  }
  logReleaseHintSummary({ hints: releaseHints, env, log });
}

const currentModulePath = import.meta.url.startsWith("file:")
  ? fileURLToPath(import.meta.url)
  : resolve(process.cwd(), "scripts/build-release-artifacts.mjs");
const isMainModule = process.argv[1] && resolve(process.argv[1]) === currentModulePath;

if (isMainModule) {
  executeBuildReleaseArtifacts().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
