import type {
  BrowserAutomationInspection,
  BrowserAutomationPageContext,
} from "@opencraft/browser-core";

export const PREVIEW_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const PREVIEW_BRIDGE_SOURCE = "vela-preview-bridge" as const;

export type PreviewBridgeMethod =
  | "read-context"
  | "inspect"
  | "click"
  | "fill"
  | "press"
  | "scroll"
  | "wait";

export interface PreviewBridgeIdentity {
  readonly source: typeof PREVIEW_BRIDGE_SOURCE;
  readonly protocolVersion: typeof PREVIEW_BRIDGE_PROTOCOL_VERSION;
  readonly previewId: string;
  readonly generation: number;
  readonly nonce: string;
}

export type PreviewBridgeParentMessage = PreviewBridgeIdentity & (
  | { readonly type: "platform:connect" }
  | {
      readonly type: "platform:call";
      readonly callId: string;
      readonly method: PreviewBridgeMethod;
      readonly params: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "platform:cancel"; readonly callId: string }
);

export type PreviewBridgeChildMessage = PreviewBridgeIdentity & (
  | {
      readonly type: "preview:ready";
      readonly capabilities: {
        readonly domInspection: true;
        readonly semanticInput: true;
        readonly trustedInput: false;
        readonly networkObservation: "fetch-xhr";
      };
    }
  | {
      readonly type: "preview:call-result";
      readonly callId: string;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly type: "preview:call-result";
      readonly callId: string;
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean };
    }
  | { readonly type: "preview:document-updated"; readonly revision: number }
  | { readonly type: "preview:url-changed"; readonly url: string; readonly title: string }
  | { readonly type: "preview:error"; readonly message: string }
);

export interface PreviewBridgeCallMap {
  readonly "read-context": {
    readonly params: { readonly includeSelection?: boolean; readonly maxInlineChars?: number };
    readonly result: BrowserAutomationPageContext;
  };
  readonly inspect: {
    readonly params: Readonly<Record<string, never>>;
    readonly result: BrowserAutomationInspection;
  };
  readonly click: {
    readonly params: { readonly ref: string; readonly expectedRevision: number };
    readonly result: null;
  };
  readonly fill: {
    readonly params: { readonly ref: string; readonly expectedRevision: number; readonly value: string };
    readonly result: null;
  };
  readonly press: { readonly params: { readonly key: string }; readonly result: null };
  readonly scroll: { readonly params: { readonly x: number; readonly y: number }; readonly result: null };
  readonly wait: {
    readonly params: { readonly text: string; readonly timeoutMs: number };
    readonly result: null;
  };
}

export function isPreviewBridgeChildMessage(value: unknown): value is PreviewBridgeChildMessage {
  if (value === null || typeof value !== "object") return false;
  const row = value as Partial<PreviewBridgeChildMessage>;
  return row.source === PREVIEW_BRIDGE_SOURCE &&
    row.protocolVersion === PREVIEW_BRIDGE_PROTOCOL_VERSION &&
    typeof row.previewId === "string" &&
    typeof row.generation === "number" &&
    typeof row.nonce === "string" &&
    typeof row.type === "string";
}

export function isPreviewBridgeParentMessage(value: unknown): value is PreviewBridgeParentMessage {
  if (value === null || typeof value !== "object") return false;
  const row = value as Partial<PreviewBridgeParentMessage>;
  return row.source === PREVIEW_BRIDGE_SOURCE &&
    row.protocolVersion === PREVIEW_BRIDGE_PROTOCOL_VERSION &&
    typeof row.previewId === "string" &&
    typeof row.generation === "number" &&
    typeof row.nonce === "string" &&
    typeof row.type === "string";
}
