import { describe, expect, it } from "vitest";
import { __runtimeConfigTestHooks } from "@/contexts/runtime-config-context";
import { isGlobal } from "@/lib/region";

const {
  applyRuntimeOverrides,
  hasExplicitPaidBillingOptIn,
  normalizeRuntimeConfig,
  PAID_BILLING_OVERRIDE_STORAGE_KEY,
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

  it("keeps paid billing fully enabled on the cn site", () => {
    const enabledConfig = normalizeRuntimeConfig({ features: { paidBillingEnabled: true } });
    /* 第三个参数是「是否国际站」：国内站已全量，后端下发 true 即生效。 */
    expect(resolvePaidBillingEnabled(enabledConfig, true, false)).toBe(true);
    expect(resolvePaidBillingEnabled(normalizeRuntimeConfig(null), true, false)).toBe(true);
  });

  it("keeps intl paid billing behind an explicit local opt-in", () => {
    const enabledConfig = normalizeRuntimeConfig({ features: { paidBillingEnabled: true } });
    window.localStorage.removeItem(PAID_BILLING_OVERRIDE_STORAGE_KEY);

    /* 后端对所有站点硬编码下发 true，因此它不足以让国际站放量。 */
    expect(resolvePaidBillingEnabled(enabledConfig, false, true)).toBe(false);

    /* 灰度开关：与国内站灰度期完全相同的 localStorage key。 */
    window.localStorage.setItem(PAID_BILLING_OVERRIDE_STORAGE_KEY, "true");
    expect(resolvePaidBillingEnabled(enabledConfig, false, true)).toBe(true);

    /* 显式关闭时，即便本地有开关也不放量（override 会先把 config 置 false）。 */
    window.localStorage.setItem(PAID_BILLING_OVERRIDE_STORAGE_KEY, "false");
    expect(
      resolvePaidBillingEnabled(
        applyRuntimeOverrides(normalizeRuntimeConfig({ features: { paidBillingEnabled: true } })),
        false,
        true,
      ),
    ).toBe(false);

    window.localStorage.removeItem(PAID_BILLING_OVERRIDE_STORAGE_KEY);
  });

  it("never enables paid billing when the runtime flag is off", () => {
    const disabledConfig = normalizeRuntimeConfig({ features: { paidBillingEnabled: false } });
    window.localStorage.setItem(PAID_BILLING_OVERRIDE_STORAGE_KEY, "true");

    /* config 为 false 时直接短路，本地开关不能绕过它。 */
    expect(resolvePaidBillingEnabled(disabledConfig, true, false)).toBe(false);
    expect(resolvePaidBillingEnabled(disabledConfig, false, true)).toBe(false);

    window.localStorage.removeItem(PAID_BILLING_OVERRIDE_STORAGE_KEY);
  });

  /**
   * 守卫重构后的关键语义：构建期兜底值是 true，
   * 若用「解析结果为 true」判断显式开启，未配置环境变量的国际站会被误判成已放量。
   * 这里通过「未设 localStorage 时国际站必须关闭」间接锁住该语义
   * （当前四个发布环境均未配置该环境变量，见 release-matrix.json）。
   */
  it("does not treat the build-time fallback as an explicit opt-in", () => {
    const enabledConfig = normalizeRuntimeConfig({ features: { paidBillingEnabled: true } });
    window.localStorage.removeItem(PAID_BILLING_OVERRIDE_STORAGE_KEY);

    expect(hasExplicitPaidBillingOptIn()).toBe(false);
    expect(resolvePaidBillingEnabled(enabledConfig, false, true)).toBe(false);
  });

  /**
   * 守卫默认参数这条真实生产路径。
   * 生产调用是 resolvePaidBillingEnabled(config, isCN)，globalSite 走默认值 isGlobal；
   * 其余用例都显式传第三参，若默认值被误改成 isCN 之类，那些用例仍会全绿。
   */
  it("derives the site from isGlobal when the third argument is omitted", () => {
    const enabledConfig = normalizeRuntimeConfig({ features: { paidBillingEnabled: true } });
    window.localStorage.removeItem(PAID_BILLING_OVERRIDE_STORAGE_KEY);

    expect(resolvePaidBillingEnabled(enabledConfig, !isGlobal)).toBe(
      resolvePaidBillingEnabled(enabledConfig, !isGlobal, isGlobal),
    );
    /* 国际站构建下默认必须关闭，国内站构建下默认必须开启。 */
    expect(resolvePaidBillingEnabled(enabledConfig, !isGlobal)).toBe(!isGlobal);
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
