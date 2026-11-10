/**
 * Per-input steer state machine. Admission, delivery, evidence and withdrawal
 * are independent versioned facets, so evidence that arrives before an RPC
 * reply is preserved and a late admission never regresses a context-confirmed
 * input. Withdrawal can only stop a *future* delivery; it never erases content
 * that already entered a native context path.
 */

import type {
  DeliveryMethod,
  EvidenceKind,
  InputAcceptedDelta,
  InputDeliveryDelta,
  InputEvidenceDelta,
  InputWithdrawalDelta,
} from "@opencraft/agent-bridge-protocol";
import type {
  AdmissionState,
  CanonicalEvidenceFacet,
  CanonicalFacet,
  CanonicalInputState,
  DeliveryState,
  EvidenceState,
  InputOutcome,
  WithdrawalState,
} from "./canonical";

const EVIDENCE_RANK: Readonly<Record<EvidenceState, number>> = {
  none: 0,
  "evidence-observed": 1,
  "context-confirmed": 2,
};

function strongerEvidence(a: EvidenceState, b: EvidenceState): EvidenceState {
  return EVIDENCE_RANK[b] > EVIDENCE_RANK[a] ? b : a;
}

function applyFacet<T extends string>(current: CanonicalFacet<T>, value: T, version: number): CanonicalFacet<T> {
  return version >= current.version ? { value, version } : current;
}

/** Map a wire evidence kind onto the honest evidence tier. */
export function evidenceStateFor(kind: EvidenceKind): EvidenceState {
  return kind === "context-confirmed" || kind === "native-input-id"
    ? "context-confirmed"
    : "evidence-observed";
}

/** Evidence may precede registration; keep it without inventing an admission. */
export function blankInput(inputId: string): CanonicalInputState {
  return {
    inputId,
    clientRequestId: inputId,
    nativeSession: null,
    targetNativeTurnId: null,
    expectedTurnId: null,
    allowedPaths: ["native-inject"],
    fallbackPolicy: "reject-unknown",
    disposition: null,
    registration: null,
    admission: { value: "none", version: 0 },
    delivery: { value: "none", version: 0 },
    evidence: { value: "none", version: 0 },
    withdrawal: { value: "none", version: 0 },
    outcome: "pending",
  };
}

export function registerInput(delta: InputAcceptedDelta): CanonicalInputState {
  return {
    inputId: delta.inputId,
    clientRequestId: delta.clientRequestId,
    nativeSession: delta.targetNativeSession ?? null,
    targetNativeTurnId: delta.expectedTurnId ?? null,
    expectedTurnId: null,
    allowedPaths: delta.allowedPaths ?? ["native-inject"],
    fallbackPolicy: delta.fallbackPolicy ?? "reject-unknown",
    disposition: null,
    registration: { value: "registered", version: 0 },
    admission: { value: "none", version: 0 },
    delivery: { value: "none", version: 0 },
    evidence: { value: "none", version: 0 },
    withdrawal: { value: "none", version: 0 },
    outcome: "registered",
  };
}

export function withDisposition(
  state: CanonicalInputState,
  disposition: "steered" | "queued",
  expectedTurnId: string | null,
): CanonicalInputState {
  return { ...state, disposition, expectedTurnId, outcome: deriveOutcome({ ...state, expectedTurnId }) };
}

export function deriveOutcome(state: CanonicalInputState): InputOutcome {
  if (state.withdrawal.value === "too-late") return "too-late";
  if (state.withdrawal.value === "withdrawn") return "withdrawn";
  if (state.evidence.value === "context-confirmed") return "context-confirmed";
  if (state.evidence.value === "evidence-observed") return "evidence-observed";
  if (state.admission.value === "rejected") return "rejected";
  if (state.admission.value === "failed") return "failed";
  if (state.admission.value === "unknown") return "unknown";
  if (state.delivery.value !== "none" || state.admission.value === "accepted") return "delivered";
  if (state.registration !== null) return "registered";
  return "pending";
}

function settle(state: CanonicalInputState): CanonicalInputState {
  return { ...state, outcome: deriveOutcome(state) };
}

export function applyDelivery(state: CanonicalInputState, delta: InputDeliveryDelta): CanonicalInputState {
  const admission: CanonicalFacet<AdmissionState> = applyFacet(
    state.admission,
    delta.admitted ? "accepted" : "rejected",
    delta.version,
  );
  const delivery: CanonicalFacet<DeliveryState> = applyFacet(
    state.delivery,
    delta.admitted ? (delta.deliveryMethod as DeliveryMethod) : "none",
    delta.version,
  );
  return settle({ ...state, admission, delivery });
}

export function applyEvidence(state: CanonicalInputState, delta: InputEvidenceDelta): CanonicalInputState {
  const value = strongerEvidence(state.evidence.value, evidenceStateFor(delta.evidenceKind));
  const version = Math.max(state.evidence.version, delta.version);
  const incomingStrengthens = EVIDENCE_RANK[evidenceStateFor(delta.evidenceKind)] >= EVIDENCE_RANK[value]
    && delta.version >= state.evidence.version;
  const evidence: CanonicalEvidenceFacet = {
    value,
    version,
    ...(state.evidence.evidenceKind !== undefined ? { evidenceKind: state.evidence.evidenceKind } : {}),
    ...(state.evidence.evidenceRef !== undefined ? { evidenceRef: state.evidence.evidenceRef } : {}),
    ...(state.evidence.nativeInputId !== undefined ? { nativeInputId: state.evidence.nativeInputId } : {}),
    ...(state.evidence.runId !== undefined ? { runId: state.evidence.runId } : {}),
    ...(incomingStrengthens ? {
      ...(delta.evidenceKind !== undefined ? { evidenceKind: delta.evidenceKind } : {}),
      ...(delta.evidenceRef !== undefined ? { evidenceRef: delta.evidenceRef } : {}),
      ...(delta.nativeInputId !== undefined ? { nativeInputId: delta.nativeInputId } : {}),
      ...(delta.runId !== undefined ? { runId: delta.runId } : {}),
    } : {}),
  };
  let withdrawal = state.withdrawal;
  // Content already reached a native context path: a pending withdrawal is too late.
  if (value === "context-confirmed"
    && (withdrawal.value === "withdraw-requested" || withdrawal.value === "withdrawn")) {
    withdrawal = { value: "too-late", version: Math.max(withdrawal.version, delta.version) };
  }
  return settle({ ...state, evidence, withdrawal });
}

export function applyWithdrawal(state: CanonicalInputState, delta: InputWithdrawalDelta): CanonicalInputState {
  const alreadyDelivered = state.delivery.value !== "none" || state.admission.value === "accepted";
  const alreadyInContext = state.evidence.value === "context-confirmed";
  if (alreadyDelivered || alreadyInContext) {
    const withdrawal = { value: "too-late" as WithdrawalState, version: Math.max(state.withdrawal.version, delta.version) };
    return settle({ ...state, withdrawal });
  }
  const withdrawal = applyFacet(state.withdrawal, delta.state, delta.version);
  return settle({ ...state, withdrawal });
}
