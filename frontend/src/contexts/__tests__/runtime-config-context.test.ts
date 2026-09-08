import { describe, expect, it } from "vitest";
import { __runtimeConfigTestHooks } from "@/contexts/runtime-config-context";

const {
  applyRuntimeOverrides,
  getEdgeOnePreviewRuntimeConfig,
  normalizeRuntimeConfig,
  PAID_BILLING_OVERRIDE_STORAGE_KEY,
  ZERO_TOKEN_AUTOMATIONS_OVERRIDE_STORAGE_KEY,
  resolvePaidBillingEnabled,
  resolveRealnamePhoneVerificationEnabled,
  shouldSkipRemoteRuntimeConfig,
} = __runtimeConfigTestHooks;

describe("runtime config normalization", () => {
  it("defaults paid billing to enabled for missing or malformed payloads", () => {
    expect(normalizeRuntimeConfig(null).features.paidBillingEnabled).toBe(true);
    expect(normalizeRuntimeConfig(null).features.realnamePhoneVerificationEnabled).toBe(true);
    expect(normalizeRuntimeConfig(null).features.zeroTokenAutomationsEnabled).toBe(true);
    expect(normalizeRuntimeConfig({}).features.paidBillingEnabled).toBe(true);
    expect(normalizeRuntimeConfig({ features: null }).features.paidBillingEnabled).toBe(true);
    expect(normalizeRuntimeConfig({ features: { paidBillingEnabled: "true" } }).features.paidBillingEnabled).toBe(false);
    expect(
      normalizeRuntimeConfig({ features: { realnamePhoneVerificationEnabled: "true" } })
        .features
        .realnamePhoneVerificationEnabled,
    ).toBe(false);
  });

  it("defaults zero-token automations on unless explicitly disabled", () => {
    expect(
      normalizeRuntimeConfig({ features: { zeroTokenAutomationsEnabled: true } })
        .features.zeroTokenAutomationsEnabled,
    ).toBe(true);
    expect(
      normalizeRuntimeConfig({ features: { zeroTokenAutomationsEnabled: "true" } })
        .features.zeroTokenAutomationsEnabled,
    ).toBe(true);
    expect(
      normalizeRuntimeConfig({ features: { zeroTokenAutomationsEnabled: false } })
        .features.zeroTokenAutomationsEnabled,
    ).toBe(false);
    expect(normalizeRuntimeConfig({}).features.zeroTokenAutomationsEnabled).toBe(true);
    expect(
      normalizeRuntimeConfig({
        features: {
          paidBillingEnabled: true,
          realnamePhoneVerificationEnabled: true,
        },
      }).features.zeroTokenAutomationsEnabled,
    ).toBe(true);
  });

  it("allows a local emergency override for the zero-token creation entry", () => {
    window.localStorage.setItem(ZERO_TOKEN_AUTOMATIONS_OVERRIDE_STORAGE_KEY, "false");
    expect(
      applyRuntimeOverrides(normalizeRuntimeConfig({ features: { zeroTokenAutomationsEnabled: true } }))
        .features.zeroTokenAutomationsEnabled,
    ).toBe(false);
    window.localStorage.removeItem(ZERO_TOKEN_AUTOMATIONS_OVERRIDE_STORAGE_KEY);

    window.localStorage.setItem(ZERO_TOKEN_AUTOMATIONS_OVERRIDE_STORAGE_KEY, "true");
    expect(
      applyRuntimeOverrides(normalizeRuntimeConfig({ features: { zeroTokenAutomationsEnabled: false } }))
        .features.zeroTokenAutomationsEnabled,
    ).toBe(false);
    window.localStorage.removeItem(ZERO_TOKEN_AUTOMATIONS_OVERRIDE_STORAGE_KEY);
  });

  it("enables paid billing only for an explicit boolean true", () => {
    expect(normalizeRuntimeConfig({ features: { paidBillingEnabled: true } }).features.paidBillingEnabled).toBe(true);
    expect(normalizeRuntimeConfig({ features: { paidBillingEnabled: false } }).features.paidBillingEnabled).toBe(false);
  });

  it("enables phone realname only for an explicit boolean true", () => {
    expect(
      normalizeRuntimeConfig({ features: { realnamePhoneVerificationEnabled: true } })
        .features
        .realnamePhoneVerificationEnabled,
    ).toBe(true);
    expect(
      normalizeRuntimeConfig({ features: { realnamePhoneVerificationEnabled: false } })
        .features
        .realnamePhoneVerificationEnabled,
    ).toBe(false);
  });

  it("keeps paid billing fully enabled on the cn site", () => {
    const enabledConfig = normalizeRuntimeConfig({ features: { paidBillingEnabled: true } });
    expect(resolvePaidBillingEnabled(enabledConfig)).toBe(true);
    expect(resolvePaidBillingEnabled(normalizeRuntimeConfig(null))).toBe(true);
  });

  it("enables intl paid billing at full scale without a local opt-in", () => {
    /* 国际站已全量放开：与国内站口径一致，后端下发 true 即生效，
       不再要求 localStorage「显式开启」。 */
    const enabledConfig = normalizeRuntimeConfig({ features: { paidBillingEnabled: true } });
    window.localStorage.removeItem(PAID_BILLING_OVERRIDE_STORAGE_KEY);

    expect(resolvePaidBillingEnabled(enabledConfig)).toBe(true);

    /* 显式关闭（紧急熔断）时，override 会先把 config 置 false，全量口径也拦截。 */
    window.localStorage.setItem(PAID_BILLING_OVERRIDE_STORAGE_KEY, "false");
    expect(
      resolvePaidBillingEnabled(
        applyRuntimeOverrides(normalizeRuntimeConfig({ features: { paidBillingEnabled: true } })),
      ),
    ).toBe(false);

    window.localStorage.removeItem(PAID_BILLING_OVERRIDE_STORAGE_KEY);
  });

  it("never enables paid billing when the runtime flag is off", () => {
    const disabledConfig = normalizeRuntimeConfig({ features: { paidBillingEnabled: false } });
    window.localStorage.setItem(PAID_BILLING_OVERRIDE_STORAGE_KEY, "true");

    /* config 为 false 时直接短路，本地开关不能绕过它。 */
    expect(resolvePaidBillingEnabled(disabledConfig)).toBe(false);

    window.localStorage.removeItem(PAID_BILLING_OVERRIDE_STORAGE_KEY);
  });

  it("requires both cn site and runtime flag before phone realname is effective", () => {
    const enabledConfig = normalizeRuntimeConfig({ features: { realnamePhoneVerificationEnabled: true } });
    expect(resolveRealnamePhoneVerificationEnabled(enabledConfig, true)).toBe(true);
    expect(resolveRealnamePhoneVerificationEnabled(enabledConfig, false)).toBe(false);
    expect(resolveRealnamePhoneVerificationEnabled(normalizeRuntimeConfig(null), true)).toBe(true);
  });

  it("skips remote runtime config on EdgeOne preview domains", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        hostname: "lightvela-preview-dpgf2fi2t9cu.edgeone.cool",
      },
    });

    expect(shouldSkipRemoteRuntimeConfig()).toBe(true);
    expect(getEdgeOnePreviewRuntimeConfig().features.zeroTokenAutomationsEnabled).toBe(true);

    window.localStorage.setItem(ZERO_TOKEN_AUTOMATIONS_OVERRIDE_STORAGE_KEY, "false");
    expect(getEdgeOnePreviewRuntimeConfig().features.zeroTokenAutomationsEnabled).toBe(false);
    window.localStorage.removeItem(ZERO_TOKEN_AUTOMATIONS_OVERRIDE_STORAGE_KEY);
  });
});
