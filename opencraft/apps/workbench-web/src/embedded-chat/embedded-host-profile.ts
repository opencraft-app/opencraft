import type { HostConnectionProfile } from "@opencraft/workbench-runtime";

export interface EmbeddedHostProfileOptions {
  readonly accountId?: string;
  readonly instanceId: string;
  readonly region: "cn" | "intl";
}

export function embeddedHostProfile(options: EmbeddedHostProfileOptions): HostConnectionProfile {
  const instanceId = options.instanceId.trim();
  const accountId = options.accountId?.trim();
  if (!instanceId || !/^[a-zA-Z0-9_-]+$/u.test(instanceId)) {
    throw new TypeError("Embedded Chat requires a valid LightVela instance ID");
  }
  if (options.region !== "cn" && options.region !== "intl") {
    throw new TypeError("Embedded Chat requires a valid LightVela region");
  }
  return Object.freeze({
    hostId: `lightvela-embed:${instanceId}`,
    displayName: "LightVela Hermes",
    providerId: "lightvela.hermes",
    providerConfig: Object.freeze({
      instanceId,
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
