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
  buildCommand: "build:next",
  deployCommand: "deploy:cf",
  projectName: "lightclaw",
  requiredSecretEnv: [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
  ],
  authApiBaseUrl: "https://lightclaw.tech",
  outputDir: "out",
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
  buildCommand: "build:next",
  projectName: "lightvela-intl",
  authApiBaseUrl: "https://api-sandbox-kr-1.lightclaw.tech",
  outputDir: "out",
};

const globalCfObservedCombo = {
  ...globalCfCombo,
  observability: {
    aegis: {
      enabled: "true",
      id: "2ellOCK3ozed3owgOj",
      hostUrl: "https://rumt-sg.com",
    },
    posthog: {
      enabled: "false",
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
    expect(comboEnv.NEXT_PUBLIC_REGION).toBe("cn");
    expect(comboEnv.NEXT_PUBLIC_AUTH_API_BASE_URL).toBe("https://lightclaw.tech");
    expect(comboEnv.VITE_AEGIS_ENABLED).toBe("true");
    expect(comboEnv.VITE_AEGIS_ID).toBe("4e66EF5XoPEXx3y8lw");
    expect(comboEnv.VITE_AEGIS_HOST_URL).toBe("https://rumt-zh.com");
    expect(comboEnv.CLOUDFLARE_PAGES_PROJECT_NAME).toBe("lightclaw");
    expect(comboEnv.CLOUDFLARE_PAGES_DIR).toBe("out");
    expect(formatComboSummary(cnCfCombo, "lightclaw")).toContain("cf:cn-lightvela-staging");
  });

  it("creates Cloudflare env for the global intl site", () => {
    const comboEnv = createComboEnvironment(globalCfObservedCombo, "lightvela-intl", {
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "account",
    });

    expect(comboEnv.FRONTEND_RELEASE_REGION).toBe("global");
    expect(comboEnv.CLOUDFLARE_PAGES_PROJECT_NAME).toBe("lightvela-intl");
    expect(comboEnv.CLOUDFLARE_PAGES_DIR).toBe("out");
    expect(comboEnv.VITE_AUTH_API_BASE_URL).toBe("https://api-sandbox-kr-1.lightclaw.tech");
    expect(comboEnv.NEXT_PUBLIC_REGION).toBe("global");
    expect(comboEnv.NEXT_PUBLIC_AUTH_API_BASE_URL).toBe("https://api-sandbox-kr-1.lightclaw.tech");
    expect(comboEnv.VITE_AEGIS_ENABLED).toBe("true");
    expect(comboEnv.VITE_AEGIS_ID).toBe("2ellOCK3ozed3owgOj");
    expect(comboEnv.VITE_AEGIS_HOST_URL).toBe("https://rumt-sg.com");
    expect(comboEnv.VITE_POSTHOG_ENABLED).toBe("false");
    expect(comboEnv.VITE_POSTHOG_PROJECT_TOKEN).toBeUndefined();
    expect(comboEnv.VITE_POSTHOG_HOST).toBeUndefined();
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

  it("injects global PostHog environment from explicit combo config", () => {
    const comboEnv = createComboEnvironment({
      ...globalCfCombo,
      observability: {
        posthog: {
          enabled: "true",
          projectToken: "ph_test",
          host: "https://us.i.posthog.com",
          uiHost: "https://us.posthog.com",
        },
      },
    }, "lightvela-intl", {
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "account",
      VITE_POSTHOG_PROJECT_TOKEN: "ambient-token",
      VITE_POSTHOG_HOST: "https://ambient.example.com",
    });

    expect(comboEnv.VITE_POSTHOG_ENABLED).toBe("true");
    expect(comboEnv.VITE_POSTHOG_PROJECT_TOKEN).toBe("ph_test");
    expect(comboEnv.VITE_POSTHOG_HOST).toBe("https://us.i.posthog.com");
    expect(comboEnv.VITE_POSTHOG_UI_HOST).toBe("https://us.posthog.com");
    expect(comboEnv.NEXT_PUBLIC_POSTHOG_ENABLED).toBe("true");
    expect(comboEnv.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN).toBe("ph_test");
    expect(comboEnv.NEXT_PUBLIC_POSTHOG_HOST).toBe("https://us.i.posthog.com");
    expect(comboEnv.NEXT_PUBLIC_POSTHOG_UI_HOST).toBe("https://us.posthog.com");
  });

  it("injects global PostHog project token from CI secret env", () => {
    const comboEnv = createComboEnvironment({
      ...globalCfCombo,
      observability: {
        posthog: {
          enabled: "true",
          host: "https://eu.i.posthog.com",
          uiHost: "https://eu.posthog.com",
        },
      },
    }, "lightvela-intl", {
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "account",
      POSTHOG_PROJECT_TOKEN: "ph_ci_secret",
    });

    expect(comboEnv.VITE_POSTHOG_ENABLED).toBe("true");
    expect(comboEnv.VITE_POSTHOG_PROJECT_TOKEN).toBe("ph_ci_secret");
    expect(comboEnv.NEXT_PUBLIC_POSTHOG_ENABLED).toBe("true");
    expect(comboEnv.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN).toBe("ph_ci_secret");
    expect(comboEnv.NEXT_PUBLIC_POSTHOG_HOST).toBe("https://eu.i.posthog.com");
  });

  it("does not leak ambient PostHog values when combo omits them", () => {
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
      VITE_POSTHOG_PROJECT_TOKEN: "ambient-token",
      VITE_POSTHOG_HOST: "https://ambient.example.com",
      VITE_POSTHOG_UI_HOST: "https://ambient-ui.example.com",
    });

    expect(comboEnv.VITE_POSTHOG_ENABLED).toBe("false");
    expect(comboEnv.VITE_POSTHOG_PROJECT_TOKEN).toBeUndefined();
    expect(comboEnv.VITE_POSTHOG_HOST).toBeUndefined();
    expect(comboEnv.VITE_POSTHOG_UI_HOST).toBeUndefined();
    expect(comboEnv.NEXT_PUBLIC_POSTHOG_ENABLED).toBe("false");
    expect(comboEnv.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN).toBeUndefined();
    expect(comboEnv.NEXT_PUBLIC_POSTHOG_HOST).toBeUndefined();
    expect(comboEnv.NEXT_PUBLIC_POSTHOG_UI_HOST).toBeUndefined();
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

  it("rejects enabled PostHog config without host", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-matrix-"));
    const matrixPath = join(dir, "release-matrix.json");
    try {
      writeFileSync(matrixPath, JSON.stringify({
        combos: [{
          ...globalCfCombo,
          observability: {
            posthog: {
              enabled: "true",
            },
          },
        }],
      }));

      expect(() => loadReleaseMatrix(matrixPath)).toThrow("must define observability.posthog.host when enabled=true");
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
      outputDir: "out",
      deployEnv: {
        EDGEONE_PAGES_AREA: "global",
        EDGEONE_PAGES_ENV: "preview",
      },
    };

    const comboEnv = createComboEnvironment(eoCombo, "lightvela-preview", {
      EDGEONE_API_TOKEN: "token",
    });

    expect(comboEnv.EDGEONE_PAGES_PROJECT_NAME).toBe("lightvela-preview");
    expect(comboEnv.EDGEONE_PAGES_DIR).toBe("out");
    expect(comboEnv.EDGEONE_PAGES_AREA).toBe("global");
    expect(comboEnv.EDGEONE_PAGES_ENV).toBe("preview");
  });

  it("keeps preview static assets unversioned unless the combo opts in", () => {
    const eoPreviewCombo = {
      ...cnCfCombo,
      id: "cn-eo-preview",
      channel: "eo",
      deployCommand: "deploy:eo",
      projectName: "lightvela-preview",
      requiredSecretEnv: ["EDGEONE_API_TOKEN"],
      outputDir: "out",
      deployEnv: {
        EDGEONE_PAGES_AREA: "global",
        EDGEONE_PAGES_ENV: "preview",
      },
    };

    const comboEnv = createComboEnvironment(eoPreviewCombo, "lightvela-preview", {
      EDGEONE_API_TOKEN: "token",
      NEXT_PUBLIC_ASSET_PREFIX: "/ambient",
    });

    expect(comboEnv.NEXT_VERSION_STATIC_ASSETS).toBeUndefined();
    expect(comboEnv.NEXT_PUBLIC_RELEASE_ID).toBeUndefined();
    expect(comboEnv.NEXT_PUBLIC_ASSET_PREFIX).toBeUndefined();
  });

  it("generates a versioned static asset prefix for opted-in EdgeOne production combos", () => {
    const eoProdCombo = {
      ...cnCfCombo,
      id: "cn-eo-prod",
      channel: "eo",
      deployCommand: "deploy:eo",
      projectName: "lightvela",
      requiredSecretEnv: ["EDGEONE_API_TOKEN"],
      outputDir: "out",
      deployEnv: {
        EDGEONE_PAGES_AREA: "global",
        EDGEONE_PAGES_ENV: "production",
        NEXT_VERSION_STATIC_ASSETS: "1",
      },
    };

    const comboEnv = createComboEnvironment(eoProdCombo, "lightvela", {
      EDGEONE_API_TOKEN: "token",
      CI_COMMIT_SHA: "1234567890abcdef",
    });

    expect(comboEnv.NEXT_VERSION_STATIC_ASSETS).toBe("1");
    expect(comboEnv.NEXT_PUBLIC_RELEASE_ID).toMatch(/^\d{14}-1234567890ab-cn$/);
    expect(comboEnv.NEXT_PUBLIC_ASSET_PREFIX).toBe(`/__releases/${comboEnv.NEXT_PUBLIC_RELEASE_ID}`);
  });

  it("includes China Cloudflare Aegis config in the release matrix", () => {
    const { combos } = loadReleaseMatrix();
    const combo = combos.find((item) => item.id === "cf:cn-lightvela-staging");

    expect(combo).toMatchObject({
      region: "cn",
      channel: "cf",
      buildCommand: "build:next",
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
      buildCommand: "build:next",
      projectName: "lightvela-intl",
      authApiBaseUrl: "https://api-sandbox-kr-1.lightclaw.tech",
      observability: {
        aegis: {
          enabled: "true",
          id: "2ellOCK3ozed3owgOj",
          hostUrl: "https://rumt-sg.com",
        },
        posthog: {
          enabled: "false",
        },
      },
    });
  });

  it("includes the production China EdgeOne lightvela project in the release matrix", () => {
    const { combos } = loadReleaseMatrix();
    const combo = combos.find((item) => item.id === "eo:cn-lightvela-prod-next");

    expect(combo).toMatchObject({
      region: "cn",
      channel: "eo",
      buildCommand: "build:next",
      deployCommand: "deploy:eo",
      projectName: "lightvela",
      authApiBaseUrl: "https://api.lightvela.com",
      siteUrl: "https://lightvela.com",
      outputDir: "out",
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
        NEXT_PUBLIC_WECHAT_PAY_AUTH_BASE_URL: "https://api.lightvela.com",
        NEXT_PUBLIC_WX_BUY_HOST: "buy.cloud.tencent.com",
        NEXT_PUBLIC_WX_PAY_PRODUCT_ID: "lightvela_pro_v1",
      },
    });
    expect(combo?.requiredSecretEnv).toContain("EDGEONE_API_TOKEN");
    expect(createComboEnvironment(combo!, combo!.projectName).NEXT_PUBLIC_WECHAT_PAY_AUTH_BASE_URL).toBe(
      "https://api.lightvela.com",
    );
    expect(createComboEnvironment(combo!, combo!.projectName).NEXT_PUBLIC_WX_BUY_HOST).toBe(
      "buy.cloud.tencent.com",
    );
    expect(createComboEnvironment(combo!, combo!.projectName).NEXT_PUBLIC_WX_PAY_PRODUCT_ID).toBe(
      "lightvela_pro_v1",
    );
  });

  it("includes the production global EdgeOne lightvela intl project in the release matrix", () => {
    const { combos } = loadReleaseMatrix();
    const combo = combos.find((item) => item.id === "eo:global-lightvela-intl-prod-next");

    expect(combo).toMatchObject({
      region: "global",
      channel: "eo",
      buildCommand: "build:next",
      deployCommand: "deploy:eo",
      projectName: "lightvela-intl",
      authApiBaseUrl: "https://api.lightvela.ai",
      siteUrl: "https://lightvela.ai",
      outputDir: "out",
      observability: {
        aegis: {
          enabled: "true",
          id: "2ellOCK3ozed3owgOj",
          hostUrl: "https://rumt-sg.com",
        },
        posthog: {
          enabled: "true",
          projectToken: undefined,
          host: "https://eu.i.posthog.com",
          uiHost: "https://eu.posthog.com",
        },
      },
      deployEnv: {
        EDGEONE_PAGES_AREA: "global",
        EDGEONE_PAGES_ENV: "production",
      },
    });
    expect(combo?.requiredSecretEnv).toContain("EDGEONE_API_TOKEN");
    expect(combo?.requiredSecretEnv).toContain("POSTHOG_PROJECT_TOKEN");
  });

  it("injects the production global site URL for SEO static output", () => {
    const { combos } = loadReleaseMatrix();
    const combo = combos.find((item) => item.id === "eo:global-lightvela-intl-prod-next");
    expect(combo).toBeDefined();

    const comboEnv = createComboEnvironment(combo!, "lightvela-intl", {
      EDGEONE_API_TOKEN: "token",
      POSTHOG_PROJECT_TOKEN: "posthog-token",
    });

    expect(comboEnv.NEXT_PUBLIC_SITE_URL).toBe("https://lightvela.ai");
    expect(comboEnv.SITE_URL).toBe("https://lightvela.ai");
    expect(comboEnv.NEXT_PUBLIC_GLOBAL_SITE_URL).toBe("https://lightvela.ai");
    expect(comboEnv.GLOBAL_SITE_URL).toBe("https://lightvela.ai");
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

    expect(calls).toEqual(["build:next", "deploy:cf"]);
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

    expect(calls).toEqual(["validate-artifacts", "build:next", "artifact:cf:cn-lightvela-staging", "deploy:cf"]);
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

    expect(calls).toEqual(["validate-artifacts", "build:next", "artifact"]);
  });
});
