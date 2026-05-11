import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARTIFACT_MODE_REQUIRED,
  archiveAndVerifyFrontendArtifact,
  colorText,
  highlightArtifactRef,
  highlightComboId,
  logReleaseHint,
  logReleaseHintSummary,
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
