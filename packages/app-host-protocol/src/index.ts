export { APP_HOST_PROTOCOL_VERSION } from "./version.mjs";
import { APP_HOST_PROTOCOL_VERSION } from "./version.mjs";
import { LOGICAL_CLIENT_FIELD } from "./routing.mjs";
export { LOGICAL_CLIENT_FIELD } from "./routing.mjs";
export type SshManagementAccessMode = "shared" | "access-key";
export interface SshManagementSessionView {
  readonly available: true;
  readonly authenticated: boolean;
  readonly accessMode: SshManagementAccessMode;
  /** Origin bound to the selected grant; absent on legacy backends. */
  readonly authenticatedOrigin?: string;
}
export function parseSshManagementSessionView(value: unknown): SshManagementSessionView {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("available" in value) || value.available !== true
    || !("authenticated" in value) || typeof value.authenticated !== "boolean") throw new Error("Invalid SSH management session");
  // Legacy backends require a key. Missing/invalid metadata never opts in.
  const mode = "accessMode" in value ? value.accessMode : "access-key";
  if (mode !== "shared" && mode !== "access-key") throw new Error("Invalid SSH management access mode");
  const origin = "authenticatedOrigin" in value ? value.authenticatedOrigin : undefined;
  if (origin !== undefined) {
    if (typeof origin !== "string") throw new Error("Invalid SSH management origin");
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new Error("Invalid SSH management origin");
  }
  return { available: true, authenticated: value.authenticated, accessMode: mode, ...(origin === undefined ? {} : { authenticatedOrigin: origin as string }) };
}
/** Public projection only. No endpoint, shell, credential or trust controls. */
export interface SshServerDescriptor {
  readonly serverId: string;
  readonly displayName: string;
  readonly workspaceBrowseRoots: readonly string[];
}
export function parseSshServerDescriptors(value: unknown): readonly SshServerDescriptor[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Invalid remote Server catalog");
  const ids = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid remote Server descriptor");
    const { serverId, displayName, workspaceBrowseRoots } = entry;
    if (typeof serverId !== "string" || !/^ssh:[a-zA-Z0-9._-]{1,80}$/u.test(serverId) || ids.has(serverId)
      || typeof displayName !== "string" || !displayName.trim() || displayName.length > 100
      || !Array.isArray(workspaceBrowseRoots) || workspaceBrowseRoots.length > 16 || workspaceBrowseRoots.some(root => typeof root !== "string" || !root.startsWith("/"))) throw new Error("Invalid remote Server descriptor");
    ids.add(serverId);
    return { serverId, displayName, workspaceBrowseRoots };
  });
}
/** Authenticated management projection. Deliberately excludes all secrets and backend paths. */
export interface SshConnectionView extends SshServerDescriptor {
  readonly revision: number;
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly enabled: boolean;
  readonly fingerprint: string;
  readonly state: "idle" | "connecting" | "open" | "closing" | "closed" | "failed" | "disabled";
}
export interface SshConnectionEdit {
  readonly displayName: string;
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly enabled: boolean;
  readonly workspaceBrowseRoots: readonly string[];
  /** Write-only; empty/omitted preserves the saved credential. Never in a View. */
  readonly password?: string;
}
export function parseSshConnectionViews(value: unknown): readonly SshConnectionView[] {
  const descriptors = parseSshServerDescriptors(value);
  return descriptors.map((descriptor, index) => {
    const row = (value as Record<string, unknown>[])[index]!;
    if (Object.keys(row).some(k => !["serverId", "displayName", "workspaceBrowseRoots", "revision", "hostname", "port", "username", "enabled", "fingerprint", "state"].includes(k))
      || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1
      || typeof row.hostname !== "string" || row.hostname.length > 253 || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/u.test(row.hostname)
      || typeof row.username !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/u.test(row.username)
      || !Number.isInteger(row.port) || Number(row.port) < 1 || Number(row.port) > 65535
      || typeof row.enabled !== "boolean" || typeof row.fingerprint !== "string" || !/^SHA256:[a-zA-Z0-9+/]{43}$/u.test(row.fingerprint)
      || typeof row.state !== "string" || !["idle", "connecting", "open", "closing", "closed", "failed", "disabled"].includes(row.state)) throw new Error("Invalid remote connection projection");
    return { ...descriptor, revision: Number(row.revision), hostname: row.hostname, port: Number(row.port), username: row.username,
      enabled: row.enabled, fingerprint: row.fingerprint, state: row.state as SshConnectionView["state"] };
  });
}
export function stampLogicalClientFrame(frame: string, clientId: string): string {
  const value = JSON.parse(frame);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid logical RPC frame");
  return JSON.stringify({ ...value, [LOGICAL_CLIENT_FIELD]: clientId });
}
export function routeLogicalClientFrame(frame: string, clientIds: readonly string[]): string | null {
  const value = JSON.parse(frame);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid logical RPC frame");
  const target = value[LOGICAL_CLIENT_FIELD];
  if (target === undefined) return frame;
  if (typeof target !== "string" || !clientIds.includes(target)) return null;
  delete value[LOGICAL_CLIENT_FIELD]; return JSON.stringify(value);
}
export const CONNECT_APP_HOST_MESSAGE = "opencraft:connect-app-host" as const;

