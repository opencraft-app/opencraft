export const APP_HOST_PROTOCOL_VERSION = 1 as const;
export const LOGICAL_CLIENT_FIELD = "__opencraftClient";
export function stampLogicalClientFrame(frame: string, clientId: string): string {
  const value = JSON.parse(frame);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid logical RPC frame");
  return JSON.stringify({ ...value, [LOGICAL_CLIENT_FIELD]: clientId });
}
export function routeLogicalClientFrame(frame: string, clientIds: readonly string[]): string | null {
  const value = JSON.parse(frame);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid logical RPC frame");
  const target = value[LOGICAL_CLIENT_FIELD];
  if (target === undefined) return frame;
  if (typeof target !== "string" || !clientIds.includes(target)) return null;
  delete value[LOGICAL_CLIENT_FIELD]; return JSON.stringify(value);
}
export const CONNECT_APP_HOST_MESSAGE = "vela:connect-app-host" as const;

export type AppHostTransportState =
  | "idle"
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | "failed";

export interface AppHostErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ConnectAppHostMessage {
  readonly type: typeof CONNECT_APP_HOST_MESSAGE;
  readonly protocolVersion: typeof APP_HOST_PROTOCOL_VERSION;
  readonly rendererId: string;
}

export type RendererToAppHostMessage =
  | {
      readonly type: "hello";
      readonly protocolVersion: typeof APP_HOST_PROTOCOL_VERSION;
      readonly rendererId: string;
    }
  | {
      readonly type: "host/connect";
      readonly requestId: string;
      readonly hostId: string;
      readonly leaseId: string;
    }
  | {
      readonly type: "host/send";
      readonly requestId: string;
      readonly hostId: string;
      readonly leaseId: string;
      readonly generation: number;
      readonly frame: string;
    }
  | {
      readonly type: "host/disconnect";
      readonly requestId: string;
      readonly hostId: string;
      readonly leaseId: string;
      readonly generation: number;
    };

export type AppHostToRendererMessage =
  | {
      readonly type: "ready";
      readonly protocolVersion: typeof APP_HOST_PROTOCOL_VERSION;
      readonly connectionId: string;
      readonly services: readonly ["appserver"];
    }
  | {
      readonly type: "fatal";
      readonly error: AppHostErrorPayload;
    }
  | {
      readonly type: "response";
      readonly requestId: string;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly type: "response";
      readonly requestId: string;
      readonly ok: false;
      readonly error: AppHostErrorPayload;
    }
  | {
      readonly type: "host/status";
      readonly hostId: string;
      readonly generation: number;
      readonly status: {
        readonly state: AppHostTransportState;
        readonly reason?: string;
      };
    }
  | {
      readonly type: "host/frame";
      readonly hostId: string;
      readonly generation: number;
      readonly frame: string;
    };

export interface AppHostConnectResult {
  readonly hostId: string;
  readonly generation: number;
}

export function isConnectAppHostMessage(value: unknown): value is ConnectAppHostMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === CONNECT_APP_HOST_MESSAGE
    && record.protocolVersion === APP_HOST_PROTOCOL_VERSION
    && typeof record.rendererId === "string"
    && record.rendererId.length > 0;
}
export * from "./native-speech.js";
