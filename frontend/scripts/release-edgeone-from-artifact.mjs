import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertArtifactManifestMatchesCombo,
  resolveExpectedArtifactReleaseRef,
  verifyFrontendArtifact,
} from "./frontend-artifact.mjs";
import {
  createComboEnvironment,
  formatComboSummary,
  loadReleaseMatrix,
  resolveComboProjectName,
  resolveSelectedComboIds,
  runPnpmScript,
  selectReleaseCombos,
  validateRequiredSecrets,
} from "./release-matrix.mjs";

function selectSingleEdgeOneCombo(env) {
  const { matrixPath, combos } = loadReleaseMatrix();
  const selectedIds = resolveSelectedComboIds(env.FRONTEND_RELEASE_MATRIX);
  if (!selectedIds || selectedIds.length !== 1) {
    throw new Error("FRONTEND_RELEASE_MATRIX must select exactly one EdgeOne combo for artifact release");
  }
  const [combo] = selectReleaseCombos(combos, selectedIds);
  if (combo.channel !== "eo") {
    throw new Error(`FRONTEND_RELEASE_MATRIX must select an EdgeOne combo, got ${combo.id}`);
  }
  return { matrixPath, combo };
}

export function executeEdgeOneArtifactRelease({
  env = process.env,
  log = console.log,
  verifyArtifact = verifyFrontendArtifact,
  deployScript = runPnpmScript,
} = {}) {
  const { matrixPath, combo } = selectSingleEdgeOneCombo(env);
  const projectName = resolveComboProjectName(combo, env);
  const comboEnv = createComboEnvironment(combo, projectName, env);
  validateRequiredSecrets(combo, env);

  const artifact = resolveExpectedArtifactReleaseRef({
    env,
    targetComboId: combo.id,
  });

  log(`frontend EO artifact release matrix file: ${matrixPath}`);
  log(`frontend EO artifact release target: ${formatComboSummary(combo, projectName)}`);
  log(`frontend EO artifact release ref: ${artifact.ref}`);

  const verified = verifyArtifact({
    ref: artifact.ref,
    env,
    log,
  });
  assertArtifactManifestMatchesCombo({
    manifest: verified.manifest,
    ref: verified.ref,
    targetCombo: combo,
    projectName,
    comboEnv,
    repository: artifact.repository,
    tag: artifact.tag,
    shortSha: artifact.shortSha,
    fullSourceSha: artifact.fullSourceSha,
  });

  if (!verified.extractDir) {
    throw new Error("frontend artifact verification did not return an extracted dist directory");
  }

  deployScript(combo.deployCommand, {
    ...comboEnv,
    EDGEONE_PAGES_DIR: verified.extractDir,
  });
  log(`frontend EO artifact release done: ${combo.id}`);
}

const currentModulePath = import.meta.url.startsWith("file:")
  ? fileURLToPath(import.meta.url)
  : resolve(process.cwd(), "scripts/release-edgeone-from-artifact.mjs");
const isMainModule = process.argv[1] && resolve(process.argv[1]) === currentModulePath;

if (isMainModule) {
  executeEdgeOneArtifactRelease();
}
