import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  createComboEnvironment,
  executeReleaseMatrix,
  formatComboSummary,
  loadReleaseMatrix,
  resolveComboProjectName,
  resolveSelectedComboIds,
  selectReleaseCombos,
  validateRequiredSecrets,
} from "./release-matrix.mjs";

const cnCfCombo = {
  id: "cf:cn-lightvela-staging",
  region: "cn",
  channel: "cf",
  buildCommand: "build:cn",
  deployCommand: "deploy:cf",
  projectName: "lightclaw",
  requiredSecretEnv: [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
  ],
  authApiBaseUrl: "https://lightclaw.tech",
  outputDir: "dist-cn",
  deployEnv: {},
};

const cnCfObservedCombo = {
  ...cnCfCombo,
  observability: {
    aegis: {
      enabled: "true",
      id: "4e66EF5XoPEXx3y8lw",
      hostUrl: "https://rumt-zh.com",
    },
  },
};

const globalCfCombo = {
  ...cnCfCombo,
  id: "cf:global-lightvela-intl-staging",
  region: "global",
  buildCommand: "build:global",
  projectName: "lightvela-intl",
  authApiBaseUrl: "https://lightclaw.tech",
  outputDir: "dist-global",
};

const globalCfObservedCombo = {
  ...globalCfCombo,
  observability: {
    aegis: {
      enabled: "true",
      id: "2ellOCK3ozed3owgOj",
      hostUrl: "https://rumt-sg.com",
    },
  },
};

