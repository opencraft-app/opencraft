import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __runtimeConfigTestHooks } from "@/contexts/runtime-config-context";

const {
  PAID_BILLING_OVERRIDE_STORAGE_KEY,
  applyRuntimeOverrides,
  normalizeRuntimeConfig,
  resolvePaidBillingEnabled,
} = __runtimeConfigTestHooks;

describe("runtime config normalization", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults paid billing to disabled for missing or malformed payloads", () => {
    expect(normalizeRuntimeConfig(null).features.paidBillingEnabled).toBe(false);
    expect(normalizeRuntimeConfig({}).features.paidBillingEnabled).toBe(false);
    expect(normalizeRuntimeConfig({ features: null }).features.paidBillingEnabled).toBe(false);
    expect(normalizeRuntimeConfig({ features: { paidBillingEnabled: "true" } }).features.paidBillingEnabled).toBe(false);
  });

  it("enables paid billing only for an explicit boolean true", () => {
    expect(normalizeRuntimeConfig({ features: { paidBillingEnabled: true } }).features.paidBillingEnabled).toBe(true);
    expect(normalizeRuntimeConfig({ features: { paidBillingEnabled: false } }).features.paidBillingEnabled).toBe(false);
  });

  it("requires both cn site and runtime flag before paid billing is effective", () => {
    const enabledConfig = normalizeRuntimeConfig({ features: { paidBillingEnabled: true } });
    expect(resolvePaidBillingEnabled(enabledConfig, true)).toBe(true);
    expect(resolvePaidBillingEnabled(enabledConfig, false)).toBe(false);
    expect(resolvePaidBillingEnabled(normalizeRuntimeConfig(null), true)).toBe(false);
  });

  it("allows a console/localStorage override without requiring a backend switch", () => {
    window.localStorage.setItem(PAID_BILLING_OVERRIDE_STORAGE_KEY, "true");

    expect(applyRuntimeOverrides(normalizeRuntimeConfig(null)).features.paidBillingEnabled).toBe(true);

    window.localStorage.setItem(PAID_BILLING_OVERRIDE_STORAGE_KEY, "off");

    expect(
      applyRuntimeOverrides(normalizeRuntimeConfig({ features: { paidBillingEnabled: true } }))
        .features
        .paidBillingEnabled,
    ).toBe(false);
  });

  it("ignores malformed console/localStorage override values", () => {
    window.localStorage.setItem(PAID_BILLING_OVERRIDE_STORAGE_KEY, "yes please");

    expect(
      applyRuntimeOverrides(normalizeRuntimeConfig({ features: { paidBillingEnabled: false } }))
        .features
        .paidBillingEnabled,
    ).toBe(false);
  });
});
