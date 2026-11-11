/**
 * ACP permission requests -> the existing approval interaction channel.
 *
 * ACP advertises opaque option ids; the bridge maps the human decision
 * (`accept`/`decline` or an explicit option id) and never invents an option.
 * Auto-approval is limited to the requested permission mode, and is recorded
 * in the interaction payload so a later UI cannot present it as a human grant.
 */

import { randomUUID } from "node:crypto";
import type { AcpNativeToolCall } from "./dialect";
import type { AcpPermissionPlan, PermissionApprovalPolicy } from "./dialect";
import type { OpenCraftPermissionMode } from "./profile";

export interface AcpPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface AcpPermissionRequest {
  readonly sessionId: string;
  readonly toolCall: AcpNativeToolCall;
  readonly options: readonly AcpPermissionOption[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const OPTION_KINDS = ["allow_once", "allow_always", "reject_once", "reject_always"] as const;

export function parsePermissionRequest(params: Record<string, unknown>): AcpPermissionRequest {
  if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
    throw new Error("session/request_permission needs sessionId");
  }
  if (!Array.isArray(params.options)) throw new Error("session/request_permission needs options");
  const options: AcpPermissionOption[] = [];
  for (const raw of params.options) {
    if (!isRecord(raw) || typeof raw.optionId !== "string" || typeof raw.name !== "string"
      || !(OPTION_KINDS as readonly string[]).includes(String(raw.kind))) {
      throw new Error("session/request_permission has an invalid option");
    }
    options.push({
      optionId: raw.optionId,
      name: raw.name,
      kind: raw.kind as AcpPermissionOption["kind"],
    });
  }
  if (options.length === 0) throw new Error("session/request_permission has no options");
  const rawCall = isRecord(params.toolCall) ? params.toolCall : {};
  const toolCall: AcpNativeToolCall = {
    ...(typeof rawCall.toolCallId === "string" ? { toolCallId: rawCall.toolCallId } : {}),
    ...(typeof rawCall.title === "string" ? { title: rawCall.title } : {}),
    ...(typeof rawCall.kind === "string" ? { kind: rawCall.kind } : {}),
    ...("rawInput" in rawCall ? { rawInput: rawCall.rawInput } : {}),
    ...("rawOutput" in rawCall ? { rawOutput: rawCall.rawOutput } : {}),
    ...(Array.isArray(rawCall.locations) ? { locations: rawCall.locations } : {}),
  };
  return { sessionId: params.sessionId, toolCall, options };
}

export type PermissionDecision =
  | { readonly kind: "option"; readonly optionId: string }
  | { readonly kind: "cancel" };

export function chooseOption(
  options: readonly AcpPermissionOption[],
  decision: "allow" | "deny",
): PermissionDecision {
  const wanted = decision === "allow"
    ? (["allow_once", "allow_always"] as const)
    : (["reject_once", "reject_always"] as const);
  for (const kind of wanted) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option !== undefined) return { kind: "option", optionId: option.optionId };
  }
  return { kind: "cancel" };
}

function toolKind(toolCall: AcpNativeToolCall): string {
  return toolCall.kind ?? "other";
}

/** A policy may decide without a human only when the tool class is explicit. */
export function policyDecision(
  policy: PermissionApprovalPolicy,
  request: AcpPermissionRequest,
): "allow" | "deny" | "ask" {
  if (policy === "auto-allow") return "allow";
  if (policy === "route") return "ask";
  const kind = toolKind(request.toolCall);
  if (policy === "read-only") {
    return ["read", "search", "fetch", "think"].includes(kind) ? "allow" : "deny";
  }
  if (policy === "accept-edits") {
    return ["edit", "delete", "move"].includes(kind) ? "allow" : "ask";
  }
  return "ask";
}

export interface ApprovalPayload {
  readonly method: "item/commandExecution/requestApproval";
  readonly params: Record<string, unknown>;
  readonly native: Record<string, unknown>;
}

export function approvalPayload(input: {
  readonly threadId: string;
  readonly interactionId: string;
  readonly requested: AcpPermissionRequest;
  readonly mode: OpenCraftPermissionMode;
  readonly plan: AcpPermissionPlan;
  readonly nativeTurnId: string | null;
  readonly cwd: string;
  readonly startedAtMs: number;
}): ApprovalPayload {
  const call = input.requested.toolCall;
  const rawInput = isRecord(call.rawInput) ? call.rawInput : {};
  const command = typeof rawInput.command === "string" ? rawInput.command : null;
  const title = call.title ?? (typeof rawInput.tool === "string" ? rawInput.tool : "tool");
  return {
    method: "item/commandExecution/requestApproval",
    params: {
      kind: "command",
      threadId: input.threadId,
      turnId: input.nativeTurnId ?? "acp-idle",
      itemId: `acp-tool:${input.requested.sessionId}:${call.toolCallId ?? input.interactionId}`,
      startedAtMs: input.startedAtMs,
      approvalId: input.interactionId,
      environmentId: null,
      reason: `Allow ${title}?`,
      command,
      cwd: input.cwd,
      availableDecisions: ["accept", "decline"],
    },
    native: {
      sessionId: input.requested.sessionId,
      toolCallId: call.toolCallId ?? null,
      toolKind: call.kind ?? null,
      options: input.requested.options,
      permissionMode: input.mode,
      permissionPolicy: input.plan.approvalPolicy,
      permissionDetail: input.plan.detail,
    },
  };
}

/**
 * Normalize a human response. An explicit ACP option id wins; otherwise the
 * existing AppServer decision vocabulary maps to the first matching option.
 */
export function resolvePermission(
  options: readonly AcpPermissionOption[],
  result: Record<string, unknown>,
): PermissionDecision {
  if (typeof result.optionId === "string") {
    return options.some((option) => option.optionId === result.optionId)
      ? { kind: "option", optionId: result.optionId }
      : { kind: "cancel" };
  }
  const decision = result.decision;
  if (decision === "accept" || decision === "allow") {
    return chooseOption(options, "allow");
  }
  if (decision === "acceptForSession") {
    const always = options.find((option) => option.kind === "allow_always")
      ?? options.find((option) => option.kind === "allow_once");
    return always === undefined ? { kind: "cancel" } : { kind: "option", optionId: always.optionId };
  }
  if (decision === "cancel") return { kind: "cancel" };
  if (decision === "decline" || decision === "deny") {
    return chooseOption(options, "deny");
  }
  return { kind: "cancel" };
}

export function newInteractionId(): string {
  return `acp-approval:${randomUUID()}`;
}
