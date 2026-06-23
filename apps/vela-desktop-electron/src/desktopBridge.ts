import {
  browserDesktopHostBridge,
  type DesktopHostBridge,
} from "../../../packages/vela-desktop-shell/src";

declare global {
  interface Window {
    velaDesktop?: {
      getDesktopInfo: () => Promise<DesktopInfoResponse>;
      retryDesktopBootstrap?: () => Promise<DesktopInfoResponse>;
    };
  }
}

export type DesktopInfoResponse =
  | {
      status: "ready";
      apiBaseUrl: string;
      logPath?: string;
      platform: NodeJS.Platform;
    }
  | {
      status: "failed";
      error: string;
      logPath?: string;
      platform: NodeJS.Platform;
    };

export interface DesktopHostInfo {
  apiBaseUrl: string;
  hostKind: "electron" | "web";
  logPath?: string;
  platform: NodeJS.Platform | "browser";
}

export type DesktopRuntimeBootstrap =
  | { status: "starting"; message: string }
  | { status: "ready"; info: DesktopHostInfo }
  | {
      status: "failed";
      error: string;
      logPath?: string;
      platform: NodeJS.Platform | "browser";
    };

const DEFAULT_WEB_API_BASE_URL = "/api/v1";

export async function readDesktopHostInfo(): Promise<DesktopHostInfo> {
  const bootstrap = await readDesktopRuntimeBootstrap();
  if (bootstrap.status === "ready") return bootstrap.info;
  throw new Error(bootstrap.error);
}

export async function readDesktopRuntimeBootstrap(): Promise<DesktopRuntimeBootstrap> {
  if (window.velaDesktop) {
    const info = await window.velaDesktop.getDesktopInfo();
    if (info.status === "failed") {
      return {
        status: "failed",
        error: info.error,
        logPath: info.logPath,
        platform: info.platform,
      };
    }
    return {
      status: "ready",
      info: {
        apiBaseUrl: info.apiBaseUrl,
        hostKind: "electron",
        logPath: info.logPath,
        platform: info.platform,
      },
    };
  }

  return {
    status: "ready",
    info: {
      apiBaseUrl: readWebApiBaseUrl(),
      hostKind: "web",
      platform: "browser",
    },
  };
}

export async function retryDesktopRuntimeBootstrap(): Promise<DesktopRuntimeBootstrap> {
  if (!window.velaDesktop?.retryDesktopBootstrap) {
    return readDesktopRuntimeBootstrap();
  }

  const info = await window.velaDesktop.retryDesktopBootstrap();
  if (info.status === "failed") {
    return {
      status: "failed",
      error: info.error,
      logPath: info.logPath,
      platform: info.platform,
    };
  }

  return {
    status: "ready",
    info: {
      apiBaseUrl: info.apiBaseUrl,
      hostKind: "electron",
      logPath: info.logPath,
      platform: info.platform,
    },
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
  if (fromEnv) return fromEnv;

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
      showTrafficLights: false,
      canStartWindowDrag: false,
    },
    shouldStartDrag: () => false,
    startWindowDrag: () => undefined,
  };
}
