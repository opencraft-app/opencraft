import { describe, expect, it } from "vitest";

import {
  createComboEnvironment,
  formatComboSummary,
  loadReleaseMatrix,
  resolveComboProjectName,
  resolveSelectedComboIds,
  selectReleaseCombos,
  validateRequiredSecrets,
} from "./release-matrix.mjs";

const cnCfCombo = {
  id: "cn-cf",
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

const globalCfCombo = {
  ...cnCfCombo,
  id: "global-cf",
  region: "global",
  buildCommand: "build:global",
  projectName: "lightvela-intl",
  authApiBaseUrl: "https://lightclaw.tech",
  outputDir: "dist-global",
};

describe("release matrix helpers", () => {
  it("parses explicit matrix selections", () => {
    expect(resolveSelectedComboIds("cn-cf, global-cf, cn-cf")).toEqual(["cn-cf", "global-cf"]);
    expect(resolveSelectedComboIds("")).toBeNull();
  });

  it("selects configured combos and rejects unknown ids", () => {
    const combos = [cnCfCombo, globalCfCombo];
    expect(selectReleaseCombos(combos, ["global-cf"])).toEqual([combos[1]]);
    expect(() => selectReleaseCombos(combos, ["missing"])).toThrow("unknown frontend release matrix combo id(s): missing");
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

    const comboEnv = createComboEnvironment(cnCfCombo, "lightclaw", env);

    expect(comboEnv.VITE_AUTH_API_BASE_URL).toBe("https://lightclaw.tech");
    expect(comboEnv.VITE_AEGIS_ENABLED).toBe("false");
    expect(comboEnv.VITE_AEGIS_ID).toBeUndefined();
    expect(comboEnv.CLOUDFLARE_PAGES_PROJECT_NAME).toBe("lightclaw");
    expect(comboEnv.CLOUDFLARE_PAGES_DIR).toBe("dist-cn");
    expect(formatComboSummary(cnCfCombo, "lightclaw")).toContain("cn-cf");
  });

  it("creates Cloudflare env for the global intl site", () => {
    const comboEnv = createComboEnvironment(globalCfCombo, "lightvela-intl", {
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "account",
    });

    expect(comboEnv.FRONTEND_RELEASE_REGION).toBe("global");
    expect(comboEnv.CLOUDFLARE_PAGES_PROJECT_NAME).toBe("lightvela-intl");
    expect(comboEnv.CLOUDFLARE_PAGES_DIR).toBe("dist-global");
    expect(comboEnv.VITE_AUTH_API_BASE_URL).toBe("https://lightclaw.tech");
    expect(comboEnv.VITE_AEGIS_ENABLED).toBe("false");
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
});
