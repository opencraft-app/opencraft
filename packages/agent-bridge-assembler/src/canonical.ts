/**
 * Canonical timeline model produced by the assembler. These events are
 * provider-agnostic and client-protocol-agnostic; ids are minted here, never by
 * a bridge. The projection (a separate module) is the only place that turns
 * them into existing AppServer notifications.
 */

import type { DeliveryMethod, ItemShape, TextChannel, TokenUsage, TurnStatus } from "@opencraft/agent-bridge-protocol";

export interface EventMeta {
  /** Monotonic sequence within one assembly run. */
  readonly seq: number;
  /** Deterministic timestamp derived from the recording clock seed. */
  readonly atMs: number;
}

export interface CanonicalItem {
  readonly itemId: string;
  readonly nativeKey: string;
  readonly threadId: string;
  /** null for thread-scoped (background) work that survives turn settlement. */
  readonly turnId: string | null;
  readonly shape: ItemShape;
}

export interface CanonicalUsage {
  readonly total: TokenUsage;
  readonly last: TokenUsage;
  readonly modelContextWindow: number | null;
}

export type AdmissionState = "none" | "accepted" | "rejected" | "failed" | "unknown";
export type DeliveryState = "none" | DeliveryMethod;
export type EvidenceState = "none" | "evidence-observed" | "context-confirmed";
export type WithdrawalState =
  | "none"
  | "withdraw-requested"
  | "withdrawn"
  | "too-late"
  | "unsupported"
  | "unknown";

/** Each facet keeps its own version; evidence may precede an RPC reply. */
export interface CanonicalFacet<T extends string> {
  readonly value: T;
  readonly version: number;
}

export interface CanonicalEvidenceFacet extends CanonicalFacet<EvidenceState> {
  readonly evidenceKind?: string;
  readonly evidenceRef?: string;
  readonly nativeInputId?: string;
  readonly runId?: string;
}

export type InputOutcome =
  | "pending"
  | "registered"
  | "queued"
  | "delivered"
  | "context-confirmed"
  | "evidence-observed"
  | "withdrawn"
  | "too-late"
  | "rejected"
  | "failed"
  | "unknown";

/** Per-input fact record. Deliberately not a single linear enum. */
export interface CanonicalInputState {
  readonly inputId: string;
  readonly clientRequestId: string;
  readonly nativeSession: string | null;
  /** Native/provider turn id the input was addressed to (vouched join key). */
  readonly targetNativeTurnId: string | null;
  /** Canonical turn id once the input is attached to an opened turn. */
  readonly expectedTurnId: string | null;
  readonly allowedPaths: readonly DeliveryMethod[];
  readonly fallbackPolicy: "reject-unknown" | "queue-when-explicit";
  /** "steered" when injected into a live turn, "queued" when it raced the end. */
  readonly disposition: "steered" | "queued" | null;
  /** How many native executions were attempted; an unknown outcome must not add one. */
  readonly nativeExecutions: number;
  readonly registration: CanonicalFacet<"registered"> | null;
  readonly admission: CanonicalFacet<AdmissionState>;
  readonly delivery: CanonicalFacet<DeliveryState>;
  readonly evidence: CanonicalEvidenceFacet;
  readonly withdrawal: CanonicalFacet<WithdrawalState>;
  readonly outcome: InputOutcome;
}

