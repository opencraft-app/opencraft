import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARTIFACT_MODE_REQUIRED,
  archiveAndVerifyFrontendArtifact,
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

  log(`frontend artifact build matrix file: ${matrixPath}`);
  log(`frontend artifact build selection: ${selectedCombos.map((combo) => combo.id).join(", ")}`);

  for (const combo of selectedCombos) {
    const projectName = resolveComboProjectName(combo, env);
    const comboEnv = createComboEnvironment(combo, projectName, env);

    log(`frontend artifact build combo start: ${formatComboSummary(combo, projectName)}`);
    runScript(combo.buildCommand, comboEnv);
    const result = archiveAndVerifyArtifact({
      combo,
      projectName,
      comboEnv,
      env,
      log,
    });
    log(`frontend artifact build combo archived: ${result.ref}`);
    log(`frontend artifact build combo done: ${combo.id}`);
  }
}

const currentModulePath = import.meta.url.startsWith("file:")
  ? fileURLToPath(import.meta.url)
  : resolve(process.cwd(), "scripts/build-release-artifacts.mjs");
const isMainModule = process.argv[1] && resolve(process.argv[1]) === currentModulePath;

if (isMainModule) {
  executeBuildReleaseArtifacts();
}
