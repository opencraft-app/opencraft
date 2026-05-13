import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ARCHIVE_FILE,
  assertArtifactManifestMatchesCombo,
  archiveFrontendArtifact,
  artifactIdentitiesMatch,
  buildArtifactManifest,
  MANIFEST_FILE,
  normalizeComboIdForTag,
  resolveArtifactSourceShaInput,
  resolveArtifactTag,
  resolveExpectedArtifactReleaseRef,
  runArchiveCli,
  validateArtifactPrerequisites,
  verifyFrontendArtifact,
} from "./frontend-artifact.mjs";

const sourceSha = "dfde008ca43aba0cb0dcdfcc1b0c66bd204a2ea8";
const combo = {
  id: "eo:global-lightvela-intl-prod",
  region: "global",
  channel: "eo",
  buildCommand: "build:global",
  deployCommand: "deploy:eo",
  projectName: "lightvela-intl",
  outputDir: "dist-global",
};
const comboEnv = {
  VITE_REGION: "global",
  VITE_AUTH_API_BASE_URL: "https://api.lightvela.ai",
  VITE_AEGIS_ENABLED: "true",
  VITE_AEGIS_ID: "2ellOCK3ozed3owgOj",
  VITE_AEGIS_HOST_URL: "https://rumt-sg.com",
  EDGEONE_PAGES_DIR: "dist-global",
};

