/**
 * Static provider profile for one installed ACP agent.
 *
 * A profile is the *registered upper bound*: it is compiled into a pinned
 * bridge artifact and must not widen at runtime. The `initialize` probe may
 * only narrow the returned capabilities. There is deliberately no per-process
 * `steerMode`: whether native injection exists is a probed fact, and every
 * input records the path it actually took.
 *
 * The profile is supplied through the launcher environment (not the bridge
 * command line) so the same artifact can serve a Copilot generation, an Amp
 * generation or a deterministic fixture.
 */

import type { BridgeDeclaration, DeliveryMethod } from "@opencraft/agent-bridge-protocol";
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_GRAMMAR_RANGE } from "@opencraft/agent-bridge-protocol";

export type AcpDialectId = "generic" | "amp" | "copilot";
/** Mirrors the four product modes; the provider bridge has no client-protocol dependency. */
export type OpenCraftPermissionMode = "read-only" | "accept-edits" | "auto" | "full";

export interface AcpAgentLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface AcpProfile {
  readonly providerId: string;
  readonly dialect: AcpDialectId;
  readonly minNativeVersion: string;
  readonly probeBasis: string;
  readonly agent: AcpAgentLaunch;
  readonly defaultPermissionMode: OpenCraftPermissionMode;
  /** Copilot model id, Amp mode key or a generic config-option model value. */
  readonly modelSelection?: string;
}

const PERMISSION_MODES: readonly OpenCraftPermissionMode[] = ["read-only", "accept-edits", "auto", "full"];

export function isPermissionMode(value: unknown): value is OpenCraftPermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function isDialectId(value: unknown): value is AcpDialectId {
  return value === "generic" || value === "amp" || value === "copilot";
}

function jsonArray(value: string | undefined, field: string): string[] {
  if (value === undefined || value.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${field} must be a JSON array of strings`);
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`${field} must be a JSON array of strings`);
  }
  return parsed;
}

export function profileFromEnv(env: NodeJS.ProcessEnv = process.env): AcpProfile {
  const command = env.AGENT_BRIDGE_ACP_COMMAND;
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("AGENT_BRIDGE_ACP_COMMAND is required");
  }
  const dialectValue = env.AGENT_BRIDGE_ACP_DIALECT ?? "generic";
  if (!isDialectId(dialectValue)) throw new Error(`Unknown ACP dialect ${dialectValue}`);
  const modeValue = env.AGENT_BRIDGE_ACP_PERMISSION_MODE ?? "accept-edits";
  if (!isPermissionMode(modeValue)) throw new Error(`Unknown permission mode ${modeValue}`);
  const modelSelection = env.AGENT_BRIDGE_ACP_MODEL;
  return {
    providerId: env.AGENT_BRIDGE_ACP_PROVIDER ?? (dialectValue === "generic" ? "acp" : dialectValue),
    dialect: dialectValue,
    minNativeVersion: env.AGENT_BRIDGE_ACP_MIN_VERSION ?? "1",
    probeBasis: env.AGENT_BRIDGE_ACP_PROBE_BASIS ?? "ACP initialize result from the installed agent",
    agent: {
      command,
      args: jsonArray(env.AGENT_BRIDGE_ACP_ARGS, "AGENT_BRIDGE_ACP_ARGS"),
      cwd: env.AGENT_BRIDGE_ACP_CWD ?? process.cwd(),
      ...(env.AGENT_BRIDGE_ACP_ENV === undefined
        ? {}
        : { env: JSON.parse(env.AGENT_BRIDGE_ACP_ENV) as Record<string, string> }),
    },
    defaultPermissionMode: modeValue,
    ...(modelSelection !== undefined && modelSelection.length > 0 ? { modelSelection } : {}),
  };
}

function staticDeliveryMethods(profile: AcpProfile): DeliveryMethod[] {
  // Native injection is only ever an upper bound for dialects that have a
  // known native path; the initialize probe removes it when the agent does not
  // declare `_meta.midTurnSteering`. Copilot currently has no local native path.
  return profile.dialect === "copilot"
    ? ["next-turn", "interrupt-replace"]
    : ["native-inject", "next-turn", "interrupt-replace"];
}

/** Build the immutable registration declaration for a profile. */
export function declarationFor(profile: AcpProfile): BridgeDeclaration {
  return {
    providerId: profile.providerId,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    grammarRange: BRIDGE_GRAMMAR_RANGE,
    // The ACP adapter owns the permission decision and routes undecided
    // requests to the existing interaction channel; the Host never grants.
    approvalExecutor: "provider",
    capabilities: {
      model: false,
      reasoning: false,
      history: false,
      usage: false,
      approval: true,
      inputContentTypes: ["text", "image"],
      cliExecutable: false,
      forkCheckpoint: false,
      skills: false,
      installation: false,
      steer: {
        deliveryMethods: staticDeliveryMethods(profile),
        // ACP has no stable per-input native id, so text echo cannot identify
        // which prompt produced it. Only the native admission is recorded.
        evidenceKinds: ["admission"],
        withdrawal: "before-dispatch",
        contentLimits: {
          maxBytes: 360 * 1024,
          allowedContentTypes: ["text", "image"],
        },
        maxPendingWithoutNativeId: 1,
        fallbackPolicy: "reject-unknown",
      },
    },
    minNativeVersion: profile.minNativeVersion,
    probeBasis: profile.probeBasis,
  };
}
