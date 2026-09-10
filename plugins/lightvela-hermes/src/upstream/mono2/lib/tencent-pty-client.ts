// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { deserialize } from "bson";

const DEFAULT_TAT_TERMINAL_TIMEOUT_SECONDS = 3600;
const DEFAULT_TAT_TERMINAL_USERNAME = "agentuser";
const DEFAULT_TAT_TERMINAL_WORKING_DIRECTORY = "/home/agentuser";
const DEFAULT_PTY_START_DELAY_MS = 1000;

export type TencentPtyConnectionState = "idle" | "connecting" | "authenticating" | "starting" | "ready" | "closed" | "error";

export interface TencentPtyBootstrap {
  sessionId: string;
  ownerUin: string;
  appId: number;
  instanceId: string;
  wsUrl: string;
  cols: number;
  rows: number;
  timeoutSeconds?: number;
  username?: string;
  workingDirectory?: string;
}

export interface TencentPtyDimensions {
  cols: number;
  rows: number;
}

export interface TencentPtyClientHandlers {
  onStateChange?: (state: TencentPtyConnectionState) => void;
  onReady?: () => void;
  onOutput?: (output: string) => void;
  onError?: (message: string) => void;
  onDecodeError?: (error: unknown) => void;
  onClose?: (event: CloseEvent) => void;
}

export interface TencentPtyClientOptions extends TencentPtyClientHandlers {
  getDimensions?: () => Partial<TencentPtyDimensions> | null | undefined;
  startDelayMs?: number;
  WebSocketImpl?: new (url: string | URL, protocols?: string | string[]) => WebSocket;
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
};

const decodeBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const encodeBase64 = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

export const decodeTencentPtyFrame = async (frame: string | Blob | ArrayBuffer): Promise<unknown> => {
  if (typeof frame === "string") {
    return JSON.parse(frame);
  }

  if (frame instanceof Blob) {
    return decodeTencentPtyFrame(await frame.arrayBuffer());
  }

  const bytes = new Uint8Array(frame);
  try {
    return deserialize(bytes);
  } catch {
    return JSON.parse(new TextDecoder().decode(bytes));
  }
};

export const extractTencentPtyOutput = (message: unknown): string => {
  const payload = asRecord(asRecord(message)?.Data);
  if (!payload) {
    return "";
  }

  const candidates = [payload.Output, payload.Data, asRecord(payload.Data)?.Output, asRecord(payload.Data)?.Data];

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      try {
        return decodeBase64(candidate);
      } catch {
        return candidate;
      }
    }
    if (candidate instanceof Uint8Array) {
      return new TextDecoder().decode(candidate);
    }
    if (candidate instanceof ArrayBuffer) {
      return new TextDecoder().decode(candidate);
    }
  }

  return "";
};