function createDist() {
  const root = mkdtempSync(join(tmpdir(), "frontend-artifact-dist-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), '<div id="root"></div><script type="module" src="/assets/index-test.js"></script>');
  writeFileSync(join(root, "assets", "index-test.js"), "console.log('hello artifact');\n");
  writeFileSync(join(root, "assets", "index-test.css"), "body{color:#111}\n");
  return root;
}

function createFakeOras(workDir) {
  const binPath = join(workDir, "fake-oras.sh");
  const pushMarker = join(workDir, "pushed");
  writeFileSync(binPath, `#!/usr/bin/env bash
set -euo pipefail
cmd="$1"
shift
case "$cmd" in
  login)
    exit 0
    ;;
  pull)
    ref="$1"
    shift
    out=""
    while [[ "$#" -gt 0 ]]; do
      case "$1" in
        -o)
          out="$2"
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    case "\${ORAS_PULL_MODE:-found}" in
      missing)
        echo "manifest unknown: $ref not found" >&2
        exit 1
        ;;
      transient)
        echo "temporary registry timeout" >&2
        exit 2
        ;;
    esac
    mkdir -p "$out"
    cp "$ORAS_PULL_MANIFEST" "$out/${MANIFEST_FILE}"
    cp "$ORAS_PULL_ARCHIVE" "$out/${ARCHIVE_FILE}"
    ;;
  push)
    echo pushed > "$ORAS_PUSH_MARKER"
    ;;
esac
`);
  chmodSync(binPath, 0o755);
  return { binPath, pushMarker };
}

describe("frontend artifact helpers", () => {
  it("normalizes combo ids into stable tag segments", () => {
    expect(normalizeComboIdForTag("eo:global-lightvela-intl-prod")).toBe("eo-global-lightvela-intl-prod");
    expect(resolveArtifactTag(sourceSha, "eo:global-lightvela-intl-prod")).toBe("dfde008ca43a-eo-global-lightvela-intl-prod");
  });

  it("validates required artifact prerequisites", () => {
    expect(() => validateArtifactPrerequisites({ FRONTEND_ARTIFACT_MODE: "" })).not.toThrow();
    expect(() => validateArtifactPrerequisites({
      FRONTEND_ARTIFACT_MODE: "required",
      ORAS_BIN: process.execPath,
      FRONTEND_ARTIFACT_REPOSITORY: "registry.example.com/lightclaw/frontend-pages",
      FRONTEND_ARTIFACT_SOURCE_SHA: sourceSha,
      REGISTRY_USERNAME: "user",
      REGISTRY_PASSWORD: "password",
    })).not.toThrow();
    expect(() => validateArtifactPrerequisites({ FRONTEND_ARTIFACT_MODE: "required" })).toThrow("missing prerequisite");
  });

  it("resolves release source SHA inputs from short or full hex values", () => {
    expect(resolveArtifactSourceShaInput("dfde008ca43a")).toEqual({
      shortSha: "dfde008ca43a",
      fullSourceSha: undefined,
    });
    expect(resolveArtifactSourceShaInput(sourceSha)).toEqual({
      shortSha: "dfde008ca43a",
      fullSourceSha: sourceSha,
    });
    expect(() => resolveArtifactSourceShaInput("dfde008c")).toThrow("12 or 40");
    expect(() => resolveArtifactSourceShaInput("not-a-sha")).toThrow("12 or 40");
  });

  it("derives release artifact refs and validates ref overrides", () => {
    const repository = "registry.example.com/lightclaw/frontend-pages";
    const ref = `${repository}:dfde008ca43a-eo-global-lightvela-intl-prod`;

    expect(resolveExpectedArtifactReleaseRef({
      repository,
      sourceSha,
      targetComboId: combo.id,
    })).toMatchObject({
      repository,
      tag: "dfde008ca43a-eo-global-lightvela-intl-prod",
      ref,
      shortSha: "dfde008ca43a",
      fullSourceSha: sourceSha,
    });
    expect(resolveExpectedArtifactReleaseRef({
      repository,
      artifactRef: ref,
      targetComboId: combo.id,
    })).toMatchObject({
      repository,
      tag: "dfde008ca43a-eo-global-lightvela-intl-prod",
      ref,
      shortSha: "dfde008ca43a",
    });
    expect(() => resolveExpectedArtifactReleaseRef({
      repository,
      sourceSha: "aaaaaaaaaaaa",
      artifactRef: ref,
      targetComboId: combo.id,
    })).toThrow("does not match FRONTEND_ARTIFACT_REF");
    expect(() => resolveExpectedArtifactReleaseRef({
      repository,
      artifactRef: `wrong.example.com/lightclaw/frontend-pages:dfde008ca43a-eo-global-lightvela-intl-prod`,
      targetComboId: combo.id,
    })).toThrow("does not match expected");
    expect(() => resolveExpectedArtifactReleaseRef({
      repository,
      artifactRef: `${repository}:dfde008ca43a-eo-cn-lightvela-prod`,
      targetComboId: combo.id,
    })).toThrow("tag must be");
  });

  it("builds a manifest with required fields and stable identities", () => {
    const dist = createDist();
    try {
      const base = {
        combo,
        projectName: "lightvela-intl",
        comboEnv,
        outputDir: dist,
        repository: "registry.example.com/lightclaw/frontend-pages",
        sourceSha,
      };
      const first = buildArtifactManifest({ ...base, createdAt: "2026-01-01T00:00:00Z" });
      const second = buildArtifactManifest({ ...base, createdAt: "2026-01-02T00:00:00Z" });

      expect(first.artifact.tag).toBe("dfde008ca43a-eo-global-lightvela-intl-prod");
      expect(first.assets.entryJs).toBe("/assets/index-test.js");
      expect(first.bakedEnv).toMatchObject({
        VITE_REGION: "global",
        VITE_AUTH_API_BASE_URL: "https://api.lightvela.ai",
        VITE_AEGIS_ID: "2ellOCK3ozed3owgOj",
      });
      expect(first.identity.contentIdentitySha256).toMatch(/^[0-9a-f]{64}$/);
      expect(first.identity.provenanceIdentitySha256).toBe(second.identity.provenanceIdentitySha256);
      expect(artifactIdentitiesMatch(first, second)).toBe(true);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("detects changed content under the same source and combo", () => {
    const firstDist = createDist();
    const secondDist = createDist();
    try {
      writeFileSync(join(secondDist, "assets", "index-test.js"), "console.log('changed');\n");
      const common = {
        combo,
        projectName: "lightvela-intl",
        comboEnv,
        repository: "registry.example.com/lightclaw/frontend-pages",
        sourceSha,
      };
      const first = buildArtifactManifest({ ...common, outputDir: firstDist });
      const second = buildArtifactManifest({ ...common, outputDir: secondDist });
      expect(artifactIdentitiesMatch(first, second)).toBe(false);
    } finally {
      rmSync(firstDist, { recursive: true, force: true });
      rmSync(secondDist, { recursive: true, force: true });
    }
  });

  it("creates a dry-run archive manifest and tarball", () => {
    const dist = createDist();
    const workDir = mkdtempSync(join(tmpdir(), "frontend-artifact-work-"));
    try {
      const result = archiveFrontendArtifact({
        combo,
        projectName: "lightvela-intl",
        comboEnv: { ...comboEnv, EDGEONE_PAGES_DIR: dist },
        env: {
          FRONTEND_ARTIFACT_REPOSITORY: "registry.example.com/lightclaw/frontend-pages",
          FRONTEND_ARTIFACT_SOURCE_SHA: sourceSha,
        },
        dryRun: true,
        workDir,
        log: () => {},
      });
      expect(result.manifest.archive.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.manifest.archive.bytes).toBeGreaterThan(0);
      expect(result.push?.command).toBe("oras");
      expect(result.push?.args).toContain("push");
      const verified = verifyFrontendArtifact({
        ref: result.ref,
        expectedManifest: result.manifest,
        dryRun: true,
        workDir,
        log: () => {},
      });
      expect(verified.extractDir).toContain("dist");
    } finally {
      rmSync(dist, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("skips pushing when an existing artifact has the same identity", () => {
    const dist = createDist();
    const existingWorkDir = mkdtempSync(join(tmpdir(), "frontend-artifact-existing-"));
    const publishWorkDir = mkdtempSync(join(tmpdir(), "frontend-artifact-publish-"));
    try {
      const existing = archiveFrontendArtifact({
        combo,
        projectName: "lightvela-intl",
        comboEnv: { ...comboEnv, EDGEONE_PAGES_DIR: dist },
        env: {
          FRONTEND_ARTIFACT_REPOSITORY: "registry.example.com/lightclaw/frontend-pages",
          FRONTEND_ARTIFACT_SOURCE_SHA: sourceSha,
        },
        dryRun: true,
        workDir: existingWorkDir,
        log: () => {},
      });
      const fakeOras = createFakeOras(publishWorkDir);
      const result = archiveFrontendArtifact({
        combo,
        projectName: "lightvela-intl",
        comboEnv: { ...comboEnv, EDGEONE_PAGES_DIR: dist },
        env: {
          FRONTEND_ARTIFACT_REPOSITORY: "registry.example.com/lightclaw/frontend-pages",
          FRONTEND_ARTIFACT_SOURCE_SHA: sourceSha,
          ORAS_BIN: fakeOras.binPath,
          ORAS_PULL_MANIFEST: existing.manifestPath,
          ORAS_PULL_ARCHIVE: existing.archivePath,
          ORAS_PUSH_MARKER: fakeOras.pushMarker,
          REGISTRY_USERNAME: "user",
          REGISTRY_PASSWORD: "password",
        },
        workDir: publishWorkDir,
        log: () => {},
      });

      expect(result.skippedPush).toBe(true);
      expect(existsSync(fakeOras.pushMarker)).toBe(false);
    } finally {
      rmSync(dist, { recursive: true, force: true });
      rmSync(existingWorkDir, { recursive: true, force: true });
      rmSync(publishWorkDir, { recursive: true, force: true });
    }
  });

  it("fails instead of overwriting when an existing artifact has a different identity", () => {
    const firstDist = createDist();
    const secondDist = createDist();
    const existingWorkDir = mkdtempSync(join(tmpdir(), "frontend-artifact-existing-"));
    const publishWorkDir = mkdtempSync(join(tmpdir(), "frontend-artifact-publish-"));
    try {
      writeFileSync(join(secondDist, "assets", "index-test.js"), "console.log('changed identity');\n");
      const existing = archiveFrontendArtifact({
        combo,
        projectName: "lightvela-intl",
        comboEnv: { ...comboEnv, EDGEONE_PAGES_DIR: firstDist },
        env: {
          FRONTEND_ARTIFACT_REPOSITORY: "registry.example.com/lightclaw/frontend-pages",
          FRONTEND_ARTIFACT_SOURCE_SHA: sourceSha,
        },
        dryRun: true,
        workDir: existingWorkDir,
        log: () => {},
      });
      const fakeOras = createFakeOras(publishWorkDir);

      expect(() => archiveFrontendArtifact({
        combo,
        projectName: "lightvela-intl",
        comboEnv: { ...comboEnv, EDGEONE_PAGES_DIR: secondDist },
        env: {
          FRONTEND_ARTIFACT_REPOSITORY: "registry.example.com/lightclaw/frontend-pages",
          FRONTEND_ARTIFACT_SOURCE_SHA: sourceSha,
          ORAS_BIN: fakeOras.binPath,
          ORAS_PULL_MANIFEST: existing.manifestPath,
          ORAS_PULL_ARCHIVE: existing.archivePath,
          ORAS_PUSH_MARKER: fakeOras.pushMarker,
          REGISTRY_USERNAME: "user",
          REGISTRY_PASSWORD: "password",
        },
        workDir: publishWorkDir,
        log: () => {},
      })).toThrow("already exists with different identity");
      expect(existsSync(fakeOras.pushMarker)).toBe(false);
    } finally {
      rmSync(firstDist, { recursive: true, force: true });
      rmSync(secondDist, { recursive: true, force: true });
      rmSync(existingWorkDir, { recursive: true, force: true });
      rmSync(publishWorkDir, { recursive: true, force: true });
    }
  });

  it("fails before push when existing artifact inspection has a transient error", () => {
    const dist = createDist();
    const publishWorkDir = mkdtempSync(join(tmpdir(), "frontend-artifact-publish-"));
    try {
      const fakeOras = createFakeOras(publishWorkDir);

      expect(() => archiveFrontendArtifact({
        combo,
        projectName: "lightvela-intl",
        comboEnv: { ...comboEnv, EDGEONE_PAGES_DIR: dist },
        env: {
          FRONTEND_ARTIFACT_REPOSITORY: "registry.example.com/lightclaw/frontend-pages",
          FRONTEND_ARTIFACT_SOURCE_SHA: sourceSha,
          ORAS_BIN: fakeOras.binPath,
          ORAS_PULL_MODE: "transient",
          ORAS_PUSH_MARKER: fakeOras.pushMarker,
          REGISTRY_USERNAME: "user",
          REGISTRY_PASSWORD: "password",
        },
        workDir: publishWorkDir,
        log: () => {},
      })).toThrow("failed to inspect existing frontend artifact");
      expect(existsSync(fakeOras.pushMarker)).toBe(false);
    } finally {
      rmSync(dist, { recursive: true, force: true });
      rmSync(publishWorkDir, { recursive: true, force: true });
    }
  });

  it("pushes when existing artifact inspection reports not found", () => {
    const dist = createDist();
    const publishWorkDir = mkdtempSync(join(tmpdir(), "frontend-artifact-publish-"));
    try {
      const fakeOras = createFakeOras(publishWorkDir);

      const result = archiveFrontendArtifact({
        combo,
        projectName: "lightvela-intl",
        comboEnv: { ...comboEnv, EDGEONE_PAGES_DIR: dist },
        env: {
          FRONTEND_ARTIFACT_REPOSITORY: "registry.example.com/lightclaw/frontend-pages",
          FRONTEND_ARTIFACT_SOURCE_SHA: sourceSha,
          ORAS_BIN: fakeOras.binPath,
          ORAS_PULL_MODE: "missing",
          ORAS_PUSH_MARKER: fakeOras.pushMarker,
          REGISTRY_USERNAME: "user",
          REGISTRY_PASSWORD: "password",
        },
        workDir: publishWorkDir,
        log: () => {},
      });

      expect(result.skippedPush).toBe(false);
      expect(existsSync(fakeOras.pushMarker)).toBe(true);
    } finally {
      rmSync(dist, { recursive: true, force: true });
      rmSync(publishWorkDir, { recursive: true, force: true });
    }
  });

  it("accepts pnpm-style -- before CLI flags", () => {
    const dist = createDist();
    const workDir = mkdtempSync(join(tmpdir(), "frontend-artifact-cli-"));
    try {
      const comboPath = join(workDir, "combo.json");
      const comboEnvPath = join(workDir, "combo-env.json");
      writeFileSync(comboPath, JSON.stringify(combo));
      writeFileSync(comboEnvPath, JSON.stringify({ ...comboEnv, EDGEONE_PAGES_DIR: dist }));

      expect(() => runArchiveCli([
        "--",
        "--dry-run",
        "--combo",
        comboPath,
        "--combo-env",
        comboEnvPath,
        "--project-name",
        "lightvela-intl",
      ], {
        FRONTEND_ARTIFACT_REPOSITORY: "registry.example.com/lightclaw/frontend-pages",
        FRONTEND_ARTIFACT_SOURCE_SHA: sourceSha,
      })).not.toThrow();
    } finally {
      rmSync(dist, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("fails if text assets contain explicit secret-like env values", () => {
    const dist = createDist();
    try {
      writeFileSync(join(dist, "assets", "index-test.js"), "const token='super-secret-token-value';\n");
      expect(() => archiveFrontendArtifact({
        combo,
        projectName: "lightvela-intl",
        comboEnv: { ...comboEnv, EDGEONE_PAGES_DIR: dist },
        env: {
          FRONTEND_ARTIFACT_REPOSITORY: "registry.example.com/lightclaw/frontend-pages",
          FRONTEND_ARTIFACT_SOURCE_SHA: sourceSha,
          EDGEONE_API_TOKEN: "super-secret-token-value",
        },
        dryRun: true,
        log: () => {},
      })).toThrow("contains secret-like env value");
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("scans large text assets for explicit secret-like env values", () => {
    const dist = createDist();
    try {
      writeFileSync(join(dist, "assets", "index-test.js"), `${"a".repeat(2_100_000)}super-secret-token-value\n`);
      expect(() => archiveFrontendArtifact({
        combo,
        projectName: "lightvela-intl",
        comboEnv: { ...comboEnv, EDGEONE_PAGES_DIR: dist },
        env: {
          FRONTEND_ARTIFACT_REPOSITORY: "registry.example.com/lightclaw/frontend-pages",
          FRONTEND_ARTIFACT_SOURCE_SHA: sourceSha,
          EDGEONE_API_TOKEN: "super-secret-token-value",
        },
        dryRun: true,
        log: () => {},
      })).toThrow("contains secret-like env value");
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("fails when the output does not contain an entry script", () => {
    const root = mkdtempSync(join(tmpdir(), "frontend-artifact-dist-"));
    try {
      writeFileSync(join(root, "index.html"), "<div>No script</div>");
      expect(() => buildArtifactManifest({
        combo,
        projectName: "lightvela-intl",
        comboEnv,
        outputDir: root,
        repository: "registry.example.com/lightclaw/frontend-pages",
        sourceSha,
      })).toThrow("does not reference an entry");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates an artifact manifest against the target combo and baked env", () => {
    const dist = createDist();
    try {
      const manifest = buildArtifactManifest({
        combo,
        projectName: "lightvela-intl",
        comboEnv,
        outputDir: dist,
        repository: "registry.example.com/lightclaw/frontend-pages",
        sourceSha,
      });

      expect(() => assertArtifactManifestMatchesCombo({
        manifest,
        ref: manifest.artifact.ref,
        targetCombo: combo,
        projectName: "lightvela-intl",
        comboEnv,
        repository: "registry.example.com/lightclaw/frontend-pages",
        tag: manifest.artifact.tag,
        shortSha: manifest.shortSha,
        fullSourceSha: sourceSha,
      })).not.toThrow();
      expect(() => assertArtifactManifestMatchesCombo({
        manifest: {
          ...manifest,
          comboId: "eo:cn-lightvela-prod",
        },
        ref: manifest.artifact.ref,
        targetCombo: combo,
        projectName: "lightvela-intl",
        comboEnv,
        repository: "registry.example.com/lightclaw/frontend-pages",
        tag: manifest.artifact.tag,
        shortSha: manifest.shortSha,
        fullSourceSha: sourceSha,
      })).toThrow("comboId mismatch");
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
