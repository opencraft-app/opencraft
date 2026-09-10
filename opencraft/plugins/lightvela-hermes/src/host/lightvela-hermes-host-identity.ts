export const LIGHTVELA_HERMES_HOST_ID = "velahermes0";

export const LIGHTVELA_HOST_BINDING_EXTENSION = "lightvela/host-binding";

export interface LightVelaHostBindingCapability {
  readonly version: 1;
  readonly instanceId: string;
}

export function parseLightVelaHostBindingCapability(
  value: unknown,
): LightVelaHostBindingCapability | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.instanceId !== "string") return null;
  const instanceId = candidate.instanceId.trim();
  return instanceId === "" ? null : { version: 1, instanceId };
}
