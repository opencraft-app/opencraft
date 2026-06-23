import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertArtifactManifestMatchesCombo,
  colorText,
  highlightArtifactRef,
  highlightComboId,
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

const ALLOWED_EDGEONE_NEXT_COMBOS = new Set([
  "eo:cn-lightvela-prod-next",
  "eo:global-lightvela-intl-prod-next",
]);

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
  if (!ALLOWED_EDGEONE_NEXT_COMBOS.has(combo.id)) {
    throw new Error(`FRONTEND_RELEASE_MATRIX must select an EdgeOne Next artifact combo, got ${combo.id}`);
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

  log(`${colorText("frontend EO artifact release matrix file:", "bold", env)} ${matrixPath}`);
  log(`${colorText("frontend EO artifact release target:", "bold", env)} ${formatComboSummary(combo, projectName)}`);
  log(`${colorText("frontend EO artifact release ref:", "green", env)} ${highlightArtifactRef(artifact.ref, env)}`);

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
  if (verified.manifest?.assets?.entryKind !== "next") {
    throw new Error(`frontend EdgeOne release requires a Next artifact, got ${verified.manifest?.assets?.entryKind ?? "unknown"}`);
  }

  if (!verified.extractDir) {
    throw new Error("frontend artifact verification did not return an extracted dist directory");
  }

  deployScript(combo.deployCommand, {
    ...comboEnv,
    EDGEONE_PAGES_DIR: verified.extractDir,
  });
  log(`${colorText("frontend EO artifact release done:", "green", env)} ${highlightComboId(combo.id, env)}`);
}

const currentModulePath = import.meta.url.startsWith("file:")
  ? fileURLToPath(import.meta.url)
  : resolve(process.cwd(), "scripts/release-edgeone-from-artifact.mjs");
const isMainModule = process.argv[1] && resolve(process.argv[1]) === currentModulePath;

if (isMainModule) {
  executeEdgeOneArtifactRelease();
}
