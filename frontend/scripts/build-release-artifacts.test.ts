import { describe, expect, it } from "vitest";

import { executeBuildReleaseArtifacts } from "./build-release-artifacts.mjs";

const baseEnv = {
  FRONTEND_ARTIFACT_MODE: "required",
  FRONTEND_ARTIFACT_REPOSITORY: "registry.example.com/lightclaw/frontend-pages",
  FRONTEND_ARTIFACT_SOURCE_SHA: "dfde008ca43aba0cb0dcdfcc1b0c66bd204a2ea8",
};

describe("build release artifacts", () => {
  it("selects from FRONTEND_ARTIFACT_MATRIX and archives without deploying", async () => {
    const calls: string[] = [];

    await executeBuildReleaseArtifacts({
      env: {
        ...baseEnv,
        FRONTEND_ARTIFACT_MATRIX: "eo:cn-lightvela-prod,eo:global-lightvela-intl-prod",
        FRONTEND_ARTIFACT_BUILD_OUTPUT_ROOT: "/tmp/frontend-artifact-builds",
        EDGEONE_API_TOKEN: "",
      },
      log: () => {},
      validateArtifacts: () => calls.push("validate-artifacts"),
      runTypecheck: () => calls.push("typecheck"),
      runScript: (scriptName: string) => calls.push(scriptName),
      archiveAndVerifyArtifact: ({ combo }) => {
        calls.push(`artifact:${combo.id}`);
        return { ref: `registry.example.com/lightclaw/frontend-pages:dfde008ca43a-${combo.id.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase()}` };
      },
    });

    expect(calls).toEqual([
      "validate-artifacts",
      "typecheck",
      "build:cn",
      "build:global",
      "artifact:eo:cn-lightvela-prod",
      "artifact:eo:global-lightvela-intl-prod",
    ]);
    expect(calls).not.toContain("deploy:eo");
  });

  it("falls back to FRONTEND_RELEASE_MATRIX when artifact matrix is unset", async () => {
    const calls: string[] = [];

    await executeBuildReleaseArtifacts({
      env: {
        ...baseEnv,
        FRONTEND_RELEASE_MATRIX: "cf:cn-lightvela-staging",
        FRONTEND_ARTIFACT_BUILD_OUTPUT_ROOT: "/tmp/frontend-artifact-builds",
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_ACCOUNT_ID: "account",
      },
      log: () => {},
      validateArtifacts: () => calls.push("validate-artifacts"),
      runTypecheck: () => calls.push("typecheck"),
      runScript: (scriptName: string) => calls.push(scriptName),
      archiveAndVerifyArtifact: ({ combo }) => {
        calls.push(`artifact:${combo.id}`);
        return { ref: "registry.example.com/lightclaw/frontend-pages:dfde008ca43a-cf-cn-lightvela-staging" };
      },
    });

    expect(calls).toEqual(["validate-artifacts", "typecheck", "build:cn", "artifact:cf:cn-lightvela-staging"]);
  });

  it("requires artifact mode before building", async () => {
    const calls: string[] = [];

    await expect(executeBuildReleaseArtifacts({
      env: {
        FRONTEND_ARTIFACT_MATRIX: "eo:cn-lightvela-prod",
      },
      log: () => {},
      runScript: (scriptName: string) => calls.push(scriptName),
    })).rejects.toThrow("FRONTEND_ARTIFACT_MODE=required");

    expect(calls).toEqual([]);
  });

  it("fails early when artifact prerequisites fail", async () => {
    const calls: string[] = [];

    await expect(executeBuildReleaseArtifacts({
      env: {
        ...baseEnv,
        FRONTEND_ARTIFACT_MATRIX: "eo:cn-lightvela-prod",
      },
      log: () => {},
      validateArtifacts: () => {
        throw new Error("missing oras");
      },
      runScript: (scriptName: string) => calls.push(scriptName),
    })).rejects.toThrow("missing oras");

    expect(calls).toEqual([]);
  });

  it("prints copy-ready EdgeOne release parameters after archiving", async () => {
    const logs: string[] = [];

    await executeBuildReleaseArtifacts({
      env: {
        ...baseEnv,
        NO_COLOR: "1",
        FRONTEND_ARTIFACT_MATRIX: "eo:cn-lightvela-prod",
        FRONTEND_ARTIFACT_BUILD_OUTPUT_ROOT: "/tmp/frontend-artifact-builds",
      },
      log: (message: string) => logs.push(message),
      validateArtifacts: () => {},
      runTypecheck: () => {},
      runScript: () => {},
      archiveAndVerifyArtifact: () => ({
        manifest: {
          shortSha: "dfde008ca43a",
        },
        ref: "registry.example.com/lightclaw/frontend-pages:dfde008ca43a-eo-cn-lightvela-prod",
      }),
    });

    expect(logs.join("\n")).toContain([
      "============================================================",
      "可发布版本：EdgeOne 国内正式站",
      "CI：发布 frontend eo:cn-lightvela-prod",
      "FRONTEND_ARTIFACT_SOURCE_SHA=dfde008ca43a",
      "FRONTEND_ARTIFACT_REF=registry.example.com/lightclaw/frontend-pages:dfde008ca43a-eo-cn-lightvela-prod",
      "============================================================",
    ].join("\n"));
    expect(logs.join("\n")).toContain("可发布版本汇总");
  });

  it("prints all selected matrix release hints together at the end", async () => {
    const logs: string[] = [];

    await executeBuildReleaseArtifacts({
      env: {
        ...baseEnv,
        NO_COLOR: "1",
        FRONTEND_ARTIFACT_MATRIX: "cf:cn-lightvela-staging,eo:global-lightvela-intl-prod",
        FRONTEND_ARTIFACT_BUILD_OUTPUT_ROOT: "/tmp/frontend-artifact-builds",
      },
      log: (message: string) => logs.push(message),
      validateArtifacts: () => {},
      runTypecheck: () => {},
      runScript: () => {},
      archiveAndVerifyArtifact: ({ combo }) => ({
        manifest: {
          shortSha: "dfde008ca43a",
        },
        ref: `registry.example.com/lightclaw/frontend-pages:dfde008ca43a-${combo.id.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase()}`,
      }),
    });

    const summaryLog = logs.at(-1) ?? "";
    expect(summaryLog).toContain("可发布版本汇总");
    expect(summaryLog).toContain("可发布版本：Cloudflare 国内预发站");
    expect(summaryLog).toContain("CI：构建 frontend");
    expect(summaryLog).toContain("FRONTEND_ARTIFACT_REF=registry.example.com/lightclaw/frontend-pages:dfde008ca43a-cf-cn-lightvela-staging");
    expect(summaryLog).toContain("可发布版本：EdgeOne 国际正式站");
    expect(summaryLog).toContain("CI：发布 frontend eo:global-lightvela-intl-prod");
    expect(summaryLog).toContain("FRONTEND_ARTIFACT_REF=registry.example.com/lightclaw/frontend-pages:dfde008ca43a-eo-global-lightvela-intl-prod");
  });

  it("isolates concurrent outputs for combos that share the same package script", async () => {
    const buildOutputs: string[] = [];
    const archiveOutputs: string[] = [];

    await executeBuildReleaseArtifacts({
      env: {
        ...baseEnv,
        FRONTEND_ARTIFACT_MATRIX: "cf:cn-lightvela-staging,eo:cn-lightvela-prod",
        FRONTEND_ARTIFACT_BUILD_OUTPUT_ROOT: "/tmp/frontend-artifact-builds",
        FRONTEND_ARTIFACT_BUILD_CONCURRENCY: "2",
      },
      log: () => {},
      validateArtifacts: () => {},
      runTypecheck: () => {},
      runScript: (scriptName: string, comboEnv: Record<string, string>) => {
        buildOutputs.push(`${scriptName}:${comboEnv.FRONTEND_BUILD_OUTPUT_DIR}:${comboEnv.CLOUDFLARE_PAGES_DIR ?? comboEnv.EDGEONE_PAGES_DIR}`);
      },
      archiveAndVerifyArtifact: ({ combo, comboEnv }) => {
        archiveOutputs.push(`${combo.id}:${comboEnv.CLOUDFLARE_PAGES_DIR ?? comboEnv.EDGEONE_PAGES_DIR}`);
        return {
          manifest: { shortSha: "dfde008ca43a" },
          ref: `registry.example.com/lightclaw/frontend-pages:dfde008ca43a-${combo.id.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase()}`,
        };
      },
    });

    expect(buildOutputs).toEqual([
      "build:cn:/tmp/frontend-artifact-builds/cf-cn-lightvela-staging:/tmp/frontend-artifact-builds/cf-cn-lightvela-staging",
      "build:cn:/tmp/frontend-artifact-builds/eo-cn-lightvela-prod:/tmp/frontend-artifact-builds/eo-cn-lightvela-prod",
    ]);
    expect(archiveOutputs).toEqual([
      "cf:cn-lightvela-staging:/tmp/frontend-artifact-builds/cf-cn-lightvela-staging",
      "eo:cn-lightvela-prod:/tmp/frontend-artifact-builds/eo-cn-lightvela-prod",
    ]);
  });
});
