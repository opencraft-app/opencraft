import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import type {
  InternalContributionAdapter,
  TrustedExtensionDefinition,
} from "@opencraft/extension-runtime";
import {
  type HostConnectionJson,
  type HostConnectionProvider,
  type HostConnectionProviderRegistrySnapshot,
} from "@opencraft/workbench-runtime";

export interface WebSocketHostConnectionConfig {
  readonly url: string;
  readonly protocols?: string | readonly string[];
}

function validateConfig(config: HostConnectionJson): WebSocketHostConnectionConfig & HostConnectionJson {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new TypeError("WebSocket connection config must be an object");
  }
  const record = config as Readonly<Record<string, HostConnectionJson>>;
  if (typeof record.url !== "string" || record.url.trim().length === 0) {
    throw new TypeError("WebSocket connection requires a URL");
  }
  const rawUrl = record.url.trim();
  if (/^wss?:\/\/(?:https?|wss?):\/\//iu.test(rawUrl)) {
    throw new TypeError("WebSocket connection URL contains more than one protocol prefix");
  }
  let url: URL;
  try {
    // Relative endpoints are intentionally unsupported: a Host profile must
    // retain one explicit physical endpoint across routes and reloads.
    url = new URL(rawUrl);
  } catch {
    throw new TypeError("WebSocket connection URL must be an absolute ws: or wss: URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("WebSocket connection URL must use ws: or wss:");
  }
  if (new URL(window.location.href).protocol === "https:" && url.protocol !== "wss:") {
    throw new TypeError("An HTTPS workbench requires a secure wss: connection");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError("WebSocket credentials must not be embedded in the URL");
  }
  const rawProtocols = record.protocols;
  let protocols: string | readonly string[] | undefined;
  if (typeof rawProtocols === "string") {
    protocols = rawProtocols.trim();
  } else if (Array.isArray(rawProtocols)) {
    protocols = rawProtocols.map((entry) => {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new TypeError("WebSocket subprotocols must be non-empty strings");
      }
      return entry.trim();
    });
  } else if (rawProtocols !== undefined) {
    throw new TypeError("WebSocket protocols must be a string or array of strings");
  }
  return Object.freeze({
    url: url.href,
    ...(protocols === undefined ? {} : { protocols }),
  }) as WebSocketHostConnectionConfig & HostConnectionJson;
}

// Activation and transport acquisition describe the same supported hosts.
const WEBSOCKET_HOST_PLATFORMS = ["web", "electron"] as const;

export const WebSocketHostConnectionProvider: HostConnectionProvider = {
  id: "vela.websocket",
  label: "WebSocket",
  targets: WEBSOCKET_HOST_PLATFORMS,
  configVersion: 1,
  validate: validateConfig,
  createTransport(config) {
    const validated = validateConfig(config);
    const protocols = validated.protocols;
    return new WebSocketTransport({
      url: validated.url,
      protocols: protocols === undefined
        ? undefined
        : typeof protocols === "string"
          ? protocols
          : [...protocols],
    });
  },
};

export function createHostConnectionProviderContributionAdapter(
  providers: {
    getSnapshot(): HostConnectionProviderRegistrySnapshot;
    register(ownerId: string, provider: HostConnectionProvider): () => Promise<void>;
  },
): InternalContributionAdapter {
  return {
    prepare(owner, value) {
      if (typeof value !== "object" || value === null || !("id" in value)) {
        throw new TypeError("Host connection provider contribution must be a provider object");
      }
      const provider = value as HostConnectionProvider;
      if (providers.getSnapshot().providers.some(({ id }) => id === provider.id)) {
        throw new Error(`Connection provider ${provider.id} is already registered`);
      }
      return {
        commit: () => providers.register(owner.activationId, provider),
      };
    },
  };
}

/** First real built-in extension; provider lifetime is owned by its activation. */
export const BuiltinWebSocketHostConnectionExtension: TrustedExtensionDefinition = {
  manifest: {
    manifestVersion: 1,
    id: "vela.websocket-host",
    name: "WebSocket Host",
    description: "Connects browser and Electron workbenches to an AppServer WebSocket endpoint.",
    version: "1.0.0",
    apiVersion: 1,
    trust: "trusted",
    platforms: WEBSOCKET_HOST_PLATFORMS,
    activationEvents: ["onStartupFinished"],
  },
  activate(api) {
    api.internal.register("hostConnectionProvider", WebSocketHostConnectionProvider);
  },
};
