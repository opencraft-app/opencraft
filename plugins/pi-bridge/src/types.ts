/**
 * Provider-bridge boundary for the existing Pi durable owner.
 *
 * The bridge never opens a Pi RPC child. It wraps the same
 * `PiDurableSession` class that the AppServer Pi engine uses, so a
 * bridge-owned Thread has exactly one native writer: the pi-durable session
 * (SQLite + its kernel-backed lockfile). `PiOwnerPort` is the narrow seam that
 * keeps protocol tests independent of a real model and storage.
 */

import type { TokenUsage } from "@opencraft/agent-bridge-protocol";
import type { PiTurn } from "@opencraft/plugin-pi-engine/projection";

export interface PiModelRef {
  readonly provider: string;
  readonly modelId: string;
}

export interface PiSubmissionState {
  readonly status: "queued" | "placed" | "done" | "unanswered";
  readonly entry?: number;
  readonly reason?: string;
}

export interface PiProjectedSnapshot {
  readonly turns: readonly PiTurn[];
  readonly submissions: ReadonlyMap<string, PiSubmissionState>;
  readonly activeTurnId: string | null;
  readonly usage?: {
    readonly total: TokenUsage;
    readonly last: TokenUsage;
    readonly modelContextWindow: number | null;
  };
}

export interface PiOwnerCreate {
  /** Host route identity, opaque to the bridge. Used only for callback scope. */
  readonly routeId: string;
  /** Stable, filesystem-safe native owner id minted by the bridge. */
  readonly ownerThreadId: string;
  readonly nativeSessionId: string;
  readonly cwd: string;
  readonly model: PiModelRef;
  readonly thinkingLevel: string;
  readonly baseInstructions?: string;
  readonly developerInstructions?: string;
}

export type PiTurnStatus = "running" | "completed" | "failed" | "interrupted";

/** One native owner. Only this object may write the durable session. */
export interface PiOwnerPort {
  readonly info: PiOwnerCreate;
  snapshot(): Promise<PiProjectedSnapshot>;
  submit(content: readonly Record<string, unknown>[], data: Record<string, unknown>, requestId: string): Promise<void>;
  steer(content: readonly Record<string, unknown>[], data: Record<string, unknown>, requestId: string, expectedTurnId: string): Promise<void>;
  execution(requestId: string): Promise<"running" | "completed" | "failed" | null>;
  abort(): Promise<void>;
  close(): Promise<void>;
  setSnapshotListener(listener: (snapshot: PiProjectedSnapshot) => void): void;
  setExitListener(listener: (error: Error) => void): void;
}

export interface PiModelInfo {
  readonly id: string;
  readonly provider: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly contextWindow: number | null;
  readonly inputModalities: readonly string[];
  readonly supportedReasoningEfforts: readonly string[];
  readonly defaultReasoningEffort: string;
  readonly cost: unknown;
}

export interface PiOwnerFactory {
  models(): Promise<readonly PiModelInfo[]>;
  create(input: {
    readonly routeId: string;
    readonly cwd: string;
    readonly model: string | PiModelRef;
    readonly thinkingLevel?: string;
    readonly baseInstructions?: string;
    readonly developerInstructions?: string;
  }): Promise<PiOwnerPort>;
  resume(input: { readonly routeId: string }): Promise<PiOwnerPort>;
  /** Drop the in-memory owner after a clean close; durable metadata remains. */
  close(owner: PiOwnerPort): Promise<void>;
}
