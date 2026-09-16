const DEFAULT_ENGINE_KIND = "codex";
const DEFAULT_PROVIDER_ID = "openai";

export interface ExecutionCredential {
  accountIdentity?: string | null | undefined;
  userId?: string | null | undefined;
}

export interface ExecutionProfileInput {
  engineKind?: string | null | undefined;
  providerId?: string | null | undefined;
  model?: string | null | undefined;
  credential?: ExecutionCredential | null | undefined;
  actorUserId?: string | null | undefined;
  turnConfig?: Readonly<Record<string, unknown>> | null | undefined;
}

export interface ExecutionProfile {
  readonly engineKind: string;
  readonly providerId: string;
  readonly model: string | null;
  readonly credentialIdentity: string | null;
  readonly actorUserId: string | null;
  readonly turnConfig: Readonly<Record<string, unknown>>;
  readonly fingerprint: string;
}

export interface RuntimeExecutionHint {
  engineKind?: string | null | undefined;
  providerId?: string | null | undefined;
  model?: string | null | undefined;
  accountIdentity?: string | null | undefined;
  ownerUserId?: string | null | undefined;
  nextProviderId?: string | null | undefined;
  nextModel?: string | null | undefined;
  threadSettings?: Readonly<Record<string, unknown>> | null | undefined;
  nextThreadSettings?: Readonly<Record<string, unknown>> | null | undefined;
  [key: string]: unknown;
}

function text(value: unknown, fallback: string | null = null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function component(value: unknown): string {
  return encodeURIComponent(String(value ?? ""));
}

function immutableCopy(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = immutableCopy(item);
  return Object.freeze(result);
}

function immutableRecord(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = immutableCopy(item);
  return Object.freeze(result);
}

/**
 * Immutable description of the engine identity selected for one Turn.
 *
 * A provider/account/model change is deliberately treated as a different
 * engine instance even when both instances happen to use the Codex adapter.
 * Turn-local settings (permissions, effort, service tier) are not part of the
 * runtime identity and remain ordinary turn/start parameters.
 */
export function createExecutionProfile({
  engineKind = DEFAULT_ENGINE_KIND,
  providerId = null,
  model = null,
  credential = null,
  actorUserId = null,
  turnConfig = null,
}: ExecutionProfileInput = {}): ExecutionProfile {
  const profile = {
    engineKind: text(engineKind, DEFAULT_ENGINE_KIND) ?? DEFAULT_ENGINE_KIND,
    providerId: text(providerId, DEFAULT_PROVIDER_ID) ?? DEFAULT_PROVIDER_ID,
    model: text(model),
    credentialIdentity: text(credential?.accountIdentity),
    actorUserId: text(actorUserId ?? credential?.userId),
    turnConfig: immutableRecord(turnConfig ?? {}),
  };
  return Object.freeze({
    ...profile,
    fingerprint: executionProfileFingerprint(profile),
  });
}

export function executionProfileFingerprint(profile: Partial<ExecutionProfile> = {}): string {
  return [
    `engine=${component(text(profile.engineKind, DEFAULT_ENGINE_KIND))}`,
    `provider=${component(text(profile.providerId, DEFAULT_PROVIDER_ID))}`,
    `credential=${component(text(profile.credentialIdentity))}`,
    `actor=${component(text(profile.actorUserId))}`,
    `model=${component(text(profile.model))}`,
  ].join("&");
}

export function executionProfilesCompatible(
  left: Partial<ExecutionProfile> | null | undefined,
  right: Partial<ExecutionProfile> | null | undefined,
): boolean {
  if (!left || !right) return false;
  return (left.fingerprint ?? executionProfileFingerprint(left)) ===
    (right.fingerprint ?? executionProfileFingerprint(right));
}

export function executionProfileFromRuntimeHint(
  runtimeHint: RuntimeExecutionHint | null = null,
): ExecutionProfile | null {
  if (!runtimeHint) return null;
  return createExecutionProfile({
    engineKind: runtimeHint.engineKind,
    providerId: runtimeHint.providerId,
    model: runtimeHint.model,
    credential: { accountIdentity: runtimeHint.accountIdentity },
    actorUserId: runtimeHint.ownerUserId,
  });
}

export function desiredRuntimeHint(
  runtimeHint: RuntimeExecutionHint | null = null,
): RuntimeExecutionHint | null {
  if (!runtimeHint) return null;
  return {
    ...runtimeHint,
    providerId: runtimeHint.nextProviderId !== undefined
      ? runtimeHint.nextProviderId
      : runtimeHint.providerId,
    model: runtimeHint.nextModel !== undefined
      ? runtimeHint.nextModel
      : runtimeHint.model,
    threadSettings: runtimeHint.nextThreadSettings !== undefined
      ? runtimeHint.nextThreadSettings
      : runtimeHint.threadSettings,
  };
}
