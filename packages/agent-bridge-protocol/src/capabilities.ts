/**
 * Capability declaration, handshake negotiation, and command gating.
 *
 * A registration declares the *upper bound* of what a provider can do. An
 * instance probe may only narrow that bound (turn booleans off, shrink
 * delivery/evidence method lists, disable withdrawal); it can never widen it.
 * There is deliberately no `steerMode` flag: a mode nothing consumes cannot be
 * an honest declaration. Every declared fact is tied to a minimum native
 * version and the probe that established it.
 */

import type { BridgeErrorObject, BridgeFailure, BridgeRequestId } from "./json-rpc";
import { bridgeFailure, BRIDGE_ERROR_CODES, makeBridgeError } from "./json-rpc";
import { BRIDGE_COMMAND_REQUIREMENTS, type BridgeCommand, type CapabilityKey } from "./methods";
import {
  BRIDGE_PROTOCOL_VERSION,
  negotiateGrammar,
  type GrammarRange,
} from "./version";

export type DeliveryMethod = "native-inject" | "next-turn" | "interrupt-replace";

/** What a provider can prove about one input reaching a native run. */
export type EvidenceKind =
  | "context-confirmed"
  | "native-input-id"
  | "admission"
  | "echo"
  | "queue-change";

export type WithdrawalCapability = "before-dispatch" | "native" | "none";

export interface SteerDeclaration {
  /** Allowed paths. Only `native-inject` is on by default; queue/interrupt are opt-in. */
  readonly deliveryMethods: readonly DeliveryMethod[];
  readonly evidenceKinds: readonly EvidenceKind[];
  readonly withdrawal: WithdrawalCapability;
  readonly contentLimits: {
    readonly maxBytes: number;
    readonly allowedContentTypes: readonly string[];
  };
  /** Sources without a stable native input id may hold at most one pending input. */
  readonly maxPendingWithoutNativeId: number;
  /** Explicitly-refused-not-sent inputs may fall back; timeouts/evidence gaps never do. */
  readonly fallbackPolicy: "reject-unknown" | "queue-when-explicit";
}

export interface DeclaredCapabilities {
  readonly model: boolean;
  readonly reasoning: boolean;
  readonly history: boolean;
  readonly usage: boolean;
  readonly approval: boolean;
  readonly inputContentTypes: readonly string[];
  readonly cliExecutable: boolean;
  readonly forkCheckpoint: boolean;
  readonly skills: boolean;
  readonly installation: boolean;
  readonly steer: SteerDeclaration;
}

export interface BridgeDeclaration {
  readonly providerId: string;
  readonly protocolVersion: number;
  readonly grammarRange: GrammarRange;
  /** Who executes an approval: the provider loop or the Engine Host. */
  readonly approvalExecutor: "provider" | "host";
  readonly capabilities: DeclaredCapabilities;
  /** Lowest native version for which the declaration holds. */
  readonly minNativeVersion: string;
  /** How the declaration was established (source-checked, probed, etc.). */
  readonly probeBasis: string;
}

/** A narrowing-only instance probe. Anything omitted keeps the declared value. */
export interface BridgeInstanceProbe {
  readonly disabledCapabilities?: readonly CapabilityKey[];
  readonly steerDisabledMethods?: readonly DeliveryMethod[];
  readonly steerDisabledEvidence?: readonly EvidenceKind[];
  readonly withdrawalUnavailable?: boolean;
}

export interface BridgeInitializeParams {
  readonly protocolVersion: number;
  readonly grammarRange: GrammarRange;
  /** Informational host-side facts; they never widen the bridge declaration. */
  readonly hostCapabilities?: readonly string[];
}

export interface BridgeInitializeResult {
  readonly protocolVersion: number;
  readonly grammarVersion: number;
  readonly approvalExecutor: "provider" | "host";
  readonly effectiveCapabilities: DeclaredCapabilities;
}

export type HandshakeOutcome =
  | { readonly ok: true; readonly result: BridgeInitializeResult }
  | { readonly ok: false; readonly error: BridgeErrorObject };

function has(list: readonly string[] | undefined, value: string): boolean {
  return list !== undefined && list.includes(value);
}

