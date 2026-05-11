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

function selectCloudflareCombos(env) {
  const { matrixPath, combos } = loadReleaseMatrix();
  const selectedIds = resolveSelectedComboIds(env.FRONTEND_RELEASE_MATRIX);
  if (!selectedIds || selectedIds.length === 0) {
    throw new Error("FRONTEND_RELEASE_MATRIX must explicitly select Cloudflare combos for artifact release");
  }
  const selectedCombos = selectReleaseCombos(combos, selectedIds);
  const nonCloudflare = selectedCombos.filter((combo) => combo.channel !== "cf");
  if (nonCloudflare.length > 0) {
    throw new Error(`FRONTEND_RELEASE_MATRIX must select only Cloudflare combos, got ${nonCloudflare.map((combo) => combo.id).join(", ")}`);
  }
  return { matrixPath, selectedCombos };
}

export function executeCloudflareArtifactRelease({
  env = process.env,
  log = console.log,
  verifyArtifact = verifyFrontendArtifact,
  deployScript = runPnpmScript,
} = {}) {
  const { matrixPath, selectedCombos } = selectCloudflareCombos(env);

  log(`${colorText("frontend CF artifact release matrix file:", "bold", env)} ${matrixPath}`);
  log(`${colorText("frontend CF artifact release selection:", "bold", env)} ${selectedCombos.map((combo) => highlightComboId(combo.id, env)).join(", ")}`);

  for (const combo of selectedCombos) {
    const projectName = resolveComboProjectName(combo, env);
    const comboEnv = createComboEnvironment(combo, projectName, env);
    validateRequiredSecrets(combo, env);

    const artifact = resolveExpectedArtifactReleaseRef({
      env,
      targetComboId: combo.id,
    });

    log(`${colorText("frontend CF artifact release target:", "bold", env)} ${formatComboSummary(combo, projectName)}`);
    log(`${colorText("frontend CF artifact release ref:", "green", env)} ${highlightArtifactRef(artifact.ref, env)}`);

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
      CLOUDFLARE_PAGES_DIR: verified.extractDir,
    });
    log(`${colorText("frontend CF artifact release done:", "green", env)} ${highlightComboId(combo.id, env)}`);
  }
}

const currentModulePath = import.meta.url.startsWith("file:")
  ? fileURLToPath(import.meta.url)
  : resolve(process.cwd(), "scripts/release-cloudflare-from-artifact.mjs");
const isMainModule = process.argv[1] && resolve(process.argv[1]) === currentModulePath;

if (isMainModule) {
  executeCloudflareArtifactRelease();
}