export const extractTencentPtyError = (message: unknown): string => {
  const root = asRecord(message);
  const payload = asRecord(root?.Data);
  const candidates = [
    payload?.Message,
    payload?.ErrMsg,
    payload?.Error,
    payload?.ErrorMessage,
    payload?.Reason,
    root?.Message,
    root?.ErrMsg,
    root?.Error,
    root?.ErrorMessage,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "terminal error";
};

const getFrameType = (message: unknown) => {
  const frameType = asRecord(message)?.Type;
  return typeof frameType === "string" ? frameType : "";
};

const normalizeDimension = (value: unknown, fallback: number) => {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
};

export class TencentPtyClient {
  private socket: WebSocket | null = null;
  private startTimer: number | null = null;
  private state: TencentPtyConnectionState = "idle";
  private dimensions: TencentPtyDimensions;

  private readonly startDelayMs: number;
  private readonly WebSocketImpl: new (url: string | URL, protocols?: string | string[]) => WebSocket;

  constructor(
    private readonly bootstrap: TencentPtyBootstrap,
    private readonly options: TencentPtyClientOptions = {},
  ) {
    this.dimensions = { cols: bootstrap.cols, rows: bootstrap.rows };
    this.startDelayMs = options.startDelayMs ?? DEFAULT_PTY_START_DELAY_MS;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  }

  connect() {
    if (this.socket) {
      return;
    }

    this.setState("connecting");
    const socket = new this.WebSocketImpl(this.bootstrap.wsUrl);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => {
      this.setState("authenticating");
      this.sendFrame({
        Type: "SessionAuth",
        Data: {
          Uin: this.bootstrap.ownerUin,
          AppId: this.bootstrap.appId,
          InstanceId: this.bootstrap.instanceId,
          SessionId: this.bootstrap.sessionId,
        },
      });

      this.startTimer = window.setTimeout(() => {
        this.startTimer = null;
        this.startPty();
      }, this.startDelayMs);
    };

    socket.onmessage = (event) => {
      void this.handleMessage(event.data);
    };

    socket.onerror = () => {
      this.setState("error");
      this.options.onError?.("websocket error");
    };

    socket.onclose = (event) => {
      this.clearStartTimer();
      this.socket = null;
      if (this.state !== "error") {
        this.setState("closed");
      }
      this.options.onClose?.(event);
    };
  }

  sendInput(input: string) {
    if (this.state !== "ready") {
      return false;
    }

    return this.sendFrame({
      Type: "PtyInput",
      Data: {
        SessionId: this.bootstrap.sessionId,
        Input: encodeBase64(input),
      },
    });
  }

  resize(cols: number, rows: number) {
    this.dimensions = {
      cols: normalizeDimension(cols, this.dimensions.cols),
      rows: normalizeDimension(rows, this.dimensions.rows),
    };

    if (this.state !== "ready") {
      return false;
    }

    return this.sendFrame({
      Type: "PtyResize",
      Data: {
        SessionId: this.bootstrap.sessionId,
        Cols: this.dimensions.cols,
        Rows: this.dimensions.rows,
      },
    });
  }

  close() {
    this.clearStartTimer();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendFrame({ Type: "PtyStop", Data: { SessionId: this.bootstrap.sessionId } });
    }
    this.socket?.close();
    this.socket = null;
  }

  private startPty() {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.refreshDimensions();
    this.setState("starting");
    this.sendFrame({
      Type: "PtyStart",
      Data: {
        SessionId: this.bootstrap.sessionId,
        Cols: this.dimensions.cols,
        Rows: this.dimensions.rows,
        MaxIdleTime: this.bootstrap.timeoutSeconds ?? DEFAULT_TAT_TERMINAL_TIMEOUT_SECONDS,
        UserName: this.bootstrap.username?.trim() || DEFAULT_TAT_TERMINAL_USERNAME,
        WorkingDirectory: this.bootstrap.workingDirectory?.trim() || DEFAULT_TAT_TERMINAL_WORKING_DIRECTORY,
      },
    });
  }

  private async handleMessage(data: string | Blob | ArrayBuffer) {
    try {
      const message = await decodeTencentPtyFrame(data);
      switch (getFrameType(message)) {
        case "PtyReady":
          this.setState("ready");
          this.options.onReady?.();
          return;
        case "PtyOutput": {
          const output = extractTencentPtyOutput(message);
          if (output) {
            this.options.onOutput?.(output);
          }
          return;
        }
        case "PtyError":
        case "Error": {
          const messageText = extractTencentPtyError(message);
          this.setState("error");
          this.options.onError?.(messageText);
          return;
        }
        default: {
          const output = extractTencentPtyOutput(message);
          if (output) {
            this.options.onOutput?.(output);
          }
        }
      }
    } catch (error) {
      this.options.onDecodeError?.(error);
    }
  }

  private refreshDimensions() {
    const dimensions = this.options.getDimensions?.();
    this.dimensions = {
      cols: normalizeDimension(dimensions?.cols, this.dimensions.cols),
      rows: normalizeDimension(dimensions?.rows, this.dimensions.rows),
    };
  }

  private sendFrame(frame: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  private clearStartTimer() {
    if (this.startTimer === null) {
      return;
    }
    window.clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private setState(state: TencentPtyConnectionState) {
    this.state = state;
    this.options.onStateChange?.(state);
  }
}
