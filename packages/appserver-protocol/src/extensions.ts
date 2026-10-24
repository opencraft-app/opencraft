import type { ThreadGoal } from "./generated/v2/ThreadGoal.js";

/** Host-owned queue behavior that cannot be inferred from queue contents. */
export const OPENCRAFT_THREAD_QUEUE_EXTENSION = "opencraft/thread-queue";

/** Thread Goal operations actually implemented by this Server. */
export const OPENCRAFT_THREAD_GOAL_EXTENSION = "opencraft/thread-goal";

export interface OpenCraftThreadGoalCapability {
  readonly version: 1;
  readonly read: true;
  readonly write: boolean;
  /** Absent preserves the legacy accounting contract. */
  readonly usageAccounting?: false;
}

export function parseThreadGoalCapability(value: unknown): OpenCraftThreadGoalCapability | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 && candidate.read === true && typeof candidate.write === "boolean"
    ? { version: 1, read: true, write: candidate.write, ...(candidate.usageAccounting === false ? { usageAccounting: false as const } : {}) }
    : null;
}

/** Additive Goal metadata, kept outside the generated upstream schema. */
export type OpenCraftThreadGoal = ThreadGoal & {
  readonly execution?: { readonly activation: "armed" | "disarmed" };
};

/** Optional live execution metadata; durable phase alone cannot prove arming. */
export function threadGoalNeedsResume(goal: unknown): boolean {
  if (typeof goal !== "object" || goal === null) return false;
  const value = goal as { status?: unknown; execution?: { activation?: unknown } };
  return value.status === "active" && value.execution?.activation === "disarmed";
}

export interface OpenCraftThreadQueueCapability {
  /** V2 makes queue-to-active-Turn consumption one AppServer command. */
  readonly version: 2;
  /** False for runtimes such as DSH whose inbox order is an invariant. */
  readonly reorder: boolean;
  readonly atomicSteer: true;
  /** Host-owned acknowledgement for a target-bound discard of an unresolved claim. */
  readonly unconfirmedSteerDiscard?: true;
  /** Whether pause reasons are durable queue-item state rather than UI state. */
  readonly perItemPause: boolean;
}

export function supportsAtomicQueuedSteer(value: unknown): value is OpenCraftThreadQueueCapability {
  return typeof value === "object" && value !== null
    && "version" in value && value.version === 2
    && "atomicSteer" in value && value.atomicSteer === true;
}

export function supportsUnconfirmedSteerDiscard(value: unknown): boolean {
  return supportsAtomicQueuedSteer(value)
    && "unconfirmedSteerDiscard" in value
    && value.unconfirmedSteerDiscard === true;
}

/** Host-owned Thread lifecycle operations; missing flags never imply support. */
export const OPENCRAFT_THREAD_LIFECYCLE_EXTENSION = "opencraft/thread-lifecycle";

export interface OpenCraftThreadLifecycleCapability {
  readonly version: 1;
  readonly fork?: boolean;
  /** Temporary context forks without advertising persistent Fork. */
  readonly ephemeralFork?: boolean;
  readonly ephemeral?: boolean;
  readonly injectItems?: boolean;
  readonly unsubscribe?: boolean;
  readonly rename?: boolean;
  readonly archive?: boolean;
  readonly delete?: boolean;
}

export function parseThreadLifecycleCapability(value: unknown): OpenCraftThreadLifecycleCapability | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const capability = value as Record<string, unknown>;
  if (capability.version !== 1) return null;
  return {
    version: 1,
    fork: capability.fork === true,
    ephemeralFork: capability.ephemeralFork === true,
    ephemeral: capability.ephemeral === true,
    injectItems: capability.injectItems === true,
    unsubscribe: capability.unsubscribe === true,
    rename: capability.rename === true,
    archive: capability.archive === true,
    delete: capability.delete === true,
  };
}

/**
 * Host extension for catalogs whose contents are owned by a Thread/session.
 *
 * A Thread/session can have its own provider configuration, so a model picker
 * must name the Thread whose catalog it is requesting.
 */
export const OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION =
  "opencraft/scoped-model-catalog";

export const OPENCRAFT_SCOPED_MODEL_CATALOG_CAPABILITY = Object.freeze({
  version: 1,
});

/** Host-declared history strategy that can be selected before Thread Resume. */
export const OPENCRAFT_RESUME_HISTORY_EXTENSION = "opencraft/resume-history";

export interface OpenCraftResumeHistoryCapability {
  readonly version: 1;
  readonly mode: "legacy" | "paginated" | "message-window";
  /** Paginated hosts may return a full initial page in thread/resume. */
  readonly initialTurnsPage?: boolean;
  readonly boundedRecovery?: boolean;
}

/**
 * Host declaration for engines whose `thread/start` identity is not yet a
 * recoverable conversation. The client must not retire its Draft until the
 * first `turn/start` has been accepted by that same engine generation.
 */
export const OPENCRAFT_THREAD_START_DURABILITY_EXTENSION =
  "opencraft/thread-start-durability";

export interface OpenCraftThreadStartDurabilityCapability {
  readonly version: 1;
  readonly durableAfter: "first-turn-accepted";
}

export const OPENCRAFT_FIRST_TURN_DURABILITY_CAPABILITY = Object.freeze({
  version: 1,
  durableAfter: "first-turn-accepted",
} satisfies OpenCraftThreadStartDurabilityCapability);
