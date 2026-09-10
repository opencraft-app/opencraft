import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import {
  HOST_PROFILE_CONTRIBUTION_CHANNEL,
  type HostConnectionJson,
  type HostConnectionProfile,
  type HostConnectionProvider,
} from "@opencraft/workbench-runtime";

export interface HyperNodeExtensionOptions {
  readonly hostId?: string;
  readonly label?: string;
  readonly url: string;
  readonly workspaceBrowseRoots?: readonly string[];
}

interface HyperNodeConnectionConfig extends Readonly<Record<string, HostConnectionJson>> {
  readonly url: string;
}

function parseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("HyperNode endpoint must use ws: or wss:");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError("HyperNode endpoint must not embed credentials");
  }
  return url.href;
}

function validateConfig(value: HostConnectionJson): HyperNodeConnectionConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("HyperNode connection config must be an object");
  }
  const url = (value as Readonly<Record<string, HostConnectionJson>>).url;
  if (typeof url !== "string") throw new TypeError("HyperNode connection requires a URL");
  return Object.freeze({ url: parseUrl(url) });
}

export const HyperNodeHostConnectionProvider: HostConnectionProvider = Object.freeze({
  id: "vela.hypernode",
  label: "HyperNode",
  targets: ["web", "electron"] as const,
  configVersion: 1,
  validate: validateConfig,
  createTransport(config: HostConnectionJson) {
    return new WebSocketTransport({ url: validateConfig(config).url });
  },
});

export function createHyperNodeExtension(options: HyperNodeExtensionOptions): TrustedExtensionDefinition {
  const url = parseUrl(options.url);
  const parsed = new URL(url);
  const hostId = options.hostId?.trim() || "hypernode";
  const label = options.label?.trim() || "HyperNode";
  const profile: HostConnectionProfile = Object.freeze({
    hostId,
    displayName: label,
    providerId: HyperNodeHostConnectionProvider.id,
    providerConfig: Object.freeze({ url }),
    providerConfigVersion: HyperNodeHostConnectionProvider.configVersion,
    hostKind: "remote-control",
    enabled: true,
    autoConnect: false,
    includeInSidebar: true,
    credentialRef: null,
    transportEndpoint: parsed.host,
    executionLocation: "HyperNode",
    workspaceBrowseRoots: Object.freeze([...(options.workspaceBrowseRoots ?? ["/workspace/projects"])]),
    revision: 0,
  });
  return {
    manifest: {
      manifestVersion: 1,
      id: "vela.hypernode",
      name: "HyperNode",
      description: "Connects OpenCraft to the optional HyperNode AppServer host.",
      version: "0.1.0",
      apiVersion: 1,
      trust: "trusted",
      platforms: ["web", "electron"],
      activationEvents: ["onStartupFinished"],
    },
    activate(api) {
      api.internal.register("hostConnectionProvider", HyperNodeHostConnectionProvider);
      api.internal.register(HOST_PROFILE_CONTRIBUTION_CHANNEL, { profile });
    },
  };
}
