export const LOCAL_VELAD_BASE_URL = "http://127.0.0.1:3857/api/v1";
export const VELALINK_DEMO_PROXY_BASE_URL = "/chat/api/velad/api/v1";

export interface WorkbenchVeladEndpointEnv {
  NEXT_PUBLIC_VELA_VELAD_BASE_URL?: string;
}

const normalizeConfiguredBaseUrl = (value: string) => value.trim().replace(/\/+$/, "");

export function isVelalinkDemoProxyBaseUrl(value: string) {
  return normalizeConfiguredBaseUrl(value) === VELALINK_DEMO_PROXY_BASE_URL;
}

export function resolveInitialVeladBaseUrl(
  env: WorkbenchVeladEndpointEnv = process.env,
) {
  const configured = env.NEXT_PUBLIC_VELA_VELAD_BASE_URL?.trim();
  if (!configured || isVelalinkDemoProxyBaseUrl(configured)) {
    return "";
  }
  return normalizeConfiguredBaseUrl(configured);
}

export function isUsableVeladBaseUrl(value: string) {
  const baseUrl = value.trim();
  return Boolean(baseUrl) && !isVelalinkDemoProxyBaseUrl(baseUrl);
}
