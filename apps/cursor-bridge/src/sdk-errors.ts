import { AuthenticationError, ConfigurationError, RateLimitError, AgentBusyError } from "@cursor/sdk";
import type { BridgeErrorKind } from "@opencraft/agent-bridge-protocol";

/** Only pre-execution creation/catalog refusals are safe to classify as not sent. */
export function sdkErrorKind(method: string, error: unknown): BridgeErrorKind {
  if (!["create", "models", "auth"].includes(method)) return "unknown-outcome";
  if (error instanceof AuthenticationError) return "auth";
  if (error instanceof RateLimitError) return "quota";
  if (error instanceof ConfigurationError) return "invalid";
  if (error instanceof AgentBusyError) return "explicit-reject";
  return "unknown-outcome";
}