/** Compute the effective (possibly narrower) capabilities after an instance probe. */
export function effectiveCapabilities(
  declaration: BridgeDeclaration,
  probe: BridgeInstanceProbe = {},
): DeclaredCapabilities {
  const declared = declaration.capabilities;
  const off = (key: CapabilityKey): boolean => has(probe.disabledCapabilities as readonly string[] | undefined, key);
  const steer = declared.steer;
  return {
    model: declared.model && !off("model"),
    reasoning: declared.reasoning && !off("reasoning"),
    history: declared.history && !off("history"),
    usage: declared.usage && !off("usage"),
    approval: declared.approval && !off("approval"),
    inputContentTypes: off("inputContentTypes") ? [] : declared.inputContentTypes,
    cliExecutable: declared.cliExecutable && !off("cliExecutable"),
    forkCheckpoint: declared.forkCheckpoint && !off("forkCheckpoint"),
    skills: declared.skills && !off("skills"),
    installation: declared.installation && !off("installation"),
    steer: {
      deliveryMethods: steer.deliveryMethods.filter(
        (method) => !has(probe.steerDisabledMethods as readonly string[] | undefined, method),
      ),
      evidenceKinds: steer.evidenceKinds.filter(
        (kind) => !has(probe.steerDisabledEvidence as readonly string[] | undefined, kind),
      ),
      withdrawal: probe.withdrawalUnavailable ? "none" : steer.withdrawal,
      contentLimits: steer.contentLimits,
      maxPendingWithoutNativeId: steer.maxPendingWithoutNativeId,
      fallbackPolicy: steer.fallbackPolicy,
    },
  };
}

export function negotiateHandshake(
  params: BridgeInitializeParams,
  declaration: BridgeDeclaration,
  probe: BridgeInstanceProbe = {},
): HandshakeOutcome {
  const reject = (message: string): HandshakeOutcome => ({
    ok: false,
    error: makeBridgeError("unsupported", BRIDGE_ERROR_CODES.unsupportedCapability, message),
  });

  if (params.protocolVersion !== BRIDGE_PROTOCOL_VERSION || declaration.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    return reject("no common bridge protocol version; startup refused");
  }
  const grammarVersion = negotiateGrammar(params.grammarRange, declaration.grammarRange);
  if (grammarVersion === null) {
    return reject("no common semantic grammar version; startup refused");
  }

  return {
    ok: true,
    result: {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      grammarVersion,
      approvalExecutor: declaration.approvalExecutor,
      effectiveCapabilities: effectiveCapabilities(declaration, probe),
    },
  };
}

function capabilityEnabled(capabilities: DeclaredCapabilities, key: CapabilityKey): boolean {
  switch (key) {
    case "model": return capabilities.model;
    case "reasoning": return capabilities.reasoning;
    case "history": return capabilities.history;
    case "usage": return capabilities.usage;
    case "approval": return capabilities.approval;
    case "inputContentTypes": return capabilities.inputContentTypes.length > 0;
    case "cliExecutable": return capabilities.cliExecutable;
    case "forkCheckpoint": return capabilities.forkCheckpoint;
    case "skills": return capabilities.skills;
    case "installation": return capabilities.installation;
    // A steer-capable bridge must at least expose the default native-inject path.
    case "steer": return capabilities.steer.deliveryMethods.includes("native-inject");
  }
}

export type MethodAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly capability: CapabilityKey; readonly reason: string };

/** Gate a command on the effective capabilities. Undeclared methods are refused. */
export function assertMethodAllowed(
  capabilities: DeclaredCapabilities,
  method: BridgeCommand,
): MethodAdmission {
  const requirement = BRIDGE_COMMAND_REQUIREMENTS[method];
  if (requirement === null) return { ok: true };
  if (capabilityEnabled(capabilities, requirement)) return { ok: true };
  return {
    ok: false,
    capability: requirement,
    reason: `method ${method} requires undeclared capability ${requirement}`,
  };
}

/** Build the JSON-RPC failure a Host writes when a command is capability-gated out. */
export function refuseUndeclaredMethod(id: BridgeRequestId, admission: Extract<MethodAdmission, { ok: false }>): BridgeFailure {
  return bridgeFailure(
    id,
    makeBridgeError("unsupported", BRIDGE_ERROR_CODES.unsupportedCapability, admission.reason, {
      capability: admission.capability,
    }),
  );
}
