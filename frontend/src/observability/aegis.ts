import { REGION, type Region } from "@/lib/region";

type AegisEnv = {
  readonly PROD?: boolean | string;
  readonly NODE_ENV?: string;
  readonly NEXT_PUBLIC_AEGIS_ENABLED?: string;
  readonly NEXT_PUBLIC_AEGIS_ID?: string;
  readonly NEXT_PUBLIC_AEGIS_HOST_URL?: string;
  readonly VITE_AEGIS_ENABLED?: string;
  readonly VITE_AEGIS_ID?: string;
  readonly VITE_AEGIS_HOST_URL?: string;
};

type AegisInitOptions = {
  id: string;
  uin?: string;
  reportApiSpeed: boolean;
  reportAssetSpeed: boolean;
  spa: boolean;
  hostUrl: string;
};

type AegisInstance = {
  setConfig?: (config: { uin?: string }) => void;
};

type AegisConstructor = new (options: AegisInitOptions) => AegisInstance;
type AegisModule = { default: AegisConstructor };

export type AegisConfig = {
  id: string;
  hostUrl: string;
  region: Region;
};

let aegis: AegisInstance | null = null;
let initPromise: Promise<AegisInstance | null> | null = null;
let pendingUin: string | undefined;

const isTruthy = (value: boolean | string | undefined): boolean => {
  if (typeof value === "boolean") return value;
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
};

const readImportMetaEnv = (): AegisEnv => {
  try {
    return (import.meta.env as AegisEnv | undefined) ?? {};
  } catch {
    return {};
  }
};

const readAegisEnv = (): AegisEnv => ({
  ...readImportMetaEnv(),
  NEXT_PUBLIC_AEGIS_ENABLED: typeof process !== "undefined" ? process.env.NEXT_PUBLIC_AEGIS_ENABLED : undefined,
  NEXT_PUBLIC_AEGIS_ID: typeof process !== "undefined" ? process.env.NEXT_PUBLIC_AEGIS_ID : undefined,
  NEXT_PUBLIC_AEGIS_HOST_URL: typeof process !== "undefined" ? process.env.NEXT_PUBLIC_AEGIS_HOST_URL : undefined,
  NODE_ENV: typeof process !== "undefined" ? process.env.NODE_ENV : undefined,
});

const envValue = (
  env: AegisEnv,
  nextKey: keyof AegisEnv,
  viteKey: keyof AegisEnv,
): string | undefined => {
  const nextValue = env[nextKey];
  if (typeof nextValue === "string" && nextValue.trim()) return nextValue;
  const viteValue = env[viteKey];
  return typeof viteValue === "string" ? viteValue : undefined;
};

export function resolveAegisConfig(
  env: AegisEnv | null | undefined = readAegisEnv(),
  region: Region = REGION,
): AegisConfig | null {
  const runtimeEnv = env ?? {};
  const isProduction = isTruthy(runtimeEnv.PROD) || runtimeEnv.NODE_ENV === "production";
  const enabled = envValue(runtimeEnv, "NEXT_PUBLIC_AEGIS_ENABLED", "VITE_AEGIS_ENABLED")?.trim().toLowerCase() ?? "auto";
  if (!isProduction || enabled === "false" || enabled === "0") {
    return null;
  }

  const id = envValue(runtimeEnv, "NEXT_PUBLIC_AEGIS_ID", "VITE_AEGIS_ID")?.trim() ?? "";
  const hostUrl = envValue(runtimeEnv, "NEXT_PUBLIC_AEGIS_HOST_URL", "VITE_AEGIS_HOST_URL")?.trim() ?? "";
  if (!id || !hostUrl) {
    return null;
  }

  return {
    id,
    hostUrl,
    region,
  };
}

export async function initAegis(
  env: AegisEnv | null | undefined = readAegisEnv(),
  region: Region = REGION,
): Promise<AegisInstance | null> {
  if (aegis) return aegis;
  if (initPromise) return initPromise;

  const config = resolveAegisConfig(env, region);
  if (!config) return null;

  initPromise = import("aegis-web-sdk")
    .then((sdk: AegisModule) => {
      aegis = new sdk.default({
        id: config.id,
        hostUrl: config.hostUrl,
        reportApiSpeed: true,
        reportAssetSpeed: true,
        spa: true,
      });
      aegis.setConfig?.({ uin: pendingUin });
      return aegis;
    })
    .catch((error: unknown) => {
      console.warn("Failed to initialize Aegis RUM", error);
      initPromise = null;
      return null;
    });

  return initPromise;
}

export function setAegisUser(uin: string | null | undefined) {
  pendingUin = uin || undefined;
  aegis?.setConfig?.({ uin: pendingUin });
}

export function resetAegisForTest() {
  aegis = null;
  initPromise = null;
  pendingUin = undefined;
}
