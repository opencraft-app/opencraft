import { REGION, type Region } from "@/lib/region";

type AegisEnv = {
  readonly PROD?: boolean;
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

export function resolveAegisConfig(
  env: AegisEnv | null | undefined = import.meta.env as AegisEnv | undefined,
  region: Region = REGION,
): AegisConfig | null {
  const runtimeEnv = env ?? {};
  const enabled = runtimeEnv.VITE_AEGIS_ENABLED?.trim().toLowerCase() ?? "auto";
  if (!runtimeEnv.PROD || enabled === "false" || enabled === "0") {
    return null;
  }

  const id = runtimeEnv.VITE_AEGIS_ID?.trim() ?? "";
  const hostUrl = runtimeEnv.VITE_AEGIS_HOST_URL?.trim() ?? "";
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
  env: AegisEnv | null | undefined = import.meta.env as AegisEnv | undefined,
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
