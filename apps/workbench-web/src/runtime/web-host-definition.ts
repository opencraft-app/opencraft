import type { HostRuntimeDescriptor } from "@opencraft/workbench-runtime";
import { serverUrl } from "./server-context";

export interface WebHostDefinition extends HostRuntimeDescriptor {
  readonly url: string;
  readonly appHost?: true;
}

export function endpointLabel(url: string): string {
  try {
    return new URL(url, window.location.href).host;
  } catch {
    return url;
  }
}

export const hostKinds = new Set<HostRuntimeDescriptor["kind"]>([
  "local",
  "remote-ssh",
  "durable",
  "remote-control",
  "wsl",
]);

export function parseWebHostDefinitions(raw: string | undefined): readonly WebHostDefinition[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("VITE_APPSERVER_HOSTS_JSON must be valid JSON");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("VITE_APPSERVER_HOSTS_JSON must contain at least one Host");
  }
  const ids = new Set<string>();
  return value.map((candidate, index): WebHostDefinition => {
    if (typeof candidate !== "object" || candidate === null) {
      throw new Error(`Host definition ${index} must be an object`);
    }
    const record = candidate as Record<string, unknown>;
    const hostId = typeof record.hostId === "string" ? record.hostId.trim() : "";
    const label = typeof record.label === "string" ? record.label.trim() : "";
    const url = typeof record.url === "string" ? record.url.trim() : "";
    const kind = record.kind;
    const transportEndpoint =
      typeof record.transportEndpoint === "string" && record.transportEndpoint.trim().length > 0
        ? record.transportEndpoint.trim()
        : endpointLabel(url);
    const executionLocation =
      typeof record.executionLocation === "string" && record.executionLocation.trim().length > 0
        ? record.executionLocation.trim()
        : null;
    const workspaceBrowseRoots = Array.isArray(record.workspaceBrowseRoots)
      ? record.workspaceBrowseRoots.flatMap((root) =>
          typeof root === "string" && root.trim().length > 0 ? [root.trim()] : [],
        )
      : [];
    if (hostId.length === 0 || label.length === 0 || url.length === 0) {
      throw new Error(`Host definition ${index} requires hostId, label and url`);
    }
    if (record.appHost !== undefined && (record.appHost !== true || url !== "/apphost"))
      throw new Error(`Host definition ${hostId} requires the same-origin /apphost endpoint for AppHost`);
    const parsedUrl = new URL(serverUrl(url), window.location.href);
    const sameOriginPath = url.startsWith("/") && !url.startsWith("//");
    if (sameOriginPath) {
      parsedUrl.protocol = parsedUrl.protocol === "https:" ? "wss:" : "ws:";
    }
    if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
      throw new Error(`Host definition ${hostId} must use ws: or wss:`);
    }
    if (parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
      throw new Error(`Host definition ${hostId} must not embed credentials in its URL`);
    }
    if (ids.has(hostId)) throw new Error(`Duplicate Host definition ${hostId}`);
    ids.add(hostId);
    if (typeof kind !== "string" || !hostKinds.has(kind as HostRuntimeDescriptor["kind"])) {
      throw new Error(`Host definition ${hostId} has an unsupported kind`);
    }
    return {
      hostId,
      label,
      transportEndpoint,
      executionLocation,
      workspaceBrowseRoots,
      url: sameOriginPath ? parsedUrl.href : url,
      ...(record.appHost === true ? { appHost: true } : {}),
      kind: kind as HostRuntimeDescriptor["kind"],
    };
  });
}
