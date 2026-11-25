// Binding-only entry points and identity for one admitted browser client.
// The caller's client ID is a routing input. Actor, generation and the exact
// browser login are verified and projected by InstallationCore.
import { APP_HOST_CLIENT_INSTANCE_PARAMETER } from "@opencraft/app-host-protocol/routing";
import type { InstallationCoreNamespace } from "./bindings.js";

/** A private Durable Object binding for the deployment's loaded Client owner. */
export type ClientSocketNamespace = InstallationCoreNamespace;
type InstallationBinding = ReturnType<InstallationCoreNamespace["get"]>;

export const APP_HOST_PATH = "/apphost";
export const CLIENT_ADMISSION_PATH = "/__opencraft_internal/client-admission";
export const CLIENT_CURRENT_PATH = "/__opencraft_internal/client-current";
export const CLIENT_SOCKET_PATH = "/__opencraft_internal/client-socket";
export const CLIENT_ATTACHMENT_HEADER = "opencraft-client-attachment";

export interface ClientAttachment {
  readonly clientInstanceId: string;
  readonly actorId: string;
  readonly actorGeneration: number;
  readonly expiresAt: number;
  /** Non-bearer row reference from HumanAuth. Travels only over private bindings. */
  readonly loginDigest: string;
}

const CLIENT_ID = /^[A-Za-z0-9_-]{16,128}$/u;
const LOGIN_DIGEST = /^[0-9a-f]{64}$/u;

export function clientInstanceId(url: URL): string | null {
  const ids = url.searchParams.getAll(APP_HOST_CLIENT_INSTANCE_PARAMETER);
  return ids.length === 1 && CLIENT_ID.test(ids[0]!) ? ids[0]! : null;
}

export function parseClientAttachment(value: unknown): ClientAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { clientInstanceId, actorId, actorGeneration, expiresAt, loginDigest } = value as Partial<ClientAttachment>;
  if (
    typeof clientInstanceId !== "string" ||
    !CLIENT_ID.test(clientInstanceId) ||
    typeof actorId !== "string" ||
    !actorId.startsWith("human://") ||
    actorId.length > 1024 ||
    typeof actorGeneration !== "number" ||
    !Number.isSafeInteger(actorGeneration) ||
    actorGeneration < 1 ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    typeof loginDigest !== "string" ||
    !LOGIN_DIGEST.test(loginDigest)
  )
    return null;
  return { clientInstanceId, actorId, actorGeneration, expiresAt, loginDigest };
}

/** Called only by a Client binding's internal WebSocket entry. */
export function readClientAttachment(request: Request): ClientAttachment | null {
  const header = request.headers.get(CLIENT_ATTACHMENT_HEADER);
  if (!header || header.length > 2048) return null;
  try {
    return parseClientAttachment(JSON.parse(header));
  } catch {
    return null;
  }
}

/** Separate accounts, replaced logins and distinct browser client instances never share a Client object. */
async function clientObjectName(attachment: ClientAttachment): Promise<string> {
  const identity = JSON.stringify([
    attachment.actorId,
    attachment.actorGeneration,
    attachment.loginDigest,
    attachment.clientInstanceId,
  ]);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const headers = { "cache-control": "no-store" };
export const clientAttachmentRefusal = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers });

/**
 * Revalidate a stored attachment without holding its original request or
 * browser cookie. An unavailable owner must not be treated as admission.
 */
export async function currentClientAttachment(
  installation: InstallationBinding,
  attachment: ClientAttachment,
): Promise<boolean> {
  try {
    const result = await installation.fetch(
      new Request(new URL(CLIENT_CURRENT_PATH, "https://installation.internal"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attachment),
        redirect: "manual",
      }),
    );
    return result.status === 204;
  } catch {
    return false;
  }
}

export async function forwardClientSocket(
  request: Request,
  installation: InstallationBinding,
  clients: ClientSocketNamespace,
): Promise<Response> {
  if (request.method !== "GET") return clientAttachmentRefusal(405, "method_not_allowed");
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return clientAttachmentRefusal(426, "websocket_required");

  const url = new URL(request.url);
  if (request.headers.get("origin") !== url.origin) return clientAttachmentRefusal(403, "origin_required");
  const id = clientInstanceId(url);
  if (!id) return clientAttachmentRefusal(400, "invalid_client_instance");

  // Cookies and authorization are read by the installation. The second
  // request is freshly constructed and carries only the resulting attachment.
  const admissionHeaders = new Headers();
  for (const name of ["origin", "cookie", "authorization", "cf-connecting-ip"]) {
    const value = request.headers.get(name);
    if (value !== null) admissionHeaders.set(name, value);
  }
  const admission = new URL(CLIENT_ADMISSION_PATH, url);
  admission.searchParams.set(APP_HOST_CLIENT_INSTANCE_PARAMETER, id);
  try {
    const decision = await installation.fetch(
      new Request(admission, { headers: admissionHeaders, redirect: "manual" }),
    );
    if (decision.status === 401 || decision.status === 403) return decision;
    if (decision.status !== 200) return clientAttachmentRefusal(503, "client_admission_unavailable");

    const attachment = parseClientAttachment(await decision.json());
    if (!attachment || attachment.clientInstanceId !== id || attachment.expiresAt <= Date.now())
      return clientAttachmentRefusal(503, "invalid_client_admission");
    const name = await clientObjectName(attachment);
    return await clients.get(clients.idFromName(name)).fetch(
      new Request(new URL(CLIENT_SOCKET_PATH, url), {
        headers: { upgrade: "websocket", [CLIENT_ATTACHMENT_HEADER]: JSON.stringify(attachment) },
        redirect: "manual",
      }),
    );
  } catch {
    return clientAttachmentRefusal(503, "client_connection_unavailable");
  }
}
