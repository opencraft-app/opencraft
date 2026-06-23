import {
  browserDesktopHostBridge,
  type DesktopHostBridge,
  type HostChromeSafeArea,
} from "../../../packages/vela-desktop-shell/src";

declare global {
  interface Window {
    velaDesktop?: {
      getDesktopInfo: () => Promise<DesktopInfoResponse>;
      retryDesktopBootstrap?: () => Promise<DesktopInfoResponse>;
      getDesktopChromeState?: () => Promise<DesktopChromeStateResponse>;
      leaveFullscreen?: () => Promise<DesktopChromeStateResponse>;
      onDesktopChromeStateChange?: (
        listener: (state: DesktopChromeStateResponse) => void,
      ) => () => void;
    };
  }
}

export interface DesktopChromeStateResponse {
  platform: NodeJS.Platform;
  isFullscreen: boolean;
  isMaximized: boolean;
  reserveTrafficLightGutter: boolean;
  toolbarCenterY: number;
  toolbarIconSize: number;
  leadingToolbarInset: number;
  toolbarSize: number;
}

export type DesktopInfoResponse =
  | {
      status: "ready";
      apiBaseUrl: string;
      chromeState?: DesktopChromeStateResponse;
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
  chromeState?: DesktopChromeStateResponse;
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
        chromeState: info.chromeState,
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
      chromeState: browserChromeState(),
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
      chromeState: info.chromeState,
      hostKind: "electron",
      logPath: info.logPath,
      platform: info.platform,
    },
  };
}

export function desktopHostBridgeForInfo(
  info: DesktopHostInfo,
  chromeState = info.chromeState,
): DesktopHostBridge {
  if (info.hostKind === "web") {
    return {
      ...browserDesktopHostBridge,
      chrome: {
        ...browserDesktopHostBridge.chrome,
        safeArea: desktopChromeSafeArea(chromeState ?? browserChromeState()),
      },
    };
  }

  return electronDesktopHostBridge(info.platform as NodeJS.Platform, chromeState);
}

export async function readDesktopChromeState(
  fallback?: DesktopChromeStateResponse,
): Promise<DesktopChromeStateResponse> {
  if (window.velaDesktop?.getDesktopChromeState) {
    return window.velaDesktop.getDesktopChromeState();
  }
  return fallback ?? browserChromeState();
}

export function subscribeDesktopChromeState(
  listener: (state: DesktopChromeStateResponse) => void,
) {
  return window.velaDesktop?.onDesktopChromeStateChange?.(listener) ?? (() => undefined);
}

function readWebApiBaseUrl() {
  const fromQuery = new URL(window.location.href).searchParams.get("api_base_url");
  if (fromQuery) return fromQuery;

  const fromEnv = import.meta.env.VITE_VELA_API_BASE_URL;
  if (fromEnv) return fromEnv;

  return DEFAULT_WEB_API_BASE_URL;
}

function electronDesktopHostBridge(
  platform: NodeJS.Platform,
  chromeState?: DesktopChromeStateResponse,
): DesktopHostBridge {
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
      safeArea: desktopChromeSafeArea(chromeState ?? fallbackChromeState(platform)),
    },
    shouldStartDrag: () => false,
    startWindowDrag: () => undefined,
    windowControls: {
      leaveFullscreen: window.velaDesktop?.leaveFullscreen,
    },
  };
}

function desktopChromeSafeArea(state: DesktopChromeStateResponse): HostChromeSafeArea {
  return {
    isFullscreen: state.isFullscreen,
    isMaximized: state.isMaximized,
    reserveTrafficLightGutter: state.reserveTrafficLightGutter,
    toolbarCenterY: state.toolbarCenterY,
    toolbarIconSize: state.toolbarIconSize,
    leadingToolbarInset: state.leadingToolbarInset,
    toolbarSize: state.toolbarSize,
  };
}

function fallbackChromeState(platform: NodeJS.Platform): DesktopChromeStateResponse {
  const isMacos = platform === "darwin";
  return {
    platform,
    isFullscreen: false,
    isMaximized: false,
    reserveTrafficLightGutter: isMacos,
    toolbarCenterY: 28,
    toolbarIconSize: 24,
    leadingToolbarInset: isMacos ? 84 : 16,
    toolbarSize: 28,
  };
}

function browserChromeState(): DesktopChromeStateResponse {
  return {
    platform: "darwin",
    isFullscreen: false,
    isMaximized: false,
    reserveTrafficLightGutter: true,
    toolbarCenterY: 28,
    toolbarIconSize: 24,
    leadingToolbarInset: 84,
    toolbarSize: 28,
  };
}
