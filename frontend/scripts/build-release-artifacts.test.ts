import { describe, expect, it } from "vitest";

import { executeBuildReleaseArtifacts } from "./build-release-artifacts.mjs";

const baseEnv = {
  FRONTEND_ARTIFACT_MODE: "required",
  FRONTEND_ARTIFACT_REPOSITORY: "registry.example.com/lightclaw/frontend-pages",
  FRONTEND_ARTIFACT_SOURCE_SHA: "dfde008ca43aba0cb0dcdfcc1b0c66bd204a2ea8",
};

describe("build release artifacts", () => {
  it("selects from FRONTEND_ARTIFACT_MATRIX and archives without deploying", () => {
    const calls: string[] = [];

    executeBuildReleaseArtifacts({
      env: {
        ...baseEnv,
        FRONTEND_ARTIFACT_MATRIX: "eo:cn-lightvela-prod,eo:global-lightvela-intl-prod",
        EDGEONE_API_TOKEN: "",
      },
      log: () => {},
      validateArtifacts: () => calls.push("validate-artifacts"),
      runScript: (scriptName: string) => calls.push(scriptName),
      archiveAndVerifyArtifact: ({ combo }) => {
        calls.push(`artifact:${combo.id}`);
        return { ref: `registry.example.com/lightclaw/frontend-pages:dfde008ca43a-${combo.id.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase()}` };
      },
    });

    expect(calls).toEqual([
      "validate-artifacts",
      "build:cn",
      "artifact:eo:cn-lightvela-prod",
      "build:global",
      "artifact:eo:global-lightvela-intl-prod",
    ]);
    expect(calls).not.toContain("deploy:eo");
  });

  it("falls back to FRONTEND_RELEASE_MATRIX when artifact matrix is unset", () => {
    const calls: string[] = [];

    executeBuildReleaseArtifacts({
      env: {
        ...baseEnv,
        FRONTEND_RELEASE_MATRIX: "cf:cn-lightvela-staging",
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_ACCOUNT_ID: "account",
      },
      log: () => {},
      validateArtifacts: () => calls.push("validate-artifacts"),
      runScript: (scriptName: string) => calls.push(scriptName),
      archiveAndVerifyArtifact: ({ combo }) => {
        calls.push(`artifact:${combo.id}`);
        return { ref: "registry.example.com/lightclaw/frontend-pages:dfde008ca43a-cf-cn-lightvela-staging" };
      },
    });

    expect(calls).toEqual(["validate-artifacts", "build:cn", "artifact:cf:cn-lightvela-staging"]);
  });

  it("requires artifact mode before building", () => {
    const calls: string[] = [];

    expect(() => executeBuildReleaseArtifacts({
      env: {
        FRONTEND_ARTIFACT_MATRIX: "eo:cn-lightvela-prod",
      },
      log: () => {},
      runScript: (scriptName: string) => calls.push(scriptName),
    })).toThrow("FRONTEND_ARTIFACT_MODE=required");

    expect(calls).toEqual([]);
  });

  it("fails early when artifact prerequisites fail", () => {
    const calls: string[] = [];

    expect(() => executeBuildReleaseArtifacts({
      env: {
        ...baseEnv,
        FRONTEND_ARTIFACT_MATRIX: "eo:cn-lightvela-prod",
      },
      log: () => {},
      validateArtifacts: () => {
        throw new Error("missing oras");
      },
      runScript: (scriptName: string) => calls.push(scriptName),
    })).toThrow("missing oras");

    expect(calls).toEqual([]);
  });
});
