import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccountModelDefaultsAccess } from "./account-model-defaults-http.js";
import { ActorSshKeyRefusal, sshKeyOperator, type ActorSshKeys } from "./actor-ssh-keys.js";

/** Personal SSH keys of the signed-in Human; administrators may name another Human. */
export const ACTOR_SSH_KEYS_PATH = "/__opencraft_ssh_keys";

const STATUS: Record<ActorSshKeyRefusal["code"], number> = {
  invalid_ssh_key: 400,
  invalid_key_name: 400,
  key_exists: 409,
  key_in_use: 409,
  key_limit: 409,
  unknown_key: 404,
  actor_unavailable: 403,
  ssh_keys_unavailable: 503,
};

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 20_000) throw new RequestError(413, "too_large");
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "invalid_request");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError(400, "invalid_request");
  return value as Record<string, unknown>;
}

export interface ActorSshKeysHttpOptions {
  /** The verified signed-in Human, as for personal model defaults. */
  readonly access: (request: IncomingMessage) => AccountModelDefaultsAccess;
  /** Whether the signed-in requester administers this instance. */
  readonly administrator: (request: IncomingMessage, actorId: string) => boolean;
  /** A Human Actor an administrator may manage keys for. */
  readonly isHuman: (actorId: string) => boolean;
  /** Whether this server accepts SSH logins at all (`--ssh-config`). */
  readonly sshLogin: boolean;
}

/**
 * `GET` lists active keys; `POST {publicKey, name?, expectedActorId, actorId?}` adds
 * one; `DELETE /<keyId>?expectedActorId&actorId?` revokes one. The Actor always
 * comes from the verified login; `expectedActorId` only fences an account change and
 * `actorId` names another Human for an administrator.
 */
export function actorSshKeysHttp(keys: ActorSshKeys | null, options: ActorSshKeysHttpOptions) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://ssh-keys.invalid");
    const prefix = url.pathname === ACTOR_SSH_KEYS_PATH || url.pathname.startsWith(ACTOR_SSH_KEYS_PATH + "/");
    if (!prefix) return false;
    const send = (status: number, value?: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(value === undefined ? undefined : JSON.stringify(value));
    };
    try {
      const initial = options.access(request);
      if ("denied" in initial) {
        send(initial.denied, {
          error: initial.denied === 401 ? "human_authentication_required" : "instance_access_denied",
        });
        return true;
      }
      const actorId = initial.actorId;
      // The signed-in Actor and its admission are rechecked after every await.
      const current = () => {
        const latest = options.access(request);
        if ("denied" in latest)
          throw new RequestError(
            latest.denied,
            latest.denied === 401 ? "human_authentication_required" : "instance_access_denied",
          );
        if (latest.actorId !== actorId) throw new RequestError(409, "account_changed");
      };
      const administrator = options.administrator(request, actorId);
      const target = (value: unknown) => {
        if (value === undefined || value === null || value === "" || value === actorId) return actorId;
        if (typeof value !== "string" || value.length > 512) throw new RequestError(400, "invalid_request");
        if (!administrator) throw new RequestError(403, "administrator_required");
        if (!options.isHuman(value)) throw new RequestError(404, "unknown_actor");
        return value;
      };
      const operator = (subject: string) =>
        subject === actorId ? sshKeyOperator.self(actorId) : sshKeyOperator.administrator(actorId);
      if (!keys) throw new ActorSshKeyRefusal("ssh_keys_unavailable");
      const keyPath = url.pathname.slice(ACTOR_SSH_KEYS_PATH.length + 1);
      if (request.method === "GET" && url.pathname === ACTOR_SSH_KEYS_PATH) {
        const subject = target(url.searchParams.get("actorId"));
        send(200, {
          actorId,
          subjectActorId: subject,
          administrator,
          sshLogin: options.sshLogin,
          keys: keys.list(subject),
        });
        return true;
      }
      if (!["POST", "DELETE"].includes(request.method ?? "")) {
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
        request.headers["sec-fetch-site"] === "cross-site"
      ) {
        send(403, { error: "same_origin_required" });
        return true;
      }
      if (request.method === "POST" && url.pathname === ACTOR_SSH_KEYS_PATH) {
        if (request.headers["content-type"]?.split(";")[0] !== "application/json")
          throw new RequestError(415, "json_required");
        const input = await body(request);
        if (Object.keys(input).some((field) => !["publicKey", "name", "expectedActorId", "actorId"].includes(field)))
          throw new RequestError(400, "invalid_request");
        if (input.expectedActorId !== actorId) throw new RequestError(409, "account_changed");
        const subject = target(input.actorId);
        current();
        const key = await keys.add(subject, { name: input.name, publicKey: input.publicKey }, operator(subject));
        current();
        send(201, { key });
        return true;
      }
      if (request.method === "DELETE" && /^[A-Za-z0-9-]{1,128}$/u.test(keyPath)) {
        if (url.searchParams.get("expectedActorId") !== actorId) throw new RequestError(409, "account_changed");
        const subject = target(url.searchParams.get("actorId"));
        await keys.remove(subject, keyPath, operator(subject));
        send(204);
        return true;
      }
      send(404, { error: "missing" });
    } catch (error) {
      if (error instanceof RequestError) send(error.status, { error: error.code });
      else if (error instanceof ActorSshKeyRefusal) send(STATUS[error.code], { error: error.code });
      // Storage or Worker failure fails closed; nothing is read or written elsewhere.
      else send(503, { error: "ssh_keys_unavailable" });
    }
    return true;
  };
}