export type CanonicalEventBody =
  | { readonly kind: "turn.started"; readonly threadId: string; readonly turnId: string; readonly nativeTurnId: string }
  | { readonly kind: "turn.mainRun"; readonly threadId: string; readonly turnId: string; readonly state: "idle" | "running" }
  | { readonly kind: "turn.completed"; readonly threadId: string; readonly turnId: string; readonly status: TurnStatus; readonly startedAtMs: number }
  | { readonly kind: "item.started"; readonly threadId: string; readonly turnId: string | null; readonly item: CanonicalItem }
  | { readonly kind: "item.completed"; readonly threadId: string; readonly turnId: string | null; readonly item: CanonicalItem }
  | { readonly kind: "agentMessage.delta"; readonly threadId: string; readonly turnId: string; readonly itemId: string; readonly channel: TextChannel; readonly delta: string }
  | { readonly kind: "tokenUsage.updated"; readonly threadId: string; readonly turnId: string; readonly usage: CanonicalUsage }
  | { readonly kind: "input.state"; readonly threadId: string; readonly status: CanonicalInputState }
  | { readonly kind: "extension.state"; readonly threadId: string; readonly extensionKind: string; readonly state: unknown }
  | { readonly kind: "provider.recovery"; readonly threadId: string; readonly recoveryKind: string; readonly message: string; readonly retryable: boolean }
  | { readonly kind: "unhandled"; readonly threadId: string; readonly reason: string }
  | { readonly kind: "contextWindow"; readonly threadId: string; readonly usedTokens: number; readonly modelContextWindow: number | null };

export type CanonicalEvent = EventMeta & CanonicalEventBody;

export type CanonicalEventKind = CanonicalEvent["kind"];

export type DiagnosticCode =
  | "duplicate-turn-open"
  | "duplicate-close"
  | "out-of-order"
  | "orphan-no-turn"
  | "delta-first-synthesized"
  | "close-without-open"
  | "session-reset-settled"
  | "session-ended-settled"
  | "steer-end-race"
  | "withdrawal-too-late"
  | "ambiguous-input-source"
  | "empty-stream"
  | "recovery-hint"
  | "reconcile-required"
  | "unhandled-diagnostic";

export interface AssembleDiagnostic {
  readonly code: DiagnosticCode;
  readonly op: string;
  readonly detail: string;
  readonly nativeKey?: string;
}

interface OpenTurn {
  readonly turnId: string;
  readonly nativeTurnId: string;
  readonly threadId: string;
  /** Deterministic timestamp of this turn's `turn.started` event. */
  readonly startedAtMs: number;
}

interface StreamState {
  readonly itemId: string;
  readonly channel: "agentMessage" | "reasoning" | "plan";
  readonly text: string;
  readonly turnId: string | null;
}

/** A serializable snapshot; `assemble` returns a new one and mutates nothing. */
export interface AssemblerState {
  readonly schemaVersion: number;
  readonly sessionEpoch: number;
  readonly seq: number;
  readonly turnSeq: number;
  readonly itemSeq: number;
  readonly openTurns: Readonly<Record<string, OpenTurn>>;
  readonly activeTurnId: string | null;
  readonly activeNativeTurnId: string | null;
  /** Most recently minted turn id, for thread-scoped usage after settlement. */
  readonly lastTurnId: string | null;
  readonly settledNativeTurns: Readonly<Record<string, string>>;
  readonly openItems: Readonly<Record<string, CanonicalItem>>;
  readonly streams: Readonly<Record<string, StreamState>>;
  readonly settledKeys: Readonly<Record<string, true>>;
  readonly inputs: Readonly<Record<string, CanonicalInputState>>;
  readonly pendingAccepted: readonly string[];
  readonly extensionStates: Readonly<Record<string, unknown>>;
}

export interface AssembleContext {
  readonly threadId: string;
  /** Deterministic base time for event timestamps. */
  readonly clockSeed: number;
  /** Milliseconds added per emitted event. */
  readonly atMsStep?: number;
}

export interface AssembleResult {
  readonly state: AssemblerState;
  readonly events: readonly CanonicalEvent[];
  readonly diagnostics: readonly AssembleDiagnostic[];
}

export function createAssemblerState(schemaVersion: number): AssemblerState {
  return {
    schemaVersion,
    sessionEpoch: 1,
    seq: 0,
    turnSeq: 0,
    itemSeq: 0,
    openTurns: {},
    activeTurnId: null,
    activeNativeTurnId: null,
    lastTurnId: null,
    settledNativeTurns: {},
    openItems: {},
    streams: {},
    settledKeys: {},
    inputs: {},
    pendingAccepted: [],
    extensionStates: {},
  };
}
