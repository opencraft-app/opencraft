import { describe, expect, it } from "vitest";
import { __runtimeConfigTestHooks } from "@/contexts/runtime-config-context";

const {
  normalizeRuntimeConfig,
  resolvePaidBillingEnabled,
  resolveRealnamePhoneVerificationEnabled,
  shouldSkipRemoteRuntimeConfig,
} = __runtimeConfigTestHooks;

describe("runtime config normalization", () => {
  it("defaults paid billing to enabled for missing or malformed payloads", () => {
    expect(normalizeRuntimeConfig(null).features.paidBillingEnabled).toBe(true);
    expect(normalizeRuntimeConfig(null).features.realnamePhoneVerificationEnabled).toBe(true);
    expect(normalizeRuntimeConfig({}).features.paidBillingEnabled).toBe(true);
    expect(normalizeRuntimeConfig({ features: null }).features.paidBillingEnabled).toBe(true);
    expect(normalizeRuntimeConfig({ features: { paidBillingEnabled: "true" } }).features.paidBillingEnabled).toBe(false);
    expect(
      normalizeRuntimeConfig({ features: { realnamePhoneVerificationEnabled: "true" } })
        .features
        .realnamePhoneVerificationEnabled,
    ).toBe(false);
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

  it("requires both cn site and runtime flag before paid billing is effective", () => {
    const enabledConfig = normalizeRuntimeConfig({ features: { paidBillingEnabled: true } });
    expect(resolvePaidBillingEnabled(enabledConfig, true)).toBe(true);
    expect(resolvePaidBillingEnabled(enabledConfig, false)).toBe(false);
    expect(resolvePaidBillingEnabled(normalizeRuntimeConfig(null), true)).toBe(true);
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
  });
});
