import {
  browserRuntimeHostBridge,
  createWebSpeechVoiceInputHost,
  type RuntimeHostBridge,
  type RuntimeChromeSafeArea,
} from "../../../packages/vela-desktop-shell/src";
import type { BackendKindWire } from "../../../packages/vela-chat-client/src";

declare global {
  interface Window {
    velaDesktop?: {
      getDesktopInfo: () => Promise<RuntimeInfoResponse>;
      retryDesktopBootstrap?: () => Promise<RuntimeInfoResponse>;
      getDesktopSettings?: () => Promise<DesktopSettings>;
      setDesktopSettings?: (patch: Partial<DesktopSettings>) => Promise<DesktopSettings>;
      getDesktopChromeState?: () => Promise<RuntimeChromeStateResponse>;
      leaveFullscreen?: () => Promise<RuntimeChromeStateResponse>;
      openWorkMonitor?: (sessionId: string) => Promise<WorkMonitorActionResponse>;
      hideWorkMonitor?: () => Promise<WorkMonitorActionResponse>;
      moveWorkMonitorBy?: (deltaX: number, deltaY: number) => Promise<WorkMonitorActionResponse>;
      focusDesktopSession?: (sessionId: string) => Promise<WorkMonitorActionResponse>;
      onDesktopChromeStateChange?: (
        listener: (state: RuntimeChromeStateResponse) => void,
      ) => () => void;
      onOpenDesktopSession?: (
        listener: (sessionId: unknown) => void,
      ) => () => void;
    };
  }
}

export interface RuntimeChromeStateResponse {
  platform: NodeJS.Platform;
  isFullscreen: boolean;
  isMaximized: boolean;
  reserveTrafficLightGutter: boolean;
  toolbarCenterY: number;
  toolbarIconSize: number;
  leadingToolbarInset: number;
  toolbarSize: number;
}

export type RuntimeInfoResponse =
  | {
      status: "ready";
      apiBaseUrl: string;
      otelBaseUrl?: string;
      chromeState?: RuntimeChromeStateResponse;
      logPath?: string;
      platform: NodeJS.Platform;
    }
  | {
      status: "failed";
      error: string;
      logPath?: string;
      platform: NodeJS.Platform;
    };

/** @deprecated Use RuntimeInfoResponse. */
export type DesktopInfoResponse = RuntimeInfoResponse;

export interface RuntimeHostInfo {
  apiBaseUrl: string;
  otelBaseUrl?: string;
  chromeState?: RuntimeChromeStateResponse;
  hostKind: "electron" | "web";
  logPath?: string;
  platform: NodeJS.Platform | "web";
}

export interface WorkMonitorActionResponse {
  accepted: boolean;
}

export interface DesktopSettings {
  defaultBackend: BackendKindWire | "";
}

export type RuntimeBootstrap =
  | { status: "starting"; message: string }
  | { status: "ready"; info: RuntimeHostInfo }
  | {
      status: "failed";
      error: string;
      logPath?: string;
      platform: NodeJS.Platform | "web";
    };

const DEFAULT_WEB_API_BASE_URL = "/api/v1";
const electronVoiceInput = createWebSpeechVoiceInputHost();

export async function readRuntimeHostInfo(): Promise<RuntimeHostInfo> {
  const bootstrap = await readRuntimeBootstrap();
  if (bootstrap.status === "ready") return bootstrap.info;
  throw new Error(bootstrap.error);
}

export async function readRuntimeBootstrap(): Promise<RuntimeBootstrap> {
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
        otelBaseUrl: info.otelBaseUrl,
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
      otelBaseUrl: readWebOtelBaseUrl(),
      chromeState: browserChromeState(),
      hostKind: "web",
      platform: "web",
    },
  };
}

export async function retryRuntimeBootstrap(): Promise<RuntimeBootstrap> {
  if (!window.velaDesktop?.retryDesktopBootstrap) {
    return readRuntimeBootstrap();
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
      otelBaseUrl: info.otelBaseUrl,
      chromeState: info.chromeState,
      hostKind: "electron",
      logPath: info.logPath,
      platform: info.platform,
    },
  };
}

