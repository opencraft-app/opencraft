import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
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
  if (selectedCombos.some((combo) => combo.buildCommand === "build:next")) return 1;
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

export async function runFrontendArtifactTypecheck(env = process.env) {
  await runCommand(pnpmBin(env), ["run", "check"], env);
}

/**
 * @param scriptName 只允许 "build:next"
 * @param env 需含 FRONTEND_BUILD_OUTPUT_DIR
 * @param runner 命令执行器（测试会注入假的）
 * @param workspaceRoot 工作区根目录，`.next` / `out` 相对它解析。
 *
 * ⚠️ `workspaceRoot` 存在的唯一理由是**测试隔离**。
 * 本函数会 `rmSync('.next')` 与 `rmSync('out')` —— 在真实构建里这是必要的
 * （避免上一次构建的产物串进 artifact），但测试若在仓库根跑，就会把开发者
 * 正在运行的 dev server 的 `.next/dev` 删掉：dev server 不会崩，而是所有请求
 * 变成 500（`ENOENT: .next/dev/routes-manifest.json`），且看不出与测试有关。
 * 实测踩过一次。测试必须传临时目录。
 */
export async function runFrontendArtifactBuildCommand(
  scriptName,
  env = process.env,
  runner = runCommand,
  workspaceRoot = process.cwd(),
) {
  const outputDir = env.FRONTEND_BUILD_OUTPUT_DIR?.trim();
  if (!outputDir) {
    throw new Error("FRONTEND_BUILD_OUTPUT_DIR is required for frontend artifact builds");
  }
  if (scriptName !== "build:next") {
    throw new Error(`frontend artifact builds only support build:next, got ${scriptName}`);
  }

  const nextDir = resolve(workspaceRoot, ".next");
  const outDir = resolve(workspaceRoot, "out");

  rmSync(outputDir, { recursive: true, force: true });
  rmSync(nextDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  await runner(nodeBin(env), ["scripts/subset-fonts.mjs"], env);
  await runner(nodeBin(env), ["scripts/sync-fumadocs-content.mjs"], env);
  await runner(pnpmBin(env), ["exec", "fumadocs-mdx"], env);
  await runner(pnpmBin(env), ["exec", "next", "build"], env);
  await runner(nodeBin(env), ["scripts/version-next-static-assets.mjs"], env);
  await runner(nodeBin(env), ["scripts/fix-next-static-html-lang.mjs"], env);
  await runner(nodeBin(env), ["scripts/format-next-static-html.mjs"], env);
  await runner(nodeBin(env), ["scripts/check-versioned-next-static-assets.mjs"], env);
  // 必须在 cpSync 之前：edgeone.json 写进 `out`，再随产物整体拷到 outputDir，
  // 这样 OCI artifact 里就带着当前 region 对应的 301 规则（静态导出下 Next 的
  // redirects() 不生效，这是唯一能让 301 进版本控制的位置）。
  await runner(nodeBin(env), ["scripts/write-edgeone-config.mjs"], env);
  if (outDir !== resolve(outputDir)) {
    cpSync(outDir, outputDir, { recursive: true });
  }
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
