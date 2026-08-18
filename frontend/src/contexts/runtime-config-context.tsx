import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { isLightVelaEdgeOnePreviewHostname, resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { isCN, isGlobal } from "@/lib/region";

export interface RuntimeFeatureFlags {
  paidBillingEnabled: boolean;
  realnamePhoneVerificationEnabled: boolean;
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

/** 构建期是否被显式配置为开启（区别于兜底 true）。 */
const hasExplicitBuildTimePaidBilling = (): boolean => readBuildTimePaidBillingRaw() === true;

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  features: {
    paidBillingEnabled: readBuildTimePaidBillingDefault(),
    realnamePhoneVerificationEnabled: true,
  },
};

const PAID_BILLING_OVERRIDE_STORAGE_KEY = "lightclaw:features.paidBillingEnabled";
const REALNAME_PHONE_VERIFICATION_OVERRIDE_STORAGE_KEY = "lightclaw:features.realnamePhoneVerificationEnabled";

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
  return {
    features: {
      paidBillingEnabled:
        (features as { paidBillingEnabled?: unknown }).paidBillingEnabled === true,
      realnamePhoneVerificationEnabled:
        (features as { realnamePhoneVerificationEnabled?: unknown }).realnamePhoneVerificationEnabled === true,
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
  if (paidBillingOverride == null && realnamePhoneVerificationOverride == null) return config;
  return {
    ...config,
    features: {
      ...config.features,
      paidBillingEnabled: paidBillingOverride ?? config.features.paidBillingEnabled,
      realnamePhoneVerificationEnabled:
        realnamePhoneVerificationOverride ?? config.features.realnamePhoneVerificationEnabled,
    },
  };
};

const shouldSkipRemoteRuntimeConfig = (): boolean => {
  if (typeof window === "undefined") return false;
  return isLightVelaEdgeOnePreviewHostname(window.location.hostname);
};

const fetchRuntimeConfig = async (): Promise<RuntimeConfig> => {
  if (shouldSkipRemoteRuntimeConfig()) {
    return applyRuntimeOverrides(DEFAULT_RUNTIME_CONFIG);
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
 * 国际站计费灰度：沿用国内站当初那套 localStorage 开关模式。
 *
 * 背景：后端 `/v1/frontend/runtime-config` 目前对所有站点硬编码下发
 * `paidBillingEnabled: true`（见 ctl/main/api/server.go），因此后端下发值
 * 不足以作为国际站的放量信号；国际站必须有一次「显式开启」才展示真实计费。
 *
 * 打开方式（与国内站灰度期一致）：
 *   localStorage.setItem("lightclaw:features.paidBillingEnabled", "true")
 *   location.reload()
 *
 * 注意这里要重新读一次 localStorage 而不是复用 config.features：
 * `applyRuntimeOverrides` 已经把 override 合并进 config，合并后就分不清
 * 「true 来自后端全量下发」还是「true 来自本地显式开启」，而这恰恰是灰度的判据。
 */
const hasExplicitPaidBillingOptIn = (): boolean =>
  readBooleanOverride(PAID_BILLING_OVERRIDE_STORAGE_KEY) === true ||
  /* 复用构建期读取逻辑：它已处理 process / import.meta 两种来源。
     注意它的兜底值是 true，因此这里必须用「显式配置过」而非「解析结果为 true」来判断，
     否则未配置环境变量时会被兜底值误判成已开启，灰度直接失效。 */
  hasExplicitBuildTimePaidBilling();

const resolvePaidBillingEnabled = (
  config: RuntimeConfig,
  _cn: boolean,
  /** 注入而非直接读模块常量，便于测试覆盖两个站点分支。 */
  globalSite: boolean = isGlobal,
): boolean => {
  if (config.features.paidBillingEnabled !== true) return false;
  /* 国内站已全量，保持现状；国际站仍在灰度，需显式开启。 */
  if (globalSite) return hasExplicitPaidBillingOptIn();
  return true;
};

const resolveRealnamePhoneVerificationEnabled = (config: RuntimeConfig, cn: boolean): boolean =>
  cn && config.features.realnamePhoneVerificationEnabled === true;

export const usePaidBillingEnabled = (): boolean => {
  const { config } = useRuntimeConfig();
  return resolvePaidBillingEnabled(config, isCN);
};

export const useRealnamePhoneVerificationEnabled = (): boolean => {
  const { config } = useRuntimeConfig();
  return resolveRealnamePhoneVerificationEnabled(config, isCN);
};

export const __runtimeConfigTestHooks = {
  DEFAULT_RUNTIME_CONFIG,
  PAID_BILLING_OVERRIDE_STORAGE_KEY,
  REALNAME_PHONE_VERIFICATION_OVERRIDE_STORAGE_KEY,
  applyRuntimeOverrides,
  hasExplicitPaidBillingOptIn,
  normalizeRuntimeConfig,
  resolvePaidBillingEnabled,
  resolveRealnamePhoneVerificationEnabled,
  shouldSkipRemoteRuntimeConfig,
};
