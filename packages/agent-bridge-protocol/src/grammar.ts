/**
 * The semantic-delta grammar carried by `thread/delta`. A delta is a parsed,
 * provider-independent unit of meaning; it is neither a raw provider event nor
 * a finished client event. The center assembler (in the sibling package) owns
 * id minting, ordering, and lifecycle; deltas carry only vouched native join
 * keys and their source scope.
 */

import type { DeliveryMethod, EvidenceKind } from "./capabilities";

/** Which thread, and optionally which anonymous stream, a delta belongs to. */
export interface DeltaScope {
  readonly threadId: string;
  readonly channel?: "assistant" | "reasoning" | "plan" | "tool";
  readonly parentRef?: string;
}

interface DeltaBase {
  /** Source scope is mandatory on every delta. */
  readonly scope: DeltaScope;
  /**
   * Provider-native join key (tool-call id, stream key, item id). It is a
   * vouched correlation handle, never a canonical timeline id.
   */
  readonly nativeKey?: string;
  /** Vouched turn key. Only turns the bridge itself opened may scope a delta. */
  readonly nativeTurnId?: string;
}

export type TextChannel = "agentMessage" | "reasoning" | "plan";

export type TurnStatus = "completed" | "failed" | "interrupted";

export interface TokenUsage {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

/** Terminal item shapes; the projection maps these onto existing ThreadItem kinds. */
export type ItemShape =
  | { readonly kind: "userMessage"; readonly text: string; readonly clientId?: string | null }
  | { readonly kind: "agentMessage"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "plan"; readonly text: string }
  | {
      /** A generic provider tool: projects to an existing dynamicToolCall. */
      readonly kind: "tool";
      readonly name: string;
      readonly status: "inProgress" | "completed" | "failed";
      readonly output?: string | null;
    }
  | {
      /** A real shell command: the only shape that projects to commandExecution. */
      readonly kind: "command";
      readonly command: string;
      readonly cwd: string;
      readonly status: "inProgress" | "completed" | "failed";
      readonly output?: string | null;
    };

export interface TurnOpenDelta extends DeltaBase {
  readonly op: "turn.open";
  readonly nativeTurnId: string;
  readonly expectedInputIds?: readonly string[];
}

export interface TurnBoundaryDelta extends DeltaBase {
  readonly op: "turn.boundary";
  readonly nativeTurnId: string;
  readonly status: TurnStatus;
  /** Own a turn only when accepted input is pending (provider-terminal fallback). */
  readonly claimIfIdle?: boolean;
}

export interface TurnMainRunDelta extends DeltaBase {
  readonly op: "turn.mainRun";
  readonly state: "idle" | "running";
}

export interface TurnCloseDelta extends DeltaBase {
  readonly op: "turn.close";
  readonly nativeTurnId: string;
  readonly status: TurnStatus;
}

export interface ItemOpenDelta extends DeltaBase {
  readonly op: "item.open";
  readonly nativeKey: string;
  readonly shape: ItemShape;
  readonly presentation?: string;
}

export interface ItemProgressDelta extends DeltaBase {
  readonly op: "item.progress";
  readonly nativeKey: string;
  readonly note?: string;
}

export interface ItemTextDeltaDelta extends DeltaBase {
  readonly op: "item.textDelta";
  readonly nativeKey: string;
  readonly channel: TextChannel;
  readonly text: string;
}

export interface ItemTextCloseDelta extends DeltaBase {
  readonly op: "item.textClose";
  readonly nativeKey: string;
  readonly channel: TextChannel;
  /** Provider-final text; when absent the accumulated stream settles the item. */
  readonly text?: string;
}

export interface ItemCloseDelta extends DeltaBase {
  readonly op: "item.close";
  readonly nativeKey: string;
  /** Always the full terminal shape. */
  readonly shape: ItemShape;
}

export interface InputAcceptedDelta extends DeltaBase {
  readonly op: "input.accepted";
  readonly inputId: string;
  readonly clientRequestId: string;
  readonly expectedTurnId?: string;
  readonly targetNativeSession?: string;
  readonly allowedPaths?: readonly DeliveryMethod[];
  readonly fallbackPolicy?: "reject-unknown" | "queue-when-explicit";
  /**
   * How this input was attached. Native injection is the default; a caller that
   * explicitly chose next-turn or interrupt-replace records that path so the
   * assembler never presents it as a native steer.
   */
  readonly disposition?: "steered" | "next-turn" | "interrupt-replace";
}

export interface InputDeliveryDelta extends DeltaBase {
  readonly op: "input.delivery";
  readonly inputId: string;
  readonly deliveryMethod: DeliveryMethod;
  readonly admitted: boolean;
  readonly nativeInputId?: string;
  readonly runId?: string;
  readonly version: number;
}

export interface InputEvidenceDelta extends DeltaBase {
  readonly op: "input.evidence";
  readonly inputId: string;
  readonly evidenceKind: EvidenceKind;
  readonly evidenceRef?: string;
  readonly nativeInputId?: string;
  readonly runId?: string;
  readonly version: number;
}

export interface InputWithdrawalDelta extends DeltaBase {
  readonly op: "input.withdrawal";
  readonly inputId: string;
  readonly state: "withdraw-requested" | "withdrawn" | "too-late" | "unsupported" | "unknown";
  readonly version: number;
}

/**
 * A terminal command-outcome fact. `unknown` is what a bridge reports after a
 * write-then-EOF window with no native admission proof; it settles the input
 * without re-executing the native request.
 */
export interface InputOutcomeDelta extends DeltaBase {
  readonly op: "input.outcome";
  readonly inputId: string;
  readonly state: "unknown" | "rejected" | "failed";
  readonly reason: string;
  readonly version: number;
}

export interface UsageDelta extends DeltaBase {
  readonly op: "usage";
  readonly total: TokenUsage;
  readonly last: TokenUsage;
  readonly modelContextWindow: number | null;
}

export interface ContextWindowDelta extends DeltaBase {
  readonly op: "contextWindow";
  readonly usedTokens: number;
  readonly modelContextWindow: number | null;
  readonly providerTurnId?: string;
}

export interface SessionResetDelta extends DeltaBase {
  readonly op: "session.reset";
  readonly reason?: string;
}

export interface SessionEndedDelta extends DeltaBase {
  readonly op: "session.ended";
  readonly reason?: string;
}

export interface ExtensionStateDelta extends DeltaBase {
  readonly op: "extension.state";
  readonly extensionKind: string;
  readonly state: unknown;
}

export interface RecoveryDelta extends DeltaBase {
  readonly op: "provider.recovery";
  readonly kind: "sessionArchived" | "authRequired" | "restartRecommended" | "staleTurn" | "rateLimited";
  readonly message: string;
  readonly retryable: boolean;
}

export interface UnhandledDelta extends DeltaBase {
  readonly op: "unhandled";
  readonly reason: string;
  readonly source?: string;
}

export type BridgeDelta =
  | TurnOpenDelta
  | TurnBoundaryDelta
  | TurnMainRunDelta
  | TurnCloseDelta
  | ItemOpenDelta
  | ItemProgressDelta
  | ItemTextDeltaDelta
  | ItemTextCloseDelta
  | ItemCloseDelta
  | InputAcceptedDelta
  | InputDeliveryDelta
  | InputEvidenceDelta
  | InputWithdrawalDelta
  | InputOutcomeDelta
  | UsageDelta
  | ContextWindowDelta
  | SessionResetDelta
  | SessionEndedDelta
  | ExtensionStateDelta
  | RecoveryDelta
  | UnhandledDelta;

export type BridgeDeltaOp = BridgeDelta["op"];

/** `thread/delta` payload: identity precedes deltas for a session. */
export interface ThreadDeltaParams {
  readonly threadId: string;
  readonly deltas: readonly BridgeDelta[];
}

/** `thread/identity` payload: the durable provider session handle. */
export interface ThreadIdentityParams {
  readonly threadId: string;
  readonly providerThreadId: string;
  readonly sessionRestorable?: boolean;
}

/** `interaction/request` payload: approval, question, or plugin-defined request. */
export interface InteractionRequestParams {
  readonly threadId: string;
  readonly interactionId: string;
  /** `"approval"`, `"question"`, or a plugin-owned `"<pluginId>/<name>"` string. */
  readonly kind: string;
  readonly payload: unknown;
  readonly providerNativeIds?: boolean;
}

/** `provider/recovery` payload (a notification, not a delta). */
export interface ProviderRecoveryParams {
  readonly threadId?: string;
  readonly kind: "sessionArchived" | "authRequired" | "restartRecommended" | "staleTurn" | "rateLimited";
  readonly message: string;
  readonly retryable: boolean;
}
