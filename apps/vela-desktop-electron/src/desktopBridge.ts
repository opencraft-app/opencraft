import {
  browserRuntimeHostBridge,
  createWebSpeechVoiceInputHost,
  type RuntimeHostBridge,
  type RuntimeChromeSafeArea,
  type VoiceInputError,
  type VoiceInputHost,
  type VoiceInputOptions,
  type VoiceInputPermissionState,
  type VoiceInputState,
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
      selectWorkingDirectory?: () => Promise<unknown>;
      showPathInFolder?: (path: string) => Promise<unknown>;
      openWorkMonitor?: (sessionId: string) => Promise<WorkMonitorActionResponse>;
      closeWorkMonitor?: () => Promise<WorkMonitorActionResponse>;
      moveWorkMonitorBy?: (deltaX: number, deltaY: number) => Promise<WorkMonitorActionResponse>;
      startSessionDragPreview?: (
        sessionId: string,
        screenX: number,
        screenY: number,
      ) => Promise<WorkMonitorActionResponse>;
      moveSessionDragPreview?: (
        screenX: number,
        screenY: number,
      ) => Promise<WorkMonitorActionResponse>;
      endSessionDragPreview?: () => Promise<WorkMonitorActionResponse>;
      isMacosSpeechAvailable?: () => Promise<boolean>;
      startMacosSpeech?: (options?: VoiceInputOptions) => Promise<WorkMonitorActionResponse>;
      stopMacosSpeech?: () => Promise<WorkMonitorActionResponse>;
      onMacosSpeechEvent?: (listener: (event: unknown) => void) => () => void;
      onDesktopChromeStateChange?: (
        listener: (state: RuntimeChromeStateResponse) => void,
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
const electronVoiceInput = createElectronVoiceInputHost();

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

export async function closeWorkMonitor() {
  return window.velaDesktop?.closeWorkMonitor?.() ?? { accepted: false };
}

export async function moveWorkMonitorBy(deltaX: number, deltaY: number) {
  return window.velaDesktop?.moveWorkMonitorBy?.(deltaX, deltaY) ?? { accepted: false };
}

export async function startSessionDragPreview(
  sessionId: string,
  screenX: number,
  screenY: number,
) {
  return (
    window.velaDesktop?.startSessionDragPreview?.(sessionId, screenX, screenY) ?? {
      accepted: false,
    }
  );
}

export async function moveSessionDragPreview(screenX: number, screenY: number) {
  return (
    window.velaDesktop?.moveSessionDragPreview?.(screenX, screenY) ?? { accepted: false }
  );
}

export async function endSessionDragPreview() {
  return window.velaDesktop?.endSessionDragPreview?.() ?? { accepted: false };
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

export async function selectDesktopWorkingDirectory(): Promise<string | null> {
  const selected = await window.velaDesktop?.selectWorkingDirectory?.();
  if (typeof selected !== "string") return null;
  const trimmed = selected.trim();
  return trimmed ? trimmed : null;
}

export async function showDesktopPathInFolder(path: string): Promise<boolean> {
  return (await window.velaDesktop?.showPathInFolder?.(path)) === true;
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

function createElectronVoiceInputHost(): VoiceInputHost {
  const fallback = createWebSpeechVoiceInputHost();
  const partialListeners = new Set<(text: string) => void>();
  const finalListeners = new Set<(text: string) => void>();
  const stateListeners = new Set<(state: VoiceInputState) => void>();
  const errorListeners = new Set<(error: VoiceInputError) => void>();
  let activeProvider: "macos" | "fallback" | null = null;
  let state: VoiceInputState = "idle";
  let nativeUnsubscribe: (() => void) | null = null;

  const publishState = (nextState: VoiceInputState) => {
    state = nextState;
    stateListeners.forEach((listener) => listener(nextState));
  };
  const publishError = (error: VoiceInputError) => {
    errorListeners.forEach((listener) => listener(error));
  };
  const ensureNativeSubscription = () => {
    if (nativeUnsubscribe || !window.velaDesktop?.onMacosSpeechEvent) return;
    nativeUnsubscribe = window.velaDesktop.onMacosSpeechEvent((event) => {
      const parsed = parseMacosSpeechEvent(event);
      if (!parsed) return;
      if (parsed.type === "state") {
        publishState(parsed.state);
        if (parsed.state === "idle" || parsed.state === "error") activeProvider = null;
      } else if (parsed.type === "partial_transcript") {
        partialListeners.forEach((listener) => listener(parsed.text));
      } else if (parsed.type === "final_transcript") {
        finalListeners.forEach((listener) => listener(parsed.text));
      } else {
        publishError({ code: parsed.code, message: parsed.message });
      }
    });
  };
  const isNativeAvailable = async () =>
    Boolean(window.velaDesktop?.isMacosSpeechAvailable && (await window.velaDesktop.isMacosSpeechAvailable()));

  fallback.onPartialTranscript((text) => {
    if (activeProvider === "fallback") partialListeners.forEach((listener) => listener(text));
  });
  fallback.onFinalTranscript((text) => {
    if (activeProvider === "fallback") finalListeners.forEach((listener) => listener(text));
  });
  fallback.onStateChange((nextState) => {
    if (activeProvider === "fallback") publishState(nextState);
  });
  fallback.onError((error) => {
    if (activeProvider === "fallback") publishError(error);
  });

  return {
    async isAvailable() {
      return (await isNativeAvailable()) || Boolean(await fallback.isAvailable());
    },
    async requestPermission(): Promise<VoiceInputPermissionState> {
      if (await isNativeAvailable()) return "prompt";
      return fallback.requestPermission();
    },
    async start(options?: VoiceInputOptions) {
      if (await isNativeAvailable()) {
        ensureNativeSubscription();
        const response = await window.velaDesktop?.startMacosSpeech?.(options);
        if (response?.accepted) {
          activeProvider = "macos";
          return;
        }
      }
      activeProvider = "fallback";
      await fallback.start(options);
    },
    async stop() {
      if (activeProvider === "macos") {
        await window.velaDesktop?.stopMacosSpeech?.();
        return;
      }
      await fallback.stop();
    },
    onPartialTranscript(listener: (text: string) => void) {
      partialListeners.add(listener);
      return () => partialListeners.delete(listener);
    },
    onFinalTranscript(listener: (text: string) => void) {
      finalListeners.add(listener);
      return () => finalListeners.delete(listener);
    },
    onStateChange(listener: (nextState: VoiceInputState) => void) {
      listener(state);
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onError(listener: (error: VoiceInputError) => void) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
  };
}

type MacosSpeechRendererEvent =
  | { type: "state"; state: VoiceInputState }
  | { type: "partial_transcript"; text: string }
  | { type: "final_transcript"; text: string }
  | { type: "error"; code: string; message: string };

function parseMacosSpeechEvent(value: unknown): MacosSpeechRendererEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (
    event.type === "state" &&
    (event.state === "idle" ||
      event.state === "requesting-permission" ||
      event.state === "listening" ||
      event.state === "stopping" ||
      event.state === "error")
  ) {
    return { type: "state", state: event.state };
  }
  if (
    (event.type === "partial_transcript" || event.type === "final_transcript") &&
    typeof event.text === "string"
  ) {
    return { type: event.type, text: event.text };
  }
  if (event.type === "error") {
    return {
      type: "error",
      code: typeof event.code === "string" ? event.code : "macos_speech_error",
      message: typeof event.message === "string" ? event.message : "macOS speech failed.",
    };
  }
  return null;
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
    leadingToolbarInset: isMacos ? 86 : 16,
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
    leadingToolbarInset: 86,
    toolbarSize: 28,
  };
}
