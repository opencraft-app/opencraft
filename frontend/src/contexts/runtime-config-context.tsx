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
import { isCN } from "@/lib/region";

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

const readBuildTimePaidBillingDefault = (): boolean =>
  readBooleanLike(typeof process !== "undefined" ? process.env.NEXT_PUBLIC_PAID_BILLING_ENABLED : undefined) ??
  readBooleanLike(import.meta.env?.VITE_PAID_BILLING_ENABLED) ??
  false;

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  features: {
    paidBillingEnabled: readBuildTimePaidBillingDefault(),
    realnamePhoneVerificationEnabled: false,
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

const resolvePaidBillingEnabled = (config: RuntimeConfig, _cn: boolean): boolean =>
  config.features.paidBillingEnabled === true;

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
  normalizeRuntimeConfig,
  resolvePaidBillingEnabled,
  resolveRealnamePhoneVerificationEnabled,
  shouldSkipRemoteRuntimeConfig,
};