describe("release matrix helpers", () => {
  it("parses explicit matrix selections", () => {
    expect(resolveSelectedComboIds("cf:cn-lightvela-staging, cf:global-lightvela-intl-staging, cf:cn-lightvela-staging")).toEqual(["cf:cn-lightvela-staging", "cf:global-lightvela-intl-staging"]);
    expect(resolveSelectedComboIds("")).toBeNull();
  });

  it("selects configured combos and rejects unknown ids", () => {
    const combos = [cnCfCombo, globalCfCombo];
    expect(selectReleaseCombos(combos, ["cf:global-lightvela-intl-staging"])).toEqual([combos[1]]);
    expect(() => selectReleaseCombos(combos, ["missing"])).toThrow("unknown frontend release matrix combo id(s): missing");
    expect(() => selectReleaseCombos(combos, ["cn-cf"])).toThrow("unknown frontend release matrix combo id(s): cn-cf");
    expect(() => selectReleaseCombos(combos, ["global-cf"])).toThrow("unknown frontend release matrix combo id(s): global-cf");
  });

  it("validates secrets and resolves project names", () => {
    const env = {
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "account",
    };

    expect(() => validateRequiredSecrets(cnCfCombo, env)).not.toThrow();
    expect(resolveComboProjectName(cnCfCombo, env)).toBe("lightclaw");
    expect(resolveComboProjectName(cnCfCombo, {})).toBe("lightclaw");
  });

  it("creates channel-specific deployment env", () => {
    const env = {
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "account",
    };

    const comboEnv = createComboEnvironment(cnCfObservedCombo, "lightclaw", env);

    expect(comboEnv.VITE_AUTH_API_BASE_URL).toBe("https://lightclaw.tech");
    expect(comboEnv.VITE_AEGIS_ENABLED).toBe("true");
    expect(comboEnv.VITE_AEGIS_ID).toBe("4e66EF5XoPEXx3y8lw");
    expect(comboEnv.VITE_AEGIS_HOST_URL).toBe("https://rumt-zh.com");
    expect(comboEnv.CLOUDFLARE_PAGES_PROJECT_NAME).toBe("lightclaw");
    expect(comboEnv.CLOUDFLARE_PAGES_DIR).toBe("dist-cn");
    expect(formatComboSummary(cnCfCombo, "lightclaw")).toContain("cf:cn-lightvela-staging");
  });

  it("creates Cloudflare env for the global intl site", () => {
    const comboEnv = createComboEnvironment(globalCfObservedCombo, "lightvela-intl", {
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "account",
    });

    expect(comboEnv.FRONTEND_RELEASE_REGION).toBe("global");
    expect(comboEnv.CLOUDFLARE_PAGES_PROJECT_NAME).toBe("lightvela-intl");
    expect(comboEnv.CLOUDFLARE_PAGES_DIR).toBe("dist-global");
    expect(comboEnv.VITE_AUTH_API_BASE_URL).toBe("https://lightclaw.tech");
    expect(comboEnv.VITE_AEGIS_ENABLED).toBe("true");
    expect(comboEnv.VITE_AEGIS_ID).toBe("2ellOCK3ozed3owgOj");
    expect(comboEnv.VITE_AEGIS_HOST_URL).toBe("https://rumt-sg.com");
  });

  it("injects Aegis environment from combo observability config", () => {
    const comboEnv = createComboEnvironment({
      ...cnCfCombo,
      observability: {
        aegis: {
          enabled: "true",
          id: "rum-cn",
          hostUrl: "https://rumt-zh.com",
        },
      },
    }, "lightclaw", {
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "account",
      VITE_AEGIS_ID: "should-not-leak",
    });

    expect(comboEnv.VITE_AEGIS_ENABLED).toBe("true");
    expect(comboEnv.VITE_AEGIS_ID).toBe("rum-cn");
    expect(comboEnv.VITE_AEGIS_HOST_URL).toBe("https://rumt-zh.com");
  });

  it("injects global Aegis environment from explicit combo config", () => {
    const comboEnv = createComboEnvironment({
      ...globalCfCombo,
      observability: {
        aegis: {
          enabled: "true",
          id: "rum-global",
          hostUrl: "https://rumt-sg.com",
        },
      },
    }, "lightvela-intl", {
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "account",
      VITE_AEGIS_ID: "should-not-leak",
    });

    expect(comboEnv.VITE_AEGIS_ENABLED).toBe("true");
    expect(comboEnv.VITE_AEGIS_ID).toBe("rum-global");
    expect(comboEnv.VITE_AEGIS_HOST_URL).toBe("https://rumt-sg.com");
  });

  it("does not leak ambient Aegis values when combo omits them", () => {
    const comboEnv = createComboEnvironment({
      ...globalCfCombo,
      observability: {
        aegis: {
          enabled: "auto",
        },
      },
    }, "lightvela-intl", {
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "account",
      VITE_AEGIS_ID: "ambient-id",
      VITE_AEGIS_HOST_URL: "https://ambient.example.com",
    });

    expect(comboEnv.VITE_AEGIS_ENABLED).toBe("auto");
    expect(comboEnv.VITE_AEGIS_ID).toBeUndefined();
    expect(comboEnv.VITE_AEGIS_HOST_URL).toBeUndefined();
  });

  it("rejects enabled Aegis config without id or hostUrl", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-matrix-"));
    const matrixPath = join(dir, "release-matrix.json");
    try {
      writeFileSync(matrixPath, JSON.stringify({
        combos: [{
          ...cnCfCombo,
          observability: {
            aegis: {
              enabled: "true",
              id: "rum-cn",
            },
          },
        }],
      }));

      expect(() => loadReleaseMatrix(matrixPath)).toThrow("must define observability.aegis.id and hostUrl when enabled=true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries optional deploy env values for edgeone combos", () => {
    const eoCombo = {
      ...cnCfCombo,
      id: "cn-eo",
      channel: "eo",
      deployCommand: "deploy:eo",
      projectName: "lightvela-preview",
      requiredSecretEnv: ["EDGEONE_API_TOKEN"],
      outputDir: "dist-cn",
      deployEnv: {
        EDGEONE_PAGES_AREA: "global",
        EDGEONE_PAGES_ENV: "preview",
      },
    };

    const comboEnv = createComboEnvironment(eoCombo, "lightvela-preview", {
      EDGEONE_API_TOKEN: "token",
    });

    expect(comboEnv.EDGEONE_PAGES_PROJECT_NAME).toBe("lightvela-preview");
    expect(comboEnv.EDGEONE_PAGES_DIR).toBe("dist-cn");
    expect(comboEnv.EDGEONE_PAGES_AREA).toBe("global");
    expect(comboEnv.EDGEONE_PAGES_ENV).toBe("preview");
  });

  it("includes China Cloudflare Aegis config in the release matrix", () => {
    const { combos } = loadReleaseMatrix();
    const combo = combos.find((item) => item.id === "cf:cn-lightvela-staging");

    expect(combo).toMatchObject({
      region: "cn",
      channel: "cf",
      buildCommand: "build:cn",
      projectName: "lightclaw",
      observability: {
        aegis: {
          enabled: "true",
          id: "4e66EF5XoPEXx3y8lw",
          hostUrl: "https://rumt-zh.com",
        },
      },
    });
  });

  it("includes global Cloudflare Aegis config in the release matrix", () => {
    const { combos } = loadReleaseMatrix();
    const combo = combos.find((item) => item.id === "cf:global-lightvela-intl-staging");

    expect(combo).toMatchObject({
      region: "global",
      channel: "cf",
      buildCommand: "build:global",
      projectName: "lightvela-intl",
      observability: {
        aegis: {
          enabled: "true",
          id: "2ellOCK3ozed3owgOj",
          hostUrl: "https://rumt-sg.com",
        },
      },
    });
  });

  it("includes the production China EdgeOne lightvela project in the release matrix", () => {
    const { combos } = loadReleaseMatrix();
    const combo = combos.find((item) => item.id === "eo:cn-lightvela-prod");

    expect(combo).toMatchObject({
      region: "cn",
      channel: "eo",
      buildCommand: "build:cn",
      deployCommand: "deploy:eo",
      projectName: "lightvela",
      authApiBaseUrl: "https://api.lightvela.tencent.com",
      outputDir: "dist-cn",
      observability: {
        aegis: {
          enabled: "true",
          id: "4e66EF5XoPEXx3y8lw",
          hostUrl: "https://rumt-zh.com",
        },
      },
      deployEnv: {
        EDGEONE_PAGES_AREA: "global",
        EDGEONE_PAGES_ENV: "production",
      },
    });
    expect(combo?.requiredSecretEnv).toContain("EDGEONE_API_TOKEN");
  });

  it("includes the production global EdgeOne lightvela intl project in the release matrix", () => {
    const { combos } = loadReleaseMatrix();
    const combo = combos.find((item) => item.id === "eo:global-lightvela-intl-prod");

    expect(combo).toMatchObject({
      region: "global",
      channel: "eo",
      buildCommand: "build:global",
      deployCommand: "deploy:eo",
      projectName: "lightvela-intl",
      authApiBaseUrl: "https://lightclaw.tech",
      outputDir: "dist-global",
      observability: {
        aegis: {
          enabled: "true",
          id: "2ellOCK3ozed3owgOj",
          hostUrl: "https://rumt-sg.com",
        },
      },
      deployEnv: {
        EDGEONE_PAGES_AREA: "global",
        EDGEONE_PAGES_ENV: "production",
      },
    });
    expect(combo?.requiredSecretEnv).toContain("EDGEONE_API_TOKEN");
  });

  it("keeps release execution unchanged when artifact mode is unset", () => {
    const calls: string[] = [];

    executeReleaseMatrix({
      env: {
        FRONTEND_RELEASE_MATRIX: "cf:cn-lightvela-staging",
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_ACCOUNT_ID: "account",
      },
      log: () => {},
      runScript: (scriptName: string) => calls.push(scriptName),
      archiveAndVerifyArtifact: () => calls.push("artifact"),
    });

    expect(calls).toEqual(["build:cn", "deploy:cf"]);
  });

  it("rejects unsupported artifact modes before building", () => {
    const calls: string[] = [];

    expect(() => executeReleaseMatrix({
      env: {
        FRONTEND_RELEASE_MATRIX: "cf:cn-lightvela-staging",
        FRONTEND_ARTIFACT_MODE: "dry-run",
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_ACCOUNT_ID: "account",
      },
      log: () => {},
      runScript: (scriptName: string) => calls.push(scriptName),
    })).toThrow("unsupported FRONTEND_ARTIFACT_MODE dry-run");
    expect(calls).toEqual([]);
  });

  it("validates artifact prerequisites before the first build in required mode", () => {
    const calls: string[] = [];

    expect(() => executeReleaseMatrix({
      env: {
        FRONTEND_RELEASE_MATRIX: "cf:cn-lightvela-staging",
        FRONTEND_ARTIFACT_MODE: "required",
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_ACCOUNT_ID: "account",
      },
      log: () => {},
      runScript: (scriptName: string) => calls.push(scriptName),
      validateArtifacts: () => {
        throw new Error("artifact prereq failed");
      },
    })).toThrow("artifact prereq failed");
    expect(calls).toEqual([]);
  });

  it("archives and verifies a combo between build and deploy in required mode", () => {
    const calls: string[] = [];

    executeReleaseMatrix({
      env: {
        FRONTEND_RELEASE_MATRIX: "cf:cn-lightvela-staging",
        FRONTEND_ARTIFACT_MODE: "required",
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_ACCOUNT_ID: "account",
      },
      log: () => {},
      runScript: (scriptName: string) => calls.push(scriptName),
      validateArtifacts: () => calls.push("validate-artifacts"),
      archiveAndVerifyArtifact: ({ combo }) => {
        calls.push(`artifact:${combo.id}`);
        return {
          manifest: {
            shortSha: "dfde008ca43a",
          },
          ref: "registry.example.com/lightclaw/frontend-pages:dfde008ca43a-cf-cn-lightvela-staging",
        };
      },
    });

    expect(calls).toEqual(["validate-artifacts", "build:cn", "artifact:cf:cn-lightvela-staging", "deploy:cf"]);
  });

  it("prints preview release hints for required artifact mode", () => {
    const logs: string[] = [];

    executeReleaseMatrix({
      env: {
        FRONTEND_RELEASE_MATRIX: "cf:cn-lightvela-staging,cf:global-lightvela-intl-staging",
        FRONTEND_ARTIFACT_MODE: "required",
        FRONTEND_ARTIFACT_REPOSITORY: "registry.example.com/lightclaw/frontend-pages",
        FRONTEND_ARTIFACT_SOURCE_SHA: "dfde008ca43aba0cb0dcdfcc1b0c66bd204a2ea8",
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_ACCOUNT_ID: "account",
        NO_COLOR: "1",
      },
      log: (message: string) => logs.push(message),
      runScript: () => {},
      validateArtifacts: () => {},
      archiveAndVerifyArtifact: ({ combo }) => ({
        manifest: {
          shortSha: "dfde008ca43a",
        },
        ref: `registry.example.com/lightclaw/frontend-pages:dfde008ca43a-${combo.id.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase()}`,
      }),
    });

    const logText = logs.join("\n");
    expect(logText).toContain("可发布版本：Cloudflare 国内预发站");
    expect(logText).toContain("FRONTEND_ARTIFACT_REF=registry.example.com/lightclaw/frontend-pages:dfde008ca43a-cf-cn-lightvela-staging");
    expect(logText).toContain("可发布版本：Cloudflare 国际预发站");
    expect(logText).toContain("FRONTEND_ARTIFACT_REF=registry.example.com/lightclaw/frontend-pages:dfde008ca43a-cf-global-lightvela-intl-staging");
    expect(logs.at(-1)).toContain("可发布版本汇总");
  });

  it("does not deploy when required artifact archiving fails", () => {
    const calls: string[] = [];

    expect(() => executeReleaseMatrix({
      env: {
        FRONTEND_RELEASE_MATRIX: "cf:cn-lightvela-staging",
        FRONTEND_ARTIFACT_MODE: "required",
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_ACCOUNT_ID: "account",
      },
      log: () => {},
      runScript: (scriptName: string) => calls.push(scriptName),
      validateArtifacts: () => calls.push("validate-artifacts"),
      archiveAndVerifyArtifact: () => {
        calls.push("artifact");
        throw new Error("archive failed");
      },
    })).toThrow("archive failed");

    expect(calls).toEqual(["validate-artifacts", "build:cn", "artifact"]);
  });
});
