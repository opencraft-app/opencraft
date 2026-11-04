import type { ChatDocumentDialect, ChatDocumentNode } from "@opencraft/chat-document";
import type { ComponentType, ReactNode } from "react";
import type { ChatFadeTimeline } from "./fade-timeline";

export type ChatRenderTheme = "light" | "dark";
export type ChatExternalResourcePolicy = "allow" | "restricted";

export interface ChatResourceOpenIntent {
  /** Semantic destination. The product shell chooses the concrete surface. */
  readonly target: "default" | "in-app-browser" | "external-browser";
  readonly disposition: "current-tab" | "new-tab";
  readonly source: "keyboard" | "pointer" | "context-menu";
}

export type ChatMeasurementReason =
  | "code-highlight"
  | "diagram-render"
  | "image-load"
  | "math-typeset"
  | "resource-resolve"
  | "stream-animation";

/** Renderer-local request. WebChatDocument supplies document identity/generation. */
export interface ChatMeasurementRequest {
  readonly geometryChanged: boolean;
  readonly reason: ChatMeasurementReason;
}

/** Host-facing transaction input; stale generations must be discarded. */
export interface ChatMeasurementEvent extends ChatMeasurementRequest {
  readonly documentId: string;
  readonly generation: number;
}

/** Presentation diagnostics stay separate from geometry and resource authority. */
export interface ChatMediaDiagnostic {
  readonly documentId: string;
  readonly phase: "policy" | "source" | "decode";
  readonly sourceKind: "file" | "resource" | "external" | "data" | "other";
  readonly transport: "host" | "direct";
  readonly outcome: "ok" | "failed";
  readonly contentType?: string;
  readonly policy?: "resource" | "csp";
  readonly error?: unknown;
  readonly readAttempts?: number;
}

export interface ChatRenderContext {
  readonly documentId: string;
  readonly dialect?: ChatDocumentDialect;
  readonly conversationId?: string | null;
  readonly turnId?: string | null;
  readonly hostId?: string | null;
  readonly cwd?: string | null;
  readonly theme: ChatRenderTheme;
  readonly externalResourcePolicy: ChatExternalResourcePolicy;
  readonly streaming: boolean;
  readonly allowWideBlocks: boolean;
  readonly stickyCodeHeaders?: boolean;
  readonly fadeTimeline?: ChatFadeTimeline;
  readonly openResource?: (
    target: string,
    decision: ChatResourceDecision,
    intent?: ChatResourceOpenIntent,
  ) => void;
  /** Host may expose only a subset of the policy's allowed navigation kinds. */
  readonly canOpenResource?: (target: string, decision: ChatResourceDecision) => boolean;
  /**
   * Product-host byte boundary for resources that a browser cannot load
   * directly (for example an AppServer-local `file://` image). The renderer
   * owns loading/error presentation; the host owns transport and caching.
   */
  readonly loadMediaSource?: ChatMediaSourceLoader;
  readonly onMediaDiagnostic?: (event: ChatMediaDiagnostic) => void;
  readonly requestMeasurement?: (request: ChatMeasurementRequest) => void;
}

export interface ChatNodeRendererProps {
  readonly node: ChatDocumentNode;
  readonly context: ChatRenderContext;
  readonly position?: {
    readonly parentKind: ChatDocumentNode["kind"] | null;
    readonly previousSiblingKind: ChatDocumentNode["kind"] | null;
    readonly nextSiblingKind: ChatDocumentNode["kind"] | null;
    readonly nextSibling: ChatDocumentNode | null;
  };
  readonly renderNodes: (nodes: readonly ChatDocumentNode[], parentKind?: ChatDocumentNode["kind"] | null) => ReactNode;
}

export interface ChatNodeRenderer {
  readonly name: string;
  readonly priority: number;
  readonly kinds: readonly ChatDocumentNode["kind"][];
  matches?(node: ChatDocumentNode, context: ChatRenderContext): boolean;
  readonly component: ComponentType<ChatNodeRendererProps>;
}

export interface ChatDirectiveHandler {
  readonly name: string;
  readonly priority: number;
  readonly component: ComponentType<ChatNodeRendererProps>;
}

export interface ChatResourceDecision {
  readonly allowed: boolean;
  readonly target: string | null;
  readonly reason?: string;
  readonly kind?: ChatResourceKind;
}

export interface ChatMediaSourceRequest {
  readonly signal?: AbortSignal;
  readonly source: string;
  readonly resolvedTarget: string;
  readonly resourceKind: ChatResourceKind;
  readonly documentId: string;
  readonly conversationId: string | null;
  readonly hostId: string | null;
  readonly cwd: string | null;
}

export interface ChatMediaSourceResult {
  readonly release?: () => void;
  /** Browser-readable `data:`, `blob:`, or HTTP(S) source. */
  readonly source: string;
  /** Original transport content type, before the Host applies a display hint. */
  readonly contentType?: string;
  readonly readAttempts?: number;
}

export interface ChatMediaSourceSnapshot {
  /** Existing results may remain ready during refresh or after a refresh error. */
  readonly isFetching?: boolean;
  readonly error?: unknown | null;
  readonly status: "loading" | "ready" | "unavailable";
  readonly value: ChatMediaSourceResult | null;
}
export interface ChatMediaSourceLoader {
  (request: ChatMediaSourceRequest): Promise<ChatMediaSourceResult | null>;
  /** Explicit retry evicts failed bytes through the Host's existing resource owner. */
  retry?: (request: ChatMediaSourceRequest) => Promise<void>;
  /** Recognize only this Host's own download URLs as file sources. */
  resolveFileSource?: (source: string) => string | null;
  /** Optional shared resource projection. Reading never starts IO. */
  getSnapshot?: (request: ChatMediaSourceRequest) => ChatMediaSourceSnapshot;
  subscribe?: (request: ChatMediaSourceRequest, listener: () => void) => () => void;
}

export type ChatResourceKind =
  | "anchor"
  | "app-route"
  | "blocked"
  | "external"
  | "file"
  | "mail"
  | "resource"
  | "workspace-file";

export interface ChatResourcePolicy {
  readonly name: string;
  readonly priority: number;
  matches(target: string, context: ChatRenderContext): boolean;
  resolve(target: string, context: ChatRenderContext): ChatResourceDecision;
}
