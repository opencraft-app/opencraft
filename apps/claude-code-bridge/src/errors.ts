import { BRIDGE_ERROR_CODES, type BridgeErrorKind } from "@opencraft/agent-bridge-protocol";

/** A command failure that already knows its protocol classification. */
export class BridgeCommandError extends Error {
  constructor(
    readonly kind: BridgeErrorKind,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "BridgeCommandError";
  }
}

export function invalid(message: string, data?: unknown): BridgeCommandError {
  return new BridgeCommandError("invalid", BRIDGE_ERROR_CODES.invalidParams, message, data);
}

export function unsupported(message: string, data?: unknown): BridgeCommandError {
  return new BridgeCommandError("unsupported", BRIDGE_ERROR_CODES.unsupportedCapability, message, data);
}

export function staleTarget(message: string, data?: unknown): BridgeCommandError {
  return new BridgeCommandError("stale-target", BRIDGE_ERROR_CODES.staleTarget, message, data);
}

export function explicitReject(message: string, data?: unknown): BridgeCommandError {
  return new BridgeCommandError("explicit-reject", BRIDGE_ERROR_CODES.explicitReject, message, data);
}

export function unknownOutcome(message: string, data?: unknown): BridgeCommandError {
  return new BridgeCommandError("unknown-outcome", BRIDGE_ERROR_CODES.unknownOutcome, message, data);
}

export function authRequired(message: string, data?: unknown): BridgeCommandError {
  return new BridgeCommandError("auth", BRIDGE_ERROR_CODES.auth, message, data);
}
