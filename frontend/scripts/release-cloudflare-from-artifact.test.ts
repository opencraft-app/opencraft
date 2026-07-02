import { describe, expect, it } from "vitest";

import { executeCloudflareArtifactRelease } from "./release-cloudflare-from-artifact.mjs";

const sourceSha = "dfde008ca43aba0cb0dcdfcc1b0c66bd204a2ea8";
const shortSha = sourceSha.slice(0, 12);
const repository = "registry.example.com/lightclaw/frontend-pages";
const cnRef = `${repository}:${shortSha}-cf-cn-lightvela-staging`;
const globalRef = `${repository}:${shortSha}-cf-global-lightvela-intl-staging`;
const baseEnv = {
  FRONTEND_RELEASE_MATRIX: "cf:cn-lightvela-staging",
  FRONTEND_ARTIFACT_REPOSITORY: repository,
  FRONTEND_ARTIFACT_SOURCE_SHA: sourceSha,
  CLOUDFLARE_API_TOKEN: "cf-token",
  CLOUDFLARE_ACCOUNT_ID: "cf-account",
};

function makeCfManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sourceSha,
    shortSha,
    comboId: "cf:cn-lightvela-staging",
    region: "cn",
    channel: "cf",
    projectName: "lightclaw",
    outputDir: "out",
    buildCommand: "build:next",
    deployCommand: "deploy:cf",
    artifact: {
      repository,
      tag: `${shortSha}-cf-cn-lightvela-staging`,
      ref: cnRef,
    },
    identity: {
      contentIdentitySha256: "a".repeat(64),
      provenanceIdentitySha256: "b".repeat(64),
    },
    bakedEnv: {
      VITE_REGION: "cn",
      VITE_AUTH_API_BASE_URL: "https://lightclaw.tech",
      VITE_AEGIS_ENABLED: "true",
      VITE_AEGIS_ID: "4e66EF5XoPEXx3y8lw",
      VITE_AEGIS_HOST_URL: "https://rumt-zh.com",
    },
    assets: {
      entryKind: "next",
      entryJs: "/_next/static/chunks/main-app-test.js",
      entryJsSha256: "c".repeat(64),
    },
    archive: {
      file: "dist.tar.gz",
      sha256: "d".repeat(64),
      bytes: 1,
    },
    ...overrides,
  };
}

function makeGlobalManifest() {
  return {
    ...makeCfManifest(),
    comboId: "cf:global-lightvela-intl-staging",
    region: "global",
    projectName: "lightvela-intl",
    outputDir: "out",
    buildCommand: "build:next",
    artifact: {
      repository,
      tag: `${shortSha}-cf-global-lightvela-intl-staging`,
      ref: globalRef,
    },
    bakedEnv: {
      VITE_REGION: "global",
      VITE_AUTH_API_BASE_URL: "https://api-sandbox-kr-1.lightclaw.tech",
      VITE_AEGIS_ENABLED: "true",
      VITE_AEGIS_ID: "2ellOCK3ozed3owgOj",
      VITE_AEGIS_HOST_URL: "https://rumt-sg.com",
    },
  };
}

describe("Cloudflare release from frontend artifact", () => {
  it("verifies a matching artifact and deploys the extracted dir", () => {
    const calls: string[] = [];

    executeCloudflareArtifactRelease({
      env: baseEnv,
      log: () => {},
      verifyArtifact: ({ ref }) => {
        calls.push(`verify:${ref}`);
        return { manifest: makeCfManifest(), ref, extractDir: "/tmp/frontend-cf-artifact-dist" };
      },
      deployScript: (scriptName: string, env: Record<string, string>) => {
        calls.push(`${scriptName}:${env.CLOUDFLARE_PAGES_DIR}:${env.CLOUDFLARE_PAGES_PROJECT_NAME}`);
      },
    });

    expect(calls).toEqual([
      `verify:${cnRef}`,
      "deploy:cf:/tmp/frontend-cf-artifact-dist:lightclaw",
    ]);
    expect(calls).not.toContain("release:matrix");
  });

  it("publishes all selected Cloudflare combos from artifacts", () => {
    const calls: string[] = [];

    executeCloudflareArtifactRelease({
      env: {
        ...baseEnv,
        FRONTEND_RELEASE_MATRIX: "cf:cn-lightvela-staging,cf:global-lightvela-intl-staging",
      },
      log: () => {},
      verifyArtifact: ({ ref }) => {
        calls.push(`verify:${ref}`);
        return {
          manifest: ref === globalRef ? makeGlobalManifest() : makeCfManifest(),
          ref,
          extractDir: ref === globalRef ? "/tmp/out-global" : "/tmp/out-cn",
        };
      },
      deployScript: (scriptName: string, env: Record<string, string>) => {
        calls.push(`${scriptName}:${env.CLOUDFLARE_PAGES_DIR}:${env.CLOUDFLARE_PAGES_PROJECT_NAME}`);
      },
    });

    expect(calls).toEqual([
      `verify:${cnRef}`,
      "deploy:cf:/tmp/out-cn:lightclaw",
      `verify:${globalRef}`,
      "deploy:cf:/tmp/out-global:lightvela-intl",
    ]);
  });

  it("rejects non-Cloudflare combo selections", () => {
    expect(() => executeCloudflareArtifactRelease({
      env: {
        ...baseEnv,
        FRONTEND_RELEASE_MATRIX: "eo:cn-lightvela-prod-next",
      },
      log: () => {},
      verifyArtifact: () => ({ manifest: makeCfManifest(), ref: cnRef, extractDir: "/tmp/dist" }),
      deployScript: () => {},
    })).toThrow("only Cloudflare combos");
  });

  it("fails manifest mismatch before deploy", () => {
    const calls: string[] = [];

    expect(() => executeCloudflareArtifactRelease({
      env: baseEnv,
      log: () => {},
      verifyArtifact: ({ ref }) => ({
        manifest: makeCfManifest({ comboId: "cf:global-lightvela-intl-staging" }),
        ref,
        extractDir: "/tmp/dist",
      }),
      deployScript: () => calls.push("deploy"),
    })).toThrow("comboId mismatch");

    expect(calls).toEqual([]);
  });
});
