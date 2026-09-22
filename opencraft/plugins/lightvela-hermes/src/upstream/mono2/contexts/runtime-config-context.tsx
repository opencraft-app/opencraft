// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { isLightVelaEdgeOnePreviewHostname, resolveConfiguredAuthApiBaseUrl } from "../lib/auth-api-base";
import { isCN } from "../lib/region";

export interface RuntimeFeatureFlags {
  paidBillingEnabled: boolean;
  realnamePhoneVerificationEnabled: boolean;
  zeroTokenAutomationsEnabled: boolean;
  multiBotEnabled: boolean;
  referralEnabled: boolean;
}

export interface RuntimeConfig {
  features: RuntimeFeatureFlags;
}

interface RuntimeConfigState {
  config: RuntimeConfig;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const readBooleanLike = (value: string | undefined): boolean | null => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "true" || normalized === "1" || normalized === "on") return true;
  if (normalized === "false" || normalized === "0" || normalized === "off") return false;
  return null;
};

/** 构建期付费开关的原始取值，未配置时为 undefined。 */
const readBuildTimePaidBillingRaw = (): boolean | null =>
  readBooleanLike(typeof process !== "undefined" ? process.env.NEXT_PUBLIC_PAID_BILLING_ENABLED : undefined) ??
  readBooleanLike(import.meta.env?.VITE_PAID_BILLING_ENABLED);

const readBuildTimePaidBillingDefault = (): boolean => readBuildTimePaidBillingRaw() ?? true;

const readBuildTimeZeroTokenAutomationsRaw = (): boolean | null =>
  readBooleanLike(typeof process !== "undefined" ? process.env.NEXT_PUBLIC_ZERO_TOKEN_AUTOMATIONS_ENABLED : undefined) ??
  readBooleanLike(import.meta.env?.VITE_ZERO_TOKEN_AUTOMATIONS_ENABLED);

const readBuildTimeZeroTokenAutomationsDefault = (): boolean =>
  readBuildTimeZeroTokenAutomationsRaw() ?? true;

const readBuildTimeMultiBotRaw = (): boolean | null =>
  readBooleanLike(typeof process !== "undefined" ? process.env.NEXT_PUBLIC_MULTI_BOT_ENABLED : undefined) ??
  readBooleanLike(import.meta.env?.VITE_MULTI_BOT_ENABLED);

const readBuildTimeMultiBotDefault = (): boolean => readBuildTimeMultiBotRaw() ?? true;

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  features: {
    paidBillingEnabled: readBuildTimePaidBillingDefault(),
    realnamePhoneVerificationEnabled: true,
    zeroTokenAutomationsEnabled: readBuildTimeZeroTokenAutomationsDefault(),
    multiBotEnabled: readBuildTimeMultiBotDefault(),
    referralEnabled: false,
  },
};

const PAID_BILLING_OVERRIDE_STORAGE_KEY = "lightclaw:features.paidBillingEnabled";
const REALNAME_PHONE_VERIFICATION_OVERRIDE_STORAGE_KEY = "lightclaw:features.realnamePhoneVerificationEnabled";
const ZERO_TOKEN_AUTOMATIONS_OVERRIDE_STORAGE_KEY = "lightclaw:features.zeroTokenAutomationsEnabled";

const RuntimeConfigContext = createContext<RuntimeConfigState>({
  config: DEFAULT_RUNTIME_CONFIG,
  loading: false,
  error: null,
  refresh: async () => undefined,
});

const normalizeRuntimeConfig = (payload: unknown): RuntimeConfig => {
  if (!payload || typeof payload !== "object") {
    return DEFAULT_RUNTIME_CONFIG;
  }
  const features = (payload as { features?: unknown }).features;
  if (!features || typeof features !== "object") {
    return DEFAULT_RUNTIME_CONFIG;
  }
  const zeroTokenAutomationsEnabled =
    (features as { zeroTokenAutomationsEnabled?: unknown }).zeroTokenAutomationsEnabled;
  const multiBotEnabled = (features as { multiBotEnabled?: unknown }).multiBotEnabled;
  const referralEnabled = (features as { referralEnabled?: unknown }).referralEnabled;
  return {
    features: {
      paidBillingEnabled:
        (features as { paidBillingEnabled?: unknown }).paidBillingEnabled === true,
      realnamePhoneVerificationEnabled:
        (features as { realnamePhoneVerificationEnabled?: unknown }).realnamePhoneVerificationEnabled === true,
      zeroTokenAutomationsEnabled:
        typeof zeroTokenAutomationsEnabled === "boolean"
          ? zeroTokenAutomationsEnabled
          : DEFAULT_RUNTIME_CONFIG.features.zeroTokenAutomationsEnabled,
      multiBotEnabled:
        typeof multiBotEnabled === "boolean"
          ? multiBotEnabled
          : DEFAULT_RUNTIME_CONFIG.features.multiBotEnabled,
      referralEnabled: referralEnabled === true,
    },
  };
};

const readBooleanOverride = (storageKey: string): boolean | null => {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(storageKey)?.trim().toLowerCase();
    if (!value) return null;
    return readBooleanLike(value);
  } catch {
    return null;
  }
};

