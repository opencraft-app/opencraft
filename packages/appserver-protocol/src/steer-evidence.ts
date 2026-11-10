/**
 * OpenCraft-owned, additive steer-evidence declarations.
 *
 * The generated `v2/*` files come from the upstream app-server schema and are
 * marked "DO NOT MODIFY BY HAND"; this file is the existing OpenCraft extension
 * surface (the same pattern as `extensions.ts`, `collaboration.ts`, and the
 * `disposition` field on `TurnSteerResponse`). Everything here is optional and
 * capability-gated: a client that does not declare `opencraft/steer-evidence`
 * never receives the evidence notification and keeps the legacy contract, so
 * an unknown/admission-only input is never flattened into an old "injected"
 * success label.
 */

/** Capability id a client declares to opt into per-input steer evidence. */
export const OPENCRAFT_STEER_EVIDENCE_EXTENSION = "opencraft/steer-evidence";

/** Additive notification method; old consumers ignore unknown methods. */
export const OPENCRAFT_STEER_EVIDENCE_NOTIFICATION = "opencraft/steerEvidence/updated";

/** Additive status query method; only served to clients that declared the capability. */
export const OPENCRAFT_STEER_STATUS_METHOD = "opencraft/steer/status";

export interface OpenCraftSteerEvidenceCapability {
  readonly version: 1;
  readonly perInputEvidence: true;
  readonly deliveryMethods: readonly ("native-inject" | "next-turn" | "interrupt-replace")[];
  readonly evidenceKinds: readonly string[];
  readonly withdrawal: "before-dispatch" | "native" | "none";
  readonly query: true;
}

const DELIVERY_METHODS = ["native-inject", "next-turn", "interrupt-replace"] as const;
type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

function parseDeliveryMethods(value: unknown): readonly DeliveryMethod[] | null {
  if (!Array.isArray(value)) return null;
  const methods: DeliveryMethod[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(DELIVERY_METHODS as readonly string[]).includes(entry)) return null;
    methods.push(entry as DeliveryMethod);
  }
  return methods;
}

export function parseSteerEvidenceCapability(value: unknown): OpenCraftSteerEvidenceCapability | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.perInputEvidence !== true || candidate.query !== true) return null;
  const deliveryMethods = parseDeliveryMethods(candidate.deliveryMethods);
  if (deliveryMethods === null) return null;
  if (!Array.isArray(candidate.evidenceKinds) || !candidate.evidenceKinds.every((entry) => typeof entry === "string")) return null;
  if (candidate.withdrawal !== "before-dispatch" && candidate.withdrawal !== "native" && candidate.withdrawal !== "none") return null;
  return {
    version: 1,
    perInputEvidence: true,
    deliveryMethods,
    evidenceKinds: candidate.evidenceKinds as string[],
    withdrawal: candidate.withdrawal,
    query: true,
  };
}

export type SteerAdmissionState = "none" | "accepted" | "rejected" | "failed" | "unknown";
export type SteerDeliveryState = "none" | "native-inject" | "next-turn" | "interrupt-replace";
export type SteerEvidenceState = "none" | "context-confirmed" | "evidence-observed";
export type SteerWithdrawalState =
  | "none"
  | "withdraw-requested"
  | "withdrawn"
  | "too-late"
  | "unsupported"
  | "unknown";

/** A facet keeps its own version so evidence can precede an RPC reply without regressing. */
export interface SteerFacet<T extends string> {
  readonly value: T;
  readonly version: number;
}

export interface SteerEvidenceFacet extends SteerFacet<SteerEvidenceState> {
  readonly evidenceKind?: string;
  readonly evidenceRef?: string;
  readonly nativeInputId?: string;
  readonly runId?: string;
}

/** The client-facing, per-input fact record. It is intentionally not one linear enum. */
export interface SteerInputStatus {
  readonly inputId: string;
  readonly clientRequestId: string;
  readonly expectedTurnId: string | null;
  /** Platform received (control ledger), before handing to the agent. */
  readonly registration: SteerFacet<"registered"> | null;
  readonly admission: SteerFacet<SteerAdmissionState>;
  readonly delivery: SteerFacet<SteerDeliveryState>;
  readonly evidence: SteerEvidenceFacet;
  readonly withdrawal: SteerFacet<SteerWithdrawalState>;
  readonly outcome:
    | "pending"
    | "registered"
    | "delivered"
    | "context-confirmed"
    | "evidence-observed"
    | "withdrawn"
    | "too-late"
    | "rejected"
    | "failed"
    | "unknown";
}

export interface OpenCraftSteerEvidenceNotification {
  readonly threadId: string;
  /** The bridge schema version that produced these states. */
  readonly schemaVersion: number;
  readonly inputs: readonly SteerInputStatus[];
}

export interface OpenCraftSteerStatusParams {
  readonly threadId: string;
  readonly inputIds?: readonly string[];
}

export interface OpenCraftSteerStatusResult {
  readonly schemaVersion: number;
  readonly inputs: readonly SteerInputStatus[];
}
