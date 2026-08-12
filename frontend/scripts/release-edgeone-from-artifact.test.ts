import { describe, expect, it } from "vitest";

import { executeEdgeOneArtifactRelease } from "./release-edgeone-from-artifact.mjs";

const sourceSha = "dfde008ca43aba0cb0dcdfcc1b0c66bd204a2ea8";
const shortSha = sourceSha.slice(0, 12);
const repository = "registry.example.com/lightclaw/frontend-pages";
const cnRef = `${repository}:${shortSha}-eo-cn-lightvela-prod-next`;
const baseEnv = {
  FRONTEND_RELEASE_MATRIX: "eo:cn-lightvela-prod-next",
  FRONTEND_ARTIFACT_REPOSITORY: repository,
  FRONTEND_ARTIFACT_SOURCE_SHA: sourceSha,
  EDGEONE_API_TOKEN: "edgeone-token",
};

function makeCnManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sourceSha,
    shortSha,
    comboId: "eo:cn-lightvela-prod-next",
    region: "cn",
    channel: "eo",
    projectName: "lightvela",
    outputDir: "out",
    buildCommand: "build:next",
    deployCommand: "deploy:eo",
    artifact: {
      repository,
      tag: `${shortSha}-eo-cn-lightvela-prod-next`,
      ref: cnRef,
    },
    identity: {
      contentIdentitySha256: "a".repeat(64),
      provenanceIdentitySha256: "b".repeat(64),
    },
    bakedEnv: {
      VITE_REGION: "cn",
      VITE_AUTH_API_BASE_URL: "https://api.lightvela.com",
      NEXT_PUBLIC_SITE_URL: "https://lightvela.com",
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

describe("EdgeOne release from frontend artifact", () => {
  it("verifies a matching artifact, validates it in Preview, then deploys production", () => {
    const calls: string[] = [];

    executeEdgeOneArtifactRelease({
      env: baseEnv,
      log: () => {},
      verifyArtifact: ({ ref }) => {
        calls.push(`verify:${ref}`);
        return { manifest: makeCnManifest(), ref, extractDir: "/tmp/frontend-artifact-dist" };
      },
      deployScript: (scriptName: string, env: Record<string, string>) => {
        calls.push([
          scriptName,
          env.EDGEONE_PAGES_DIR,
          env.EDGEONE_PAGES_PROJECT_NAME,
          env.EDGEONE_PAGES_ENV,
          env.EDGEONE_PAGES_VERIFY_DEPLOYMENT ?? "",
        ].join(":"));
      },
    });

    expect(calls).toEqual([
      `verify:${cnRef}`,
      "deploy:eo:/tmp/frontend-artifact-dist:lightvela:preview:1",
      "deploy:eo:/tmp/frontend-artifact-dist:lightvela:production:",
    ]);
    expect(calls).not.toContain("release:matrix");
  });

  it("does not deploy production when the Preview smoke check fails", () => {
    const deployEnvironments: string[] = [];

    expect(() => executeEdgeOneArtifactRelease({
      env: baseEnv,
      log: () => {},
      verifyArtifact: ({ ref }) => ({ manifest: makeCnManifest(), ref, extractDir: "/tmp/dist" }),
      deployScript: (_scriptName: string, env: Record<string, string>) => {
        deployEnvironments.push(env.EDGEONE_PAGES_ENV);
        if (env.EDGEONE_PAGES_ENV === "preview") throw new Error("Preview smoke failed");
      },
    })).toThrow("Preview smoke failed");

    expect(deployEnvironments).toEqual(["preview"]);
  });

  it("requires exactly one target combo", () => {
    expect(() => executeEdgeOneArtifactRelease({
      env: {
        ...baseEnv,
        FRONTEND_RELEASE_MATRIX: "eo:cn-lightvela-prod-next,eo:global-lightvela-intl-prod-next",
      },
      log: () => {},
      verifyArtifact: () => ({ manifest: makeCnManifest(), ref: cnRef, extractDir: "/tmp/dist" }),
      deployScript: () => {},
    })).toThrow("exactly one EdgeOne combo");
  });

  it("requires a source SHA or full artifact ref", () => {
    expect(() => executeEdgeOneArtifactRelease({
      env: {
        FRONTEND_RELEASE_MATRIX: "eo:cn-lightvela-prod-next",
        FRONTEND_ARTIFACT_REPOSITORY: repository,
        EDGEONE_API_TOKEN: "edgeone-token",
      },
      log: () => {},
      verifyArtifact: () => ({ manifest: makeCnManifest(), ref: cnRef, extractDir: "/tmp/dist" }),
      deployScript: () => {},
    })).toThrow("FRONTEND_ARTIFACT_SOURCE_SHA or FRONTEND_ARTIFACT_REF is required");
  });

  it("accepts full FRONTEND_ARTIFACT_REF override", () => {
    const calls: string[] = [];

    executeEdgeOneArtifactRelease({
      env: {
        FRONTEND_RELEASE_MATRIX: "eo:cn-lightvela-prod-next",
        FRONTEND_ARTIFACT_REPOSITORY: repository,
        FRONTEND_ARTIFACT_REF: cnRef,
        EDGEONE_API_TOKEN: "edgeone-token",
      },
      log: () => {},
      verifyArtifact: ({ ref }) => {
        calls.push(`verify:${ref}`);
        return { manifest: makeCnManifest(), ref, extractDir: "/tmp/dist" };
      },
      deployScript: () => calls.push("deploy"),
    });

    expect(calls).toEqual([`verify:${cnRef}`, "deploy", "deploy"]);
  });

  it.each([
    ["comboId", { comboId: "eo:global-lightvela-intl-prod-next" }, "comboId mismatch"],
    ["projectName", { projectName: "wrong" }, "projectName mismatch"],
    ["channel", { channel: "cf" }, "channel mismatch"],
    ["region", { region: "global" }, "region mismatch"],
    ["outputDir", { outputDir: "wrong-output" }, "outputDir mismatch"],
    ["VITE_REGION", { bakedEnv: { ...makeCnManifest().bakedEnv, VITE_REGION: "global" } }, "baked env VITE_REGION mismatch"],
    ["VITE_AUTH_API_BASE_URL", { bakedEnv: { ...makeCnManifest().bakedEnv, VITE_AUTH_API_BASE_URL: "https://wrong.example.com" } }, "baked env VITE_AUTH_API_BASE_URL mismatch"],
    ["NEXT_PUBLIC_SITE_URL", { bakedEnv: { ...makeCnManifest().bakedEnv, NEXT_PUBLIC_SITE_URL: "https://wrong.example.com" } }, "baked env NEXT_PUBLIC_SITE_URL mismatch"],
    ["VITE_AEGIS_ID", { bakedEnv: { ...makeCnManifest().bakedEnv, VITE_AEGIS_ID: "wrong" } }, "baked env VITE_AEGIS_ID mismatch"],
  ])("fails manifest mismatch for %s", (_name, overrides, message) => {
    const calls: string[] = [];

    expect(() => executeEdgeOneArtifactRelease({
      env: baseEnv,
      log: () => {},
      verifyArtifact: ({ ref }) => ({ manifest: makeCnManifest(overrides), ref, extractDir: "/tmp/dist" }),
      deployScript: () => calls.push("deploy"),
    })).toThrow(message);

    expect(calls).toEqual([]);
  });

});