const applyRuntimeOverrides = (config: RuntimeConfig): RuntimeConfig => {
  const paidBillingOverride = readBooleanOverride(PAID_BILLING_OVERRIDE_STORAGE_KEY);
  const realnamePhoneVerificationOverride = readBooleanOverride(REALNAME_PHONE_VERIFICATION_OVERRIDE_STORAGE_KEY);
  const zeroTokenAutomationsOverride = readBooleanOverride(ZERO_TOKEN_AUTOMATIONS_OVERRIDE_STORAGE_KEY);
  if (paidBillingOverride == null
    && realnamePhoneVerificationOverride == null
    && zeroTokenAutomationsOverride == null) return config;
  return {
    ...config,
    features: {
      ...config.features,
      paidBillingEnabled: paidBillingOverride ?? config.features.paidBillingEnabled,
      realnamePhoneVerificationEnabled:
        realnamePhoneVerificationOverride ?? config.features.realnamePhoneVerificationEnabled,
      zeroTokenAutomationsEnabled:
        zeroTokenAutomationsOverride === false ? false : config.features.zeroTokenAutomationsEnabled,
    },
  };
};

const shouldSkipRemoteRuntimeConfig = (): boolean => {
  if (typeof window === "undefined") return false;
  return isLightVelaEdgeOnePreviewHostname(window.location.hostname);
};

const getEdgeOnePreviewRuntimeConfig = (): RuntimeConfig =>
  applyRuntimeOverrides({
    ...DEFAULT_RUNTIME_CONFIG,
    features: {
      ...DEFAULT_RUNTIME_CONFIG.features,
      zeroTokenAutomationsEnabled: readBuildTimeZeroTokenAutomationsRaw() ?? true,
    },
  });

const fetchRuntimeConfig = async (): Promise<RuntimeConfig> => {
  if (shouldSkipRemoteRuntimeConfig()) {
    return getEdgeOnePreviewRuntimeConfig();
  }
  const baseUrl = resolveConfiguredAuthApiBaseUrl();
  if (baseUrl === null) {
    return DEFAULT_RUNTIME_CONFIG;
  }
  const response = await fetch(`${baseUrl}/v1/frontend/runtime-config`, {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`runtime config request failed: ${response.status}`);
  }
  return applyRuntimeOverrides(normalizeRuntimeConfig(await response.json()));
};

export const RuntimeConfigProvider = ({ children }: PropsWithChildren) => {
  const [config, setConfig] = useState<RuntimeConfig>(DEFAULT_RUNTIME_CONFIG);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setConfig(await fetchRuntimeConfig());
    } catch (err) {
      setConfig(applyRuntimeOverrides(DEFAULT_RUNTIME_CONFIG));
      setError(err instanceof Error ? err.message : "runtime config request failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<RuntimeConfigState>(
    () => ({ config, loading, error, refresh }),
    [config, error, loading, refresh],
  );

  return <RuntimeConfigContext value={value}>{children}</RuntimeConfigContext>;
};

export const useRuntimeConfig = () => useContext(RuntimeConfigContext);

/**
 * 付费计费总开关：国内站与国际站均已全量，口径一致——
 * 统一由后端 runtime config `features.paidBillingEnabled` 决定（后端可一键熔断），
 * 构建期环境变量默认值与 localStorage override（applyRuntimeOverrides）
 * 仍作为本地覆盖 / 紧急关闭通道，与国内站共用同一套 key。
 */
const resolvePaidBillingEnabled = (config: RuntimeConfig): boolean =>
  config.features.paidBillingEnabled === true;

const resolveRealnamePhoneVerificationEnabled = (config: RuntimeConfig, cn: boolean): boolean =>
  cn && config.features.realnamePhoneVerificationEnabled === true;

export const usePaidBillingEnabled = (): boolean => {
  const { config } = useRuntimeConfig();
  return resolvePaidBillingEnabled(config);
};

export const useRealnamePhoneVerificationEnabled = (): boolean => {
  const { config } = useRuntimeConfig();
  return resolveRealnamePhoneVerificationEnabled(config, isCN);
};

export const useZeroTokenAutomationsEnabled = (): boolean => {
  const { config } = useRuntimeConfig();
  return config.features.zeroTokenAutomationsEnabled === true;
};

const resolveMultiBotEnabled = (config: RuntimeConfig): boolean =>
  config.features.multiBotEnabled === true;

export const useMultiBotEnabled = (): boolean => {
  const { config } = useRuntimeConfig();
  return resolveMultiBotEnabled(config);
};

export const useReferralEnabled = (): boolean => {
  const { config } = useRuntimeConfig();
  return isCN && config.features.referralEnabled === true;
};

export const __runtimeConfigTestHooks = {
  DEFAULT_RUNTIME_CONFIG,
  PAID_BILLING_OVERRIDE_STORAGE_KEY,
  REALNAME_PHONE_VERIFICATION_OVERRIDE_STORAGE_KEY,
  ZERO_TOKEN_AUTOMATIONS_OVERRIDE_STORAGE_KEY,
  applyRuntimeOverrides,
  getEdgeOnePreviewRuntimeConfig,
  normalizeRuntimeConfig,
  resolvePaidBillingEnabled,
  resolveRealnamePhoneVerificationEnabled,
  resolveMultiBotEnabled,
  shouldSkipRemoteRuntimeConfig,
};
