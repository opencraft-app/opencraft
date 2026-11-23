import type { IncomingMessage, ServerResponse } from "node:http";
import {
  parseAccountModelSelection,
  validateModelDefaultsHost,
  type AccountModelDefaultsRecord,
  type AccountModelSelection,
} from "@opencraft/workbench-runtime";

/** Personal model defaults of the signed-in human Actor; see identity-and-access.md. */
export const ACCOUNT_MODEL_DEFAULTS_PATH = "/__opencraft_model_defaults";

/** The verified requester, or why the request is refused. Clients never choose the Actor. */
export type AccountModelDefaultsAccess =
  { readonly actorId: string; readonly origin: string | null } | { readonly denied: 401 | 403 };

/** Async ports of the Server owner Worker; this module never opens SQLite. */
export interface AccountModelDefaultsStorage {
  readAccountModelDefaults(actorId: string, hostId: string): Promise<{ revision: number; selection: unknown }>;
  compareAndSetAccountModelDefaults(
    actorId: string,
    hostId: string,
    revision: number,
    selection: AccountModelSelection,
  ): Promise<{ updated: boolean; record: { revision: number; selection: unknown } }>;
}

interface AuthenticatedContext {
  readonly actorId: string;
  readonly credentialId?: string | null;
}

/**
 * Resolves the Actor from the verified login only. A Session credential is not a
 * person, and an Actor without current instance admission is refused.
 */
export function humanActorAccess<C extends AuthenticatedContext>(authority: {
  authenticate(request: IncomingMessage): C | null;
  /** A verified login whose person the authentication itself refused (e.g. revoked membership). */
  refused?(request: IncomingMessage): boolean;
  isCurrentHuman(context: C): boolean;
  /** Absent when the installation has no instance admission. */
  admits?: ((actorId: string) => boolean) | null;
  trustedOrigin(request: IncomingMessage): string | null;
}): (request: IncomingMessage) => AccountModelDefaultsAccess {
  return (request) => {
    const context = authority.authenticate(request);
    if (!context) return { denied: authority.refused?.(request) ? 403 : 401 };
    if ((context.credentialId ?? null) !== null || !authority.isCurrentHuman(context)) return { denied: 403 };
    if (authority.admits && !authority.admits(context.actorId)) return { denied: 403 };
    return { actorId: context.actorId, origin: authority.trustedOrigin(request) };
  };
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly record?: AccountModelDefaultsRecord,
  ) {
    super(code);
  }
}

function record(value: { revision: number; selection: unknown }): AccountModelDefaultsRecord {
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("Invalid model defaults revision");
  return {
    revision: value.revision,
    selection: value.selection === null ? null : parseAccountModelSelection(value.selection),
  };
}

function host(value: unknown): string {
  try {
    validateModelDefaultsHost(value);
  } catch {
    throw new RequestError(400, "invalid_model_defaults");
  }
  return value;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 8192) throw new RequestError(413, "too_large");
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "invalid_model_defaults");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError(400, "invalid_model_defaults");
  return value as Record<string, unknown>;
}

/**
 * `GET` without `hostId` reports the signed-in Actor. `GET ?hostId&expectedActorId`
 * reads, and a same-origin JSON `POST {hostId, revision, selection, expectedActorId}`
 * replaces, that Actor's record for the Host with revision compare-and-set. The
 * expected Actor only fences an account change; it never selects whose record is used.
 */
export function accountModelDefaultsHttp(
  storage: AccountModelDefaultsStorage,
  access: (request: IncomingMessage) => AccountModelDefaultsAccess,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://model-defaults.invalid");
    if (url.pathname !== ACCOUNT_MODEL_DEFAULTS_PATH) return false;
    const send = (status: number, value: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(JSON.stringify(value));
    };
    try {
      const initial = access(request);
      if ("denied" in initial) {
        send(initial.denied, {
          error: initial.denied === 401 ? "human_authentication_required" : "instance_access_denied",
        });
        return true;
      }
      const actorId = initial.actorId;
      // Admission and the signed-in Actor are rechecked after every await.
      const current = () => {
        const latest = access(request);
        if ("denied" in latest)
          throw new RequestError(
            latest.denied,
            latest.denied === 401 ? "human_authentication_required" : "instance_access_denied",
          );
        if (latest.actorId !== actorId) throw new RequestError(409, "account_changed");
      };
      if (request.method === "GET") {
        if (!url.searchParams.has("hostId")) {
          send(200, { actorId });
          return true;
        }
        const hostId = host(url.searchParams.get("hostId"));
        if (url.searchParams.get("expectedActorId") !== actorId) throw new RequestError(409, "account_changed");
        const value = record(await storage.readAccountModelDefaults(actorId, hostId));
        current();
        send(200, { actorId, ...value });
        return true;
      }
      if (request.method !== "POST") {
        send(405, { error: "method_not_allowed" });
        return true;
      }
      const origin = request.headers.origin;
      if (
        typeof origin !== "string" ||
        !(
          origin === initial.origin ||
          ["http:", "https:"].some((protocol) => origin === protocol + "//" + request.headers.host)
        ) ||
        request.headers["sec-fetch-site"] === "cross-site" ||
        request.headers["content-type"]?.split(";")[0] !== "application/json"
      ) {
        send(403, { error: "same_origin_required" });
        return true;
      }
      const input = await body(request);
      if (Object.keys(input).some((field) => !["hostId", "revision", "selection", "expectedActorId"].includes(field)))
        throw new RequestError(400, "invalid_model_defaults");
      const hostId = host(input.hostId);
      if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0)
        throw new RequestError(400, "invalid_model_defaults");
      let selection: AccountModelSelection;
      try {
        selection = parseAccountModelSelection(input.selection);
      } catch {
        throw new RequestError(400, "invalid_model_defaults");
      }
      if (input.expectedActorId !== actorId) throw new RequestError(409, "account_changed");
      current();
      const result = await storage.compareAndSetAccountModelDefaults(
        actorId,
        hostId,
        input.revision as number,
        selection,
      );
      const value = record(result.record);
      current();
      if (!result.updated) throw new RequestError(409, "revision_conflict", value);
      send(200, { actorId, ...value });
    } catch (error) {
      if (error instanceof RequestError) send(error.status, { error: error.code, ...(error.record ?? {}) });
      // Storage or Worker failure fails closed; nothing is read or written elsewhere.
      else send(503, { error: "model_defaults_unavailable" });
    }
    return true;
  };
}
