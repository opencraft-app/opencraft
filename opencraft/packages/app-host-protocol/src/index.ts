export const APP_HOST_PROTOCOL_VERSION = 1 as const;
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
