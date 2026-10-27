import type { MessageSender } from "@opencraft/appserver-protocol";

export type ConversationNavigationPhase =
  | "empty"
  | "loading"
  | "ready"
  | "degraded"
  | "offline"
  | "error";

export type ConversationNavigationOutputKind =
  | "app"
  | "commit"
  | "file"
  | "image"
  | "pull-request"
  | "review"
  | "website";

export interface ConversationNavigationOutput {
  readonly kind: ConversationNavigationOutputKind;
  readonly label: string | null;
}

/** Protocol-neutral item consumed by Web and Native navigation surfaces. */
export interface ConversationNavigationAnchor {
  readonly id: string;
  readonly turnKey: string;
  readonly itemId: string | null;
  readonly order: number;
  readonly label: string;
  readonly isLoaded: boolean;
  readonly isHeartbeat: boolean;
}

export interface ConversationNavigationPreview {
  /** Provenance of this prompt, never inferred from the viewer or Turn owner. */
  readonly sender?: MessageSender;
  readonly label: string;
  readonly response: string;
  readonly outputs: readonly ConversationNavigationOutput[];
}

export interface ConversationNavigationSnapshot {
  readonly revision: number;
  readonly phase: ConversationNavigationPhase;
  readonly generation: string | null;
  readonly completeness: "complete" | "partial";
  /** Hydration may enrich anchors but cannot mutate topology; authority may append/remove anchors. */
  readonly anchors: readonly ConversationNavigationAnchor[];
  readonly error: Error | null;
}

export interface ConversationNavigationTarget {
  readonly turnKey: string;
  readonly itemId: string | null;
  /** Minimum authoritative Timeline revision that must contain this target. */
  readonly projectionRevision: number;
}

export function conversationNavigationTargetVersion(
  target: Pick<ConversationNavigationTarget, "turnKey" | "itemId">,
): string {
  return JSON.stringify([target.turnKey, target.itemId]);
}

/** A target lease whose authoritative projection is committed and safe to position. */
export interface PreparedConversationNavigationTarget extends ConversationNavigationTarget {
  readonly anchorId: string;
  readonly generation: string;
  /** Per-target lease; unrelated mutations in the same generation do not invalidate it. */
  readonly targetVersion: string;
}

export interface PrepareConversationNavigationTargetOptions {
  readonly signal?: AbortSignal;
}

/**
 * The renderer never receives V3 cursors or V4 epoch/seq locators. A source
 * owns those details and returns a target only after authoritative projection.
 */
export interface ConversationNavigationSource {
  getSnapshot(): ConversationNavigationSnapshot;
  subscribe(listener: () => void): () => void;
  prepare(): Promise<void>;
  loadPreview(anchorId: string): Promise<ConversationNavigationPreview | null>;
  prepareTarget(
    anchorId: string,
    options?: PrepareConversationNavigationTargetOptions,
  ): Promise<PreparedConversationNavigationTarget | null>;
  dispose(): void;
}
