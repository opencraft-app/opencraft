import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
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

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  features: {
    paidBillingEnabled: false,
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
    if (value === "true" || value === "1" || value === "on") return true;
    if (value === "false" || value === "0" || value === "off") return false;
    return null;
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

const fetchRuntimeConfig = async (): Promise<RuntimeConfig> => {
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

const resolvePaidBillingEnabled = (config: RuntimeConfig, cn: boolean): boolean =>
  cn && config.features.paidBillingEnabled === true;

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
};
