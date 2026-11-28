export interface UsageMachineOption {
  readonly hostId: string;
  readonly label: string;
  readonly remote: boolean;
  readonly connected?: boolean;
  readonly detail?: string | null;
}

export interface UsageMachineSourceHost {
  readonly hostId: string;
  readonly kind: string;
  readonly label: string;
}

export interface UsageMachineSourceProfile {
  readonly hostId: string;
  readonly enabled: boolean;
  readonly displayName: string;
  readonly transportEndpoint: string | null;
  readonly executionLocation: string | null;
  readonly machineIdentity?: { readonly name?: string | null } | null;
}

export function sanitizeEndpointDetail(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  const trimmed = endpoint.trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed);
  try {
    const parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    const path =
      parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.replace(/\/+$/u, "") : "";
    return `${parsed.host}${path}` || null;
  } catch {
    return (
      trimmed
        .replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "")
        .replace(/^[^/?#@]+@/u, "")
        .replace(/[?#].*$/u, "")
        .replace(/\/+$/u, "") || null
    );
  }
}

export function buildUsageMachineOptions({
  hosts,
  profiles,
  getPhase,
  localFallbackLabel,
}: {
  readonly hosts: readonly UsageMachineSourceHost[];
  readonly profiles: readonly UsageMachineSourceProfile[];
  readonly getPhase: (hostId: string) => string;
  readonly localFallbackLabel: string;
}): readonly UsageMachineOption[] {
  const items: UsageMachineOption[] = [];
  for (const host of hosts) {
    const profile = profiles.find((entry) => entry.hostId === host.hostId);
    if (profile && !profile.enabled) continue;
    const phase = getPhase(host.hostId);
    const remote = host.kind !== "local";
    const label =
      host.kind === "local"
        ? profile?.machineIdentity?.name || localFallbackLabel
        : profile?.machineIdentity?.name || profile?.displayName || host.label;
    const detail =
      sanitizeEndpointDetail(profile?.transportEndpoint) ||
      profile?.executionLocation ||
      (profile?.displayName && profile.displayName !== label ? profile.displayName : null) ||
      host.hostId;
    items.push({ hostId: host.hostId, label, remote, connected: phase === "ready", detail });
  }
  return items;
}
