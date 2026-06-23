import {
  browserDesktopHostBridge,
  type DesktopHostBridge,
} from "../../../packages/vela-desktop-shell/src";

declare global {
  interface Window {
    velaDesktop?: {
      getDesktopInfo: () => Promise<{ apiBaseUrl: string; platform: NodeJS.Platform }>;
    };
  }
}

export interface DesktopHostInfo {
  apiBaseUrl: string;
  hostKind: "electron" | "web";
  platform: NodeJS.Platform | "browser";
}

const DEFAULT_WEB_API_BASE_URL = "/api/v1";

export async function readDesktopHostInfo(): Promise<DesktopHostInfo> {
  if (window.velaDesktop) {
    const info = await window.velaDesktop.getDesktopInfo();
    return {
      apiBaseUrl: info.apiBaseUrl,
      hostKind: "electron",
      platform: info.platform,
    };
  }

  return {
    apiBaseUrl: readWebApiBaseUrl(),
    hostKind: "web",
    platform: "browser",
  };
}

export function desktopHostBridgeForInfo(info: DesktopHostInfo): DesktopHostBridge {
  if (info.hostKind === "web") {
    return browserDesktopHostBridge;
  }

  return electronDesktopHostBridge(info.platform as NodeJS.Platform);
}

function readWebApiBaseUrl() {
  const fromQuery = new URL(window.location.href).searchParams.get("api_base_url");
  if (fromQuery) return fromQuery;

  const fromEnv = import.meta.env.VITE_VELA_API_BASE_URL;
  if (fromEnv?.startsWith("/")) return fromEnv;

  return DEFAULT_WEB_API_BASE_URL;
}

function electronDesktopHostBridge(platform: NodeJS.Platform): DesktopHostBridge {
  return {
    platform:
      platform === "darwin"
        ? "macos"
        : platform === "win32"
          ? "windows"
          : platform === "linux"
            ? "linux"
            : "browser",
    chrome: {
      showTrafficLights: platform === "darwin",
      canStartWindowDrag: false,
    },
    shouldStartDrag: () => false,
    startWindowDrag: () => undefined,
  };
}
