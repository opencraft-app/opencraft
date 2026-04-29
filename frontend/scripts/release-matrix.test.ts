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
      deployEnv: {
        EDGEONE_PAGES_AREA: "global",
        EDGEONE_PAGES_ENV: "production",
      },
    });
    expect(combo?.requiredSecretEnv).toContain("EDGEONE_API_TOKEN");
  });
});