export function runtimeHostBridgeForInfo(
  info: RuntimeHostInfo,
  chromeState = info.chromeState,
): RuntimeHostBridge {
  if (info.hostKind === "web") {
    return {
      ...browserRuntimeHostBridge,
      chrome: {
        ...browserRuntimeHostBridge.chrome,
        safeArea: runtimeChromeSafeArea(chromeState ?? browserChromeState()),
      },
    };
  }

  return electronRuntimeHostBridge(info.platform as NodeJS.Platform, chromeState);
}

export async function readRuntimeChromeState(
  fallback?: RuntimeChromeStateResponse,
): Promise<RuntimeChromeStateResponse> {
  if (window.velaDesktop?.getDesktopChromeState) {
    return window.velaDesktop.getDesktopChromeState();
  }
  return fallback ?? browserChromeState();
}

export function subscribeRuntimeChromeState(
  listener: (state: RuntimeChromeStateResponse) => void,
) {
  return window.velaDesktop?.onDesktopChromeStateChange?.(listener) ?? (() => undefined);
}

export async function openWorkMonitor(sessionId: string) {
  return window.velaDesktop?.openWorkMonitor?.(sessionId) ?? { accepted: false };
}

export async function hideWorkMonitor() {
  return window.velaDesktop?.hideWorkMonitor?.() ?? { accepted: false };
}

export async function moveWorkMonitorBy(deltaX: number, deltaY: number) {
  return window.velaDesktop?.moveWorkMonitorBy?.(deltaX, deltaY) ?? { accepted: false };
}

export async function focusDesktopSession(sessionId: string) {
  return window.velaDesktop?.focusDesktopSession?.(sessionId) ?? { accepted: false };
}

export async function readDesktopSettings(): Promise<DesktopSettings> {
  return (
    (await window.velaDesktop?.getDesktopSettings?.()) ?? {
      defaultBackend: "",
    }
  );
}

export async function saveDesktopSettings(patch: Partial<DesktopSettings>) {
  if (!window.velaDesktop?.setDesktopSettings) {
    return { defaultBackend: patch.defaultBackend ?? "" };
  }
  return window.velaDesktop.setDesktopSettings(patch);
}

export function subscribeOpenDesktopSession(listener: (sessionId: string) => void) {
  return (
    window.velaDesktop?.onOpenDesktopSession?.((sessionId) => {
      if (typeof sessionId === "string" && sessionId.trim()) {
        listener(sessionId.trim());
      }
    }) ?? (() => undefined)
  );
}

function readWebApiBaseUrl() {
  const fromQuery = new URL(window.location.href).searchParams.get("api_base_url");
  if (fromQuery) return fromQuery;

  const fromEnv = import.meta.env.VITE_VELA_API_BASE_URL;
  if (fromEnv) return fromEnv;

  return DEFAULT_WEB_API_BASE_URL;
}

function readWebOtelBaseUrl() {
  const fromQuery = new URL(window.location.href).searchParams.get("otel_base_url");
  if (fromQuery) return fromQuery;

  const fromEnv = import.meta.env.VITE_VELA_OTEL_BASE_URL;
  if (fromEnv) return fromEnv;

  return undefined;
}

function electronRuntimeHostBridge(
  platform: NodeJS.Platform,
  chromeState?: RuntimeChromeStateResponse,
): RuntimeHostBridge {
  return {
    platform:
      platform === "darwin"
        ? "macos"
        : platform === "win32"
          ? "windows"
          : platform === "linux"
            ? "linux"
            : "web",
    chrome: {
      showTrafficLights: false,
      canStartWindowDrag: false,
      safeArea: runtimeChromeSafeArea(chromeState ?? fallbackChromeState(platform)),
    },
    voiceInput: electronVoiceInput,
    shouldStartDrag: () => false,
    startWindowDrag: () => undefined,
    ...(window.velaDesktop?.leaveFullscreen
      ? {
          windowControls: {
            leaveFullscreen: async () => {
              await window.velaDesktop?.leaveFullscreen?.();
            },
          },
        }
      : {}),
  };
}

function runtimeChromeSafeArea(state: RuntimeChromeStateResponse): RuntimeChromeSafeArea {
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

function fallbackChromeState(platform: NodeJS.Platform): RuntimeChromeStateResponse {
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

function browserChromeState(): RuntimeChromeStateResponse {
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
