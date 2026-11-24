// The credential lease exchange (cloudflare-deployment §2.1, workspace-host-split §5):
// the account owner's lease operations as one Fetch-shaped contract, for callers
// outside the owner (another object, another Worker).
//   holder side    the workspace's owner (WorkspaceHost) grants a lease to
//                  `{workspace, engine, incarnation}` when it starts an engine,
//                  renews it while the engine runs, and revokes it when the
//                  incarnation changes or the workspace stops
//   redeem side    the forwarder (the edge egress Worker; credential-egress.ts)
//                  redeems the engine's lease token for one provider's
//                  credential, for the length of one request
// Both are deployment-internal: the account owner serves them only to callers
// bound to it (a Durable Object binding, a private socket), never through the
// public entry. A caller sees exactly the `CredentialLeases` interface, so the
// in-process lease ledger and this exchange are interchangeable.
//
// Runtime-neutral: Fetch `Request`/`Response` only.
import { CredentialLeaseError, type CredentialLeaseErrorCode, type CredentialLeases } from "./credential-leases.js";

/** The holder side: grant, renew, revoke, revokeHolder. */
export const CREDENTIAL_LEASE_HOLDER_PATH = "/__opencraft_internal/credential-leases/holder";
/** The redeem side. */
export const CREDENTIAL_LEASE_REDEEM_PATH = "/__opencraft_internal/credential-leases/redeem";

export type CredentialLeaseHolderRequest =
  | { readonly action: "grant"; readonly holder: unknown; readonly ttlMs: unknown }
  | { readonly action: "renew"; readonly id: unknown; readonly ttlMs: unknown }
  | { readonly action: "revoke"; readonly id: unknown }
  | { readonly action: "revokeHolder"; readonly match: unknown };

export interface CredentialLeaseRedeemRequest {
  readonly token: unknown;
  readonly providerId: unknown;
}

/** Answers: 200 `{ ok }`, or a refusal `{ error: code }` with the status below. */
const STATUS: Readonly<Record<CredentialLeaseErrorCode, number>> = {
  invalid_lease_request: 400,
  lease_invalid: 403,
  provider_unavailable: 404,
  lease_capacity: 429,
};
const CODES = Object.keys(STATUS) as CredentialLeaseErrorCode[];
const MAX_BODY_BYTES = 16 * 1024;

const reply = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new CredentialLeaseError("invalid_lease_request");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new CredentialLeaseError("invalid_lease_request");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CredentialLeaseError("invalid_lease_request");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CredentialLeaseError("invalid_lease_request");
  return value as Record<string, unknown>;
}

const only = (value: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new CredentialLeaseError("invalid_lease_request");
};

/**
 * The account owner's side: serves both paths over `leases`, or resolves null
 * for any other path. The caller decides who may reach it (only bound callers).
 */
export function serveCredentialLeaseExchange(leases: CredentialLeases): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path !== CREDENTIAL_LEASE_HOLDER_PATH && path !== CREDENTIAL_LEASE_REDEEM_PATH) return null;
    try {
      if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });
      const input = await body(request);
      if (path === CREDENTIAL_LEASE_REDEEM_PATH) {
        only(input, ["token", "providerId"]);
        return reply(200, { ok: await leases.redeem(input.token as string, input.providerId as string) });
      }
      switch (input.action) {
        case "grant":
          only(input, ["action", "holder", "ttlMs"]);
          return reply(200, { ok: await leases.grant(input.holder as never, input.ttlMs as number) });
        case "renew":
          only(input, ["action", "id", "ttlMs"]);
          return reply(200, { ok: await leases.renew(input.id as string, input.ttlMs as number) });
        case "revoke":
          only(input, ["action", "id"]);
          return reply(200, { ok: await leases.revoke(input.id as string) });
        case "revokeHolder":
          only(input, ["action", "match"]);
          return reply(200, { ok: await leases.revokeHolder(input.match as never) });
        default:
          throw new CredentialLeaseError("invalid_lease_request");
      }
    } catch (error) {
      if (error instanceof CredentialLeaseError) return reply(STATUS[error.code], { error: error.code });
      // Never echo an internal error; the ledger's own failures are the owner's to log.
      return reply(503, { error: "lease_unavailable" });
    }
  };
}

/** A caller bound to the account owner: a Durable Object stub, a service binding, a private socket client. */
export interface CredentialLeaseOwner {
  fetch(request: Request): Promise<Response>;
}

/**
 * The caller's side: `CredentialLeases` over the exchange. `owner` is called
 * once per operation (a Durable Object caller passes a function that takes a
 * fresh stub each time). Refusals arrive as the same CredentialLeaseError
 * codes the in-process ledger throws; anything else is an Error.
 */
export function credentialLeaseExchangeClient(owner: () => CredentialLeaseOwner): CredentialLeases {
  const call = async (path: string, value: unknown) => {
    const response = await owner().fetch(
      new Request(`https://account.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      }),
    );
    const answer = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
    if (response.status === 200 && answer && "ok" in answer) return answer.ok;
    if (answer && CODES.includes(answer.error as CredentialLeaseErrorCode))
      throw new CredentialLeaseError(answer.error as CredentialLeaseErrorCode);
    throw new Error(`Credential lease exchange failed with status ${response.status}`);
  };
  return {
    grant: async (holder, ttlMs) =>
      (await call(CREDENTIAL_LEASE_HOLDER_PATH, { action: "grant", holder, ttlMs })) as Awaited<
        ReturnType<CredentialLeases["grant"]>
      >,
    renew: async (id, ttlMs) =>
      (await call(CREDENTIAL_LEASE_HOLDER_PATH, { action: "renew", id, ttlMs })) as Awaited<
        ReturnType<CredentialLeases["renew"]>
      >,
    revoke: async (id) => (await call(CREDENTIAL_LEASE_HOLDER_PATH, { action: "revoke", id })) as boolean,
    revokeHolder: async (match) =>
      (await call(CREDENTIAL_LEASE_HOLDER_PATH, { action: "revokeHolder", match })) as number,
    redeem: async (token, providerId) =>
      (await call(CREDENTIAL_LEASE_REDEEM_PATH, { token, providerId })) as Awaited<
        ReturnType<CredentialLeases["redeem"]>
      >,
  };
}