export type AppHostTransportState =
  | "idle"
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | "failed";

export interface AppHostErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ConnectAppHostMessage {
  readonly type: typeof CONNECT_APP_HOST_MESSAGE;
  readonly protocolVersion: typeof APP_HOST_PROTOCOL_VERSION;
  /** Version-1 wire name for a logical Client incarnation, not a rendering surface identity. */
  readonly rendererId: string;
}

export type RendererToAppHostMessage =
  | { readonly type: "connection/probe"; readonly requestId: string }
  | {
      readonly type: "hello";
      readonly protocolVersion: typeof APP_HOST_PROTOCOL_VERSION;
      /** Version-1 wire name for a logical Client incarnation. */
      readonly rendererId: string;
    }
  | {
      readonly type: "host/connect";
      readonly requestId: string;
      readonly hostId: string;
      readonly leaseId: string;
    }
  | {
      readonly type: "host/send";
      readonly requestId: string;
      readonly hostId: string;
      readonly leaseId: string;
      readonly generation: number;
      readonly frame: string;
    }
  | {
      readonly type: "host/disconnect";
      readonly requestId: string;
      readonly hostId: string;
      readonly leaseId: string;
      readonly generation: number;
    };

export type AppHostToRendererMessage =
  | {
      readonly type: "ready";
      readonly protocolVersion: typeof APP_HOST_PROTOCOL_VERSION;
      readonly connectionId: string;
      readonly services: readonly ["appserver"];
      readonly capabilities?: { readonly connectionProbe?: boolean };
    }
  | {
      readonly type: "fatal";
      readonly error: AppHostErrorPayload;
    }
  | {
      readonly type: "response";
      readonly requestId: string;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly type: "response";
      readonly requestId: string;
      readonly ok: false;
      readonly error: AppHostErrorPayload;
    }
  | {
      readonly type: "host/status";
      readonly hostId: string;
      readonly generation: number;
      readonly status: {
        readonly state: AppHostTransportState;
        readonly reason?: string;
        readonly failure?: { readonly code: string; readonly recovery: "automatic" | "manual" };
      };
    }
  | {
      readonly type: "host/frame";
      readonly hostId: string;
      readonly generation: number;
      /** Targeted logical traffic belongs to exactly one admitted lease. */
      readonly leaseId?: string;
      readonly frame: string;
    };

export interface AppHostConnectResult {
  readonly hostId: string;
  readonly generation: number;
}

export function isConnectAppHostMessage(value: unknown): value is ConnectAppHostMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === CONNECT_APP_HOST_MESSAGE
    && record.protocolVersion === APP_HOST_PROTOCOL_VERSION
    && typeof record.rendererId === "string"
    && record.rendererId.length > 0;
}
export * from "./native-speech.js";
