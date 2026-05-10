import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARTIFACT_MODE_REQUIRED,
  archiveAndVerifyFrontendArtifact,
  colorText,
  highlightArtifactRef,
  highlightComboId,
  resolveArtifactMode,
  validateArtifactPrerequisites,
} from "./frontend-artifact.mjs";
import {
  createComboEnvironment,
  formatComboSummary,
  loadReleaseMatrix,
  resolveComboProjectName,
  resolveSelectedComboIds,
  runPnpmScript,
  selectReleaseCombos,
} from "./release-matrix.mjs";

function resolveArtifactMatrixSelection(env) {
  const artifactMatrix = env.FRONTEND_ARTIFACT_MATRIX?.trim();
  if (artifactMatrix) return resolveSelectedComboIds(artifactMatrix);
  return resolveSelectedComboIds(env.FRONTEND_RELEASE_MATRIX);
}

function resolveReleaseHintTitle(combo) {
  if (combo.id === "cf:cn-lightvela-staging") {
    return "Cloudflare 国内预发站";
  }
  if (combo.id === "cf:global-lightvela-intl-staging") {
    return "Cloudflare 国际预发站";
  }
  if (combo.id === "eo:cn-lightvela-prod") {
    return "EdgeOne 国内正式站";
  }
  if (combo.id === "eo:global-lightvela-intl-prod") {
    return "EdgeOne 国际正式站";
  }
  return `${combo.channel.toUpperCase()} ${combo.projectName}`;
}

function resolveReleaseHintCiName(combo) {
  if (combo.id === "eo:cn-lightvela-prod") {
    return "发布 frontend eo:cn-lightvela-prod";
  }
  if (combo.id === "eo:global-lightvela-intl-prod") {
    return "发布 frontend eo:global-lightvela-intl-prod";
  }
  return "构建 frontend";
}

function resolveReleaseHintShortSha(result) {
  const manifestShortSha = result.manifest?.shortSha;
  if (manifestShortSha) return manifestShortSha;
  const tag = result.ref?.slice(result.ref.lastIndexOf(":") + 1) ?? "";
  return tag.slice(0, 12);
}

function formatReleaseHint({ combo, result }) {
  const lines = [
    "============================================================",
    `可发布版本：${resolveReleaseHintTitle(combo)}`,
    `CI：${resolveReleaseHintCiName(combo)}`,
    `FRONTEND_ARTIFACT_SOURCE_SHA=${resolveReleaseHintShortSha(result)}`,
    `FRONTEND_ARTIFACT_REF=${result.ref}`,
    "============================================================",
  ];
  return lines.join("\n");
}

function colorMultiline(text, color, env) {
  return text
    .split("\n")
    .map((line) => colorText(line, color, env))
    .join("\n");
}

function logReleaseHint({ combo, result, env, log }) {
  log(colorMultiline(formatReleaseHint({ combo, result }), "green", env));
}

function logReleaseHintSummary({ hints, env, log }) {
  if (hints.length === 0) return;
  const summary = [
    "============================================================",
    "可发布版本汇总",
    "============================================================",
    ...hints.map((hint) => formatReleaseHint(hint)),
  ].join("\n");
  log(colorMultiline(summary, "green", env));
}

export function executeBuildReleaseArtifacts({
  env = process.env,
  log = console.log,
  runScript = runPnpmScript,
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

  for (const combo of selectedCombos) {
    const projectName = resolveComboProjectName(combo, env);
    const comboEnv = createComboEnvironment(combo, projectName, env);

    log(`${colorText("frontend artifact build combo start:", "bold", env)} ${formatComboSummary(combo, projectName)}`);
    runScript(combo.buildCommand, comboEnv);
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
  executeBuildReleaseArtifacts();
}
