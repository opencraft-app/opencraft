// One of 4,096 sharded IdentityIndex Durable Objects (`idx:000`..`idx:fff`).
// Owns atomic uniqueness of `(provider, subject) -> actorId` bindings and stores
// Argon2id PHC digests (computed at the stateless Edge Worker, never here).
import { sha256 } from "@noble/hashes/sha2.js";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import {
  INTERNAL_CALLER_HEADER,
  INTERNAL_CALLER_VALUE,
  type CloudRelayDOState,
  type CloudRelayEnv,
} from "./bindings.js";
import { toHex } from "./crypto.js";
import { IdentityIndexStore } from "./domain.js";

const encoder = new TextEncoder();
const sha256SyncHex = (text: string): string => toHex(sha256(encoder.encode(text)));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export class IdentityIndexDO {
  #store: IdentityIndexStore | null = null;
  #failed = false;

  constructor(
    private readonly ctx: CloudRelayDOState,
    _env: CloudRelayEnv,
  ) {
    void this.ctx.blockConcurrencyWhile(async () => {
      try {
        this.#store = IdentityIndexStore.open(durableObjectSqlDatabase(this.ctx.storage), sha256SyncHex);
      } catch {
        this.#failed = true;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get(INTERNAL_CALLER_HEADER) !== INTERNAL_CALLER_VALUE) {
      return json(403, { error: "forbidden" });
    }
    if (this.#failed || !this.#store) return json(503, { error: "identity_index_unavailable" });
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/read") {
      const body = (await request.json()) as { bindingHash?: unknown };
      if (typeof body.bindingHash !== "string") return json(400, { error: "invalid_request" });
      return json(200, { record: this.#store.read(body.bindingHash) });
    }
    if (request.method === "POST" && url.pathname === "/resolve-or-register") {
      const body = (await request.json()) as {
        bindingHash?: unknown;
        provider?: unknown;
        candidateActorId?: unknown;
        passwordPhc?: unknown;
        allowExistingResolve?: unknown;
      };
      if (
        typeof body.bindingHash !== "string" ||
        typeof body.provider !== "string" ||
        typeof body.candidateActorId !== "string"
      ) {
        return json(400, { error: "invalid_request" });
      }
      const outcome = this.#store.resolveOrRegister({
        bindingHash: body.bindingHash,
        provider: body.provider,
        candidateActorId: body.candidateActorId,
        passwordPhc: typeof body.passwordPhc === "string" ? body.passwordPhc : null,
        allowExistingResolve: body.allowExistingResolve === true,
        now: Date.now(),
      });
      return json(outcome.status === "conflict" ? 409 : 200, outcome);
    }
    if (request.method === "POST" && url.pathname === "/rate-limit") {
      const body = (await request.json()) as { bucketKey?: unknown; limit?: unknown; windowMs?: unknown };
      if (typeof body.bucketKey !== "string" || typeof body.limit !== "number" || typeof body.windowMs !== "number") {
        return json(400, { error: "invalid_request" });
      }
      const res = this.#store.consumeRateLimit({
        bucketKey: body.bucketKey,
        limit: body.limit,
        windowMs: body.windowMs,
        now: Date.now(),
      });
      return json(res.allowed ? 200 : 429, res);
    }
    if (request.method === "POST" && url.pathname === "/license/claim") {
      const body = (await request.json()) as { licenseId?: unknown; actorId?: unknown; tier?: unknown };
      if (
        typeof body.licenseId !== "string" ||
        typeof body.actorId !== "string" ||
        (body.tier !== "pro" && body.tier !== "team")
      ) {
        return json(400, { error: "invalid_request" });
      }
      const res = this.#store.claimLicense({
        licenseId: body.licenseId,
        actorId: body.actorId,
        tier: body.tier,
        now: Date.now(),
      });
      return json(res.ok ? 200 : 409, res);
    }
    if (request.method === "POST" && url.pathname === "/passkey/register") {
      const body = (await request.json()) as {
        credentialId?: unknown;
        actorId?: unknown;
        algorithm?: unknown;
        publicKey?: unknown;
        signCount?: unknown;
        label?: unknown;
      };
      if (
        typeof body.credentialId !== "string" ||
        typeof body.actorId !== "string" ||
        (body.algorithm !== "ES256" && body.algorithm !== "EdDSA") ||
        typeof body.publicKey !== "string" ||
        typeof body.signCount !== "number"
      ) {
        return json(400, { error: "invalid_request" });
      }
      const res = this.#store.registerPasskey({
        credentialId: body.credentialId,
        actorId: body.actorId,
        algorithm: body.algorithm,
        publicKey: body.publicKey,
        signCount: body.signCount,
        label: typeof body.label === "string" ? body.label : "Passkey",
        now: Date.now(),
      });
      return json(res.ok ? 200 : 409, res);
    }
    if (request.method === "POST" && url.pathname === "/passkey/read") {
      const body = (await request.json()) as { credentialId?: unknown };
      if (typeof body.credentialId !== "string") return json(400, { error: "invalid_request" });
      return json(200, { record: this.#store.readPasskey(body.credentialId) });
    }
    if (request.method === "POST" && url.pathname === "/passkey/touch") {
      const body = (await request.json()) as { credentialId?: unknown; signCount?: unknown };
      if (typeof body.credentialId !== "string" || typeof body.signCount !== "number") {
        return json(400, { error: "invalid_request" });
      }
      const updated = this.#store.touchPasskeyUsage(body.credentialId, body.signCount, Date.now());
      return json(updated ? 200 : 404, { ok: updated });
    }
    return json(404, { error: "not_found" });
  }
}
