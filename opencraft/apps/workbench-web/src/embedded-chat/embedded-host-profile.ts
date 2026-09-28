import type { HostConnectionProfile } from "@opencraft/workbench-runtime";

export interface EmbeddedHostProfileOptions {
  readonly accountId?: string;
  readonly instanceId: string;
  readonly profileId: string;
  readonly region: "cn" | "intl";
}

export function embeddedHostProfile(options: EmbeddedHostProfileOptions): HostConnectionProfile {
  const instanceId = options.instanceId.trim();
  const profileId = options.profileId.trim();
  const accountId = options.accountId?.trim();
  if (!instanceId || !/^[a-zA-Z0-9_-]+$/u.test(instanceId)) {
    throw new TypeError("Embedded Chat requires a valid LightVela instance ID");
  }
  if (options.region !== "cn" && options.region !== "intl") {
    throw new TypeError("Embedded Chat requires a valid LightVela region");
  }
  if (!profileId || profileId.length > 128 || /[\u0000-\u001f\u007f]/u.test(profileId)) {
    throw new TypeError("Embedded Chat requires a valid LightVela profile ID");
  }
  return Object.freeze({
    hostId: `lightvela-embed:${instanceId}:profile:${encodeURIComponent(profileId)}`,
    displayName: "LightVela Hermes",
    providerId: "lightvela.hermes",
    providerConfig: Object.freeze({
      instanceId,
      profileId,
      region: options.region,
      ...(accountId ? { accountId } : {}),
    }),
    providerConfigVersion: 1,
    hostKind: "remote-control",
    enabled: true,
    autoConnect: false,
    includeInSidebar: false,
    credentialRef: "lightvela.browser-session",
    transportEndpoint: "LightVela",
    executionLocation: "LightVela",
    workspaceBrowseRoots: Object.freeze([]),
    revision: 0,
  });
}
