import { SandboxFault } from "./contract.js";
import { isSandboxEndpointName, type SandboxEndpointName } from "./endpoint.js";

/** Workspace and environment addresses. URIs exist only at configuration and
 * client-facing boundaries: they are parsed here into typed values, and the
 * owners pass those values on. They never carry credentials, tokens, ports,
 * queries or fragments; secrets travel through their own channels.
 *
 * - `workspace://<workspaceId>/endpoints/<name>` names an endpoint published by a
 *   workspace's `workspace-agent`. The name is one of SANDBOX_ENDPOINT_NAMES. A
 *   client holds only this URI; which environment and which transport serve it
 *   is decided by the workspace composition and its provider.
 * - `<provider>://<target>` selects where a workspace environment runs: the scheme
 *   is a registered provider id (`static-docker`, `e2b`, later
 *   `docker-provisioner`, `cloudflare`) and the target is that provider's opaque
 *   selector (Compose service, template, container class). Changing deployment
 *   form is changing this one value.
 *
 * Grammar is deliberately narrower than RFC 3986: lowercase ASCII schemes, no
 * percent-encoding, no userinfo (`@`), no port, query or fragment, no empty or
 * dot segments. Exactly one spelling exists per value, so format(parse(x)) === x. */

const fault = (message: string) => new SandboxFault("SANDBOX_POLICY", message);

/** A workspace identity in URIs and receipts: `default` today, opaque ids later. */
export const WORKSPACE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
/** Provider ids double as URI schemes; same rule as provider registration. */
export const SANDBOX_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,22}$/u;
/** A provider target: segments of `[A-Za-z0-9._:-]`, `/`-separated, ≤200 bytes. */
const TARGET_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*$/u;
/** Schemes this repository already uses for other identities; never providers. */
const RESERVED_SCHEMES = new Set(["workspace", "unix", "stdio", "ws", "wss", "http", "https", "file", "data",
  "human", "session", "actor-registry", "opencraft", "ui", "skill", "resource"]);

export interface WorkspaceEndpointAddress {
  readonly workspaceId: string;
  readonly name: SandboxEndpointName;
}
export interface SandboxEnvironmentAddress {
  /** Registered provider id (the URI scheme). */
  readonly provider: string;
  /** Provider-owned selector, validated again by the provider definition. */
  readonly target: string;
}

const WORKSPACE_PREFIX = "workspace://";

export function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_ID_PATTERN.test(value);
}

/** Parses `workspace://<workspaceId>/endpoints/<name>`; anything else is SANDBOX_POLICY. */
export function parseWorkspaceEndpointUri(value: unknown): WorkspaceEndpointAddress {
  if (typeof value !== "string" || value.length > 128 || !value.startsWith(WORKSPACE_PREFIX))
    throw fault("Workspace endpoint URI must use workspace://");
  const parts = value.slice(WORKSPACE_PREFIX.length).split("/");
  if (parts.length !== 3 || parts[1] !== "endpoints" || !isWorkspaceId(parts[0]) || !isSandboxEndpointName(parts[2]))
    throw fault("Invalid workspace endpoint URI");
  return Object.freeze({ workspaceId: parts[0]!, name: parts[2] as SandboxEndpointName });
}

export function formatWorkspaceEndpointUri(address: WorkspaceEndpointAddress): string {
  if (!isWorkspaceId(address?.workspaceId) || !isSandboxEndpointName(address.name)) throw fault("Invalid workspace endpoint");
  return `${WORKSPACE_PREFIX}${address.workspaceId}/endpoints/${address.name}`;
}

/** Parses `<provider>://<target>`. The provider must still be registered and accept
 * the target (`resolveSandboxEnvironment`); this only enforces the shared grammar. */
export function parseSandboxEnvironmentUri(value: unknown): SandboxEnvironmentAddress {
  if (typeof value !== "string" || value.length > 256) throw fault("Invalid sandbox environment URI");
  const at = value.indexOf("://");
  const provider = at > 0 ? value.slice(0, at) : "";
  const target = at > 0 ? value.slice(at + 3) : "";
  if (!SANDBOX_PROVIDER_ID_PATTERN.test(provider) || RESERVED_SCHEMES.has(provider))
    throw fault("Sandbox environment URI has no provider scheme");
  if (!TARGET_PATTERN.test(target) || new TextEncoder().encode(target).byteLength > 200
    || target.split("/").some(segment => segment === "." || segment === ".."))
    throw fault("Invalid sandbox environment target");
  return Object.freeze({ provider, target });
}

export function formatSandboxEnvironmentUri(address: SandboxEnvironmentAddress): string {
  const value = `${address?.provider}://${address?.target}`;
  parseSandboxEnvironmentUri(value);
  return value;
}

/** Parses a whitespace- or comma-separated list of environment URIs (deployment
 * configuration). Duplicates and an empty list are rejected. */
export function parseSandboxEnvironmentUris(value: unknown): readonly SandboxEnvironmentAddress[] {
  if (typeof value !== "string") throw fault("Sandbox environment list must be a string");
  const items = value.split(/[\s,]+/u).filter(Boolean);
  if (!items.length || items.length > 16 || new Set(items).size !== items.length) throw fault("Invalid sandbox environment list");
  return Object.freeze(items.map(parseSandboxEnvironmentUri));
}
