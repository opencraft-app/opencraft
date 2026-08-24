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
    // ⚠️ 必须给一个临时 workspaceRoot：被测函数会 rmSync('.next') 与 rmSync('out')。
    // 之前这里没传，测试直接把仓库根的 .next/dev 删了 —— 正在跑的 dev server
    // 从此所有请求返回 500（ENOENT: .next/dev/routes-manifest.json），
    // 而且报错里完全看不出是测试干的。实测踩过一次。
    const workspaceRoot = join(root, "workspace");
    const workspaceOut = join(workspaceRoot, "out");
    mkdirSync(workspaceRoot, { recursive: true });

    try {
      await runFrontendArtifactBuildCommand("build:next", {
        FRONTEND_BUILD_OUTPUT_DIR: outputDir,
        NODE_BIN: "node-bin",
        PNPM_BIN: "pnpm-bin",
      }, async (command: string, args: string[]) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "pnpm-bin" && args.join(" ") === "exec next build") {
          mkdirSync(join(workspaceOut, "api"), { recursive: true });
          writeFileSync(join(workspaceOut, "index.html"), "<html></html>");
          writeFileSync(join(workspaceOut, "api/search"), "{}");
        }
        if (command === "node-bin" && args.join(" ") === "scripts/fix-next-static-html-lang.mjs") {
          mkdirSync(join(workspaceOut, ".edgeone/assets"), { recursive: true });
          mkdirSync(join(workspaceOut, ".edgeone/cloud-functions/ssr-node"), { recursive: true });
          writeFileSync(join(workspaceOut, ".edgeone/assets/index.html"), "<html></html>");
          writeFileSync(join(workspaceOut, ".edgeone/cloud-functions/ssr-node/config.json"), "{}");
        }
        if (command === "node-bin" && args.join(" ") === "scripts/write-edgeone-config.mjs") {
          // 真实脚本会写进 out/.edgeone（即被上传的目录）
          writeFileSync(join(workspaceOut, ".edgeone/edgeone.json"), '{"redirects":[]}');
        }
      }, workspaceRoot);

      expect(calls).toEqual([
        "node-bin scripts/subset-fonts.mjs",
        "node-bin scripts/sync-fumadocs-content.mjs",
        "pnpm-bin exec fumadocs-mdx",
        "pnpm-bin exec next build",
        "node-bin scripts/version-next-static-assets.mjs",
        "node-bin scripts/fix-next-static-html-lang.mjs",
        "node-bin scripts/format-next-static-html.mjs",
        "node-bin scripts/check-versioned-next-static-assets.mjs",
        "node-bin scripts/write-edgeone-config.mjs",
      ]);
      expect(existsSync(join(outputDir, "index.html"))).toBe(true);
      expect(existsSync(join(outputDir, "api", "search"))).toBe(true);
      expect(existsSync(join(outputDir, ".edgeone", "assets", "index.html"))).toBe(true);
      expect(existsSync(join(outputDir, ".edgeone", "cloud-functions", "ssr-node", "config.json"))).toBe(true);
      // edgeone.json 必须在 cpSync 之前生成，才能进入 artifact
      expect(existsSync(join(outputDir, ".edgeone", "edgeone.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scopes the .next / out cleanup to the given workspace root (dev server safety)", async () => {
    // 这条是一次真实事故的专用防线：被测函数会 rmSync('.next')，
    // 原先测试没传 workspaceRoot，于是把仓库根的 .next/dev 删了 ——
    // 正在跑的 dev server 从此所有请求 500，报错里看不出与测试有关。
    const root = mkdtempSync(join(tmpdir(), "frontend-artifact-guard-"));
    const workspaceRoot = join(root, "workspace");
    const outsideRoot = join(root, "not-the-workspace");
    const scopedNext = join(workspaceRoot, ".next", "dev", "routes-manifest.json");
    const outsideNext = join(outsideRoot, ".next", "dev", "routes-manifest.json");
    mkdirSync(join(workspaceRoot, ".next", "dev"), { recursive: true });
    mkdirSync(join(outsideRoot, ".next", "dev"), { recursive: true });
    writeFileSync(scopedNext, "{}");
    writeFileSync(outsideNext, "{}");

    try {
      await runFrontendArtifactBuildCommand(
        "build:next",
        { FRONTEND_BUILD_OUTPUT_DIR: join(root, "artifact"), NODE_BIN: "n", PNPM_BIN: "p" },
        async () => {
          mkdirSync(join(workspaceRoot, "out"), { recursive: true });
          writeFileSync(join(workspaceRoot, "out", "index.html"), "<html></html>");
        },
        workspaceRoot,
      );

      // 指定 workspace 内的 .next 被清掉（真实构建期望的行为）
      expect(existsSync(scopedNext)).toBe(false);
      // workspace 之外的 .next 绝不能被碰到
      expect(existsSync(outsideNext)).toBe(true);
      // 产物仍正常拷贝
      expect(existsSync(join(root, "artifact", "index.html"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
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
