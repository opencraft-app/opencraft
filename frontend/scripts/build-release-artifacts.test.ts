import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { executeBuildReleaseArtifacts, runFrontendArtifactBuildCommand } from "./build-release-artifacts.mjs";

const baseEnv = {
  FRONTEND_ARTIFACT_MODE: "required",
  FRONTEND_ARTIFACT_REPOSITORY: "registry.example.com/lightclaw/frontend-pages",
  FRONTEND_ARTIFACT_SOURCE_SHA: "dfde008ca43aba0cb0dcdfcc1b0c66bd204a2ea8",
};

describe("build release artifacts", () => {
  it("rejects non-Next build commands", async () => {
    const calls: string[] = [];

    await expect(runFrontendArtifactBuildCommand("build:cn", {
      FRONTEND_BUILD_OUTPUT_DIR: "/tmp/frontend-artifact-builds/cn",
      NODE_BIN: "node-bin",
      PNPM_BIN: "pnpm-bin",
    }, async (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(" ")}`);
    })).rejects.toThrow("frontend artifact builds only support build:next");

    expect(calls).toEqual([]);
  });

  it("runs the Next static docs build and copies out into the artifact output dir", async () => {
    const calls: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "frontend-next-artifact-"));
    const outputDir = join(root, "eo-cn-lightvela-prod-next");

    try {
      await runFrontendArtifactBuildCommand("build:next", {
        FRONTEND_BUILD_OUTPUT_DIR: outputDir,
        NODE_BIN: "node-bin",
        PNPM_BIN: "pnpm-bin",
      }, async (command: string, args: string[]) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "pnpm-bin" && args.join(" ") === "exec next build --webpack") {
          mkdirSync("out/api", { recursive: true });
          writeFileSync("out/index.html", "<html></html>");
          writeFileSync("out/api/search", "{}");
        }
        if (command === "node-bin" && args.join(" ") === "scripts/fix-next-static-html-lang.mjs") {
          mkdirSync("out/.edgeone/assets", { recursive: true });
          mkdirSync("out/.edgeone/cloud-functions/ssr-node", { recursive: true });
          writeFileSync("out/.edgeone/assets/index.html", "<html></html>");
          writeFileSync("out/.edgeone/cloud-functions/ssr-node/config.json", "{}");
        }
      });

      expect(calls).toEqual([
        "node-bin scripts/subset-fonts.mjs",
        "node-bin scripts/sync-fumadocs-content.mjs",
        "pnpm-bin exec fumadocs-mdx",
        "pnpm-bin exec next build --webpack",
        "node-bin scripts/fix-next-static-html-lang.mjs",
      ]);
      expect(existsSync(join(outputDir, "index.html"))).toBe(true);
      expect(existsSync(join(outputDir, "api", "search"))).toBe(true);
      expect(existsSync(join(outputDir, ".edgeone", "assets", "index.html"))).toBe(true);
      expect(existsSync(join(outputDir, ".edgeone", "cloud-functions", "ssr-node", "config.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync("out", { recursive: true, force: true });
    }
  });

  it("selects from FRONTEND_ARTIFACT_MATRIX and archives without deploying", async () => {
    const calls: string[] = [];

    await executeBuildReleaseArtifacts({
      env: {
        ...baseEnv,
        FRONTEND_ARTIFACT_MATRIX: "eo:cn-lightvela-prod-next,eo:global-lightvela-intl-prod-next",
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
      "build:next",
      "build:next",
      "artifact:eo:cn-lightvela-prod-next",
      "artifact:eo:global-lightvela-intl-prod-next",
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

    expect(calls).toEqual(["validate-artifacts", "typecheck", "build:next", "artifact:cf:cn-lightvela-staging"]);
  });

  it("requires artifact mode before building", async () => {
    const calls: string[] = [];

    await expect(executeBuildReleaseArtifacts({
      env: {
        FRONTEND_ARTIFACT_MATRIX: "eo:cn-lightvela-prod-next",
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
        FRONTEND_ARTIFACT_MATRIX: "eo:cn-lightvela-prod-next",
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
        FRONTEND_ARTIFACT_MATRIX: "eo:cn-lightvela-prod-next",
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
        ref: "registry.example.com/lightclaw/frontend-pages:dfde008ca43a-eo-cn-lightvela-prod-next",
      }),
    });

    expect(logs.join("\n")).toContain([
      "============================================================",
      "可发布版本：EdgeOne 国内正式站（Next）",
      "CI：发布 frontend eo:cn-lightvela-prod-next",
      "FRONTEND_ARTIFACT_SOURCE_SHA=dfde008ca43a",
      "FRONTEND_ARTIFACT_REF=registry.example.com/lightclaw/frontend-pages:dfde008ca43a-eo-cn-lightvela-prod-next",
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
        FRONTEND_ARTIFACT_MATRIX: "cf:cn-lightvela-staging,eo:global-lightvela-intl-prod-next",
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
    expect(summaryLog).toContain("可发布版本：EdgeOne 国际正式站（Next）");
    expect(summaryLog).toContain("CI：发布 frontend eo:global-lightvela-intl-prod-next");
    expect(summaryLog).toContain("FRONTEND_ARTIFACT_REF=registry.example.com/lightclaw/frontend-pages:dfde008ca43a-eo-global-lightvela-intl-prod-next");
  });

  it("isolates concurrent outputs across selected release combos", async () => {
    const buildOutputs: string[] = [];
    const archiveOutputs: string[] = [];

    await executeBuildReleaseArtifacts({
      env: {
        ...baseEnv,
        FRONTEND_ARTIFACT_MATRIX: "cf:cn-lightvela-staging,eo:cn-lightvela-prod-next",
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
      "build:next:/tmp/frontend-artifact-builds/cf-cn-lightvela-staging:/tmp/frontend-artifact-builds/cf-cn-lightvela-staging",
      "build:next:/tmp/frontend-artifact-builds/eo-cn-lightvela-prod-next:/tmp/frontend-artifact-builds/eo-cn-lightvela-prod-next",
    ]);
    expect(archiveOutputs).toEqual([
      "cf:cn-lightvela-staging:/tmp/frontend-artifact-builds/cf-cn-lightvela-staging",
      "eo:cn-lightvela-prod-next:/tmp/frontend-artifact-builds/eo-cn-lightvela-prod-next",
    ]);
  });
});
