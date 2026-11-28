// Stateless Edge Worker for the Million-Scale Hosted OpenCraft Relay.
//
// Responsibilities at the edge (zero central database bottleneck):
// 1. Offload 1 (Static UI): Serves Web Workbench via `env.ASSETS` without waking any DO.
// 2. Stateless Auth & Parallel Argon2id: Computes Argon2id hashes in stateless edge
//    isolates (never blocking a single-threaded DO), resolves `(provider, subject)`
//    through 4,096 `IdentityIndexDO` shards, and verifies HS256 session JWTs (+ DPoP
//    Ed25519 device proofs) in <0.1ms on the hot path.
// 3. O(1) Self-Addressing Routing: Routes `ocm_<machineId>_<secret>` host connections
//    and `/m/<machineId>/*` client traffic directly to `idFromName("machine:<id>")`.
// 4. Offload 3 (R2 Large Payloads): Streams large blobs/attachments directly between
//    the Edge Worker and R2 (`r2BlobStore`) via stateless signed tickets.
import {
  RELAY_BLOBS_PATH_PREFIX,
  RELAY_MUX_PATH,
  RELAY_MUX_PROTOCOL,
  deterministicUuidFromHex,
  isValidRelayMachineId,
  parseMachineCredential,
  relayPathAllowed,
} from "@opencraft/relay-protocol";
import { r2BlobStore } from "@opencraft/storage-cloudflare/blob";
import {
  INTERNAL_CALLER_HEADER,
  INTERNAL_CALLER_VALUE,
  type CloudRelayEnv,
  type DurableObjectLocationHint,
} from "./bindings.js";
import {
  DUMMY_CLOUD_PASSWORD_PHC,
  computeEd25519Thumbprint,
  hashCloudRelayPassword,
  hmacSha256Hex,
  issueBlobOffloadTicket,
  issuePowChallenge,
  issueRelaySessionToken,
  verifyBlobOffloadTicket,
  verifyCloudRelayPassword,
  verifyDeviceDpopHeader,
  verifyPowHeader,
  verifyRelayLicenseKey,
  verifyRelaySessionToken,
  type RelaySessionClaims,
} from "./crypto.js";
import {
  identityIndexShardName,
  machineRelayObjectName,
  userRelayObjectName,
  type PasskeyCredentialRecord,
} from "./domain.js";
import { IdentityIndexDO } from "./identity-index-do.js";
import { MachineRelayDO } from "./machine-relay-do.js";
import { UserRelayDO } from "./user-relay-do.js";
import {
  issuePasskeyChallengeTicket,
  resolveWebAuthnRpId,
  verifyMachineClaimTicket,
  verifyPasskeyAssertion,
  verifyPasskeyChallengeTicket,
  verifyPasskeyRegistration,
} from "./webauthn.js";

export { IdentityIndexDO, MachineRelayDO, UserRelayDO };

const SESSION_COOKIE = "oc_cloud_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const BLOB_TICKET_TTL_MS = 15 * 60_000;
const MAX_BLOB_OFFLOAD_BYTES = 2 * 1024 * 1024 * 1024; // Up to 2 GiB with Pro/Team license
const DEFAULT_POW_BITS = 14;
const DEFAULT_IP_ENROLL_HOURLY_LIMIT = 12;
const DEFAULT_IP_REDEEM_LIMIT = 30;
const isolateRateWindows = new Map<string, { count: number; resetAt: number }>();

const json = (status: number, body: unknown, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders },
  });

function corsHeadersFor(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, x-opencraft-dpop, x-opencraft-pow, x-opencraft-grant-id, x-opencraft-location-hint",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function withCors(request: Request, response: Response): Response {
  const cors = corsHeadersFor(request);
  if (Object.keys(cors).length === 0 || response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function canonicalDpopUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.searchParams.delete("access_token");
  parsed.searchParams.delete("dpop");
  return parsed.toString();
}

function parseBearer(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE}=`)) return decodeURIComponent(trimmed.slice(SESSION_COOKIE.length + 1));
  }
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const queryToken = new URL(request.url).searchParams.get("access_token")?.trim();
    if (queryToken) return queryToken;
  }
  return null;
}

async function authenticateCaller(
  request: Request,
  env: CloudRelayEnv,
): Promise<
  | { readonly ok: true; readonly claims: RelaySessionClaims; readonly deviceThumbprint?: string }
  | { readonly ok: false; readonly response: Response }
> {
  const token = parseBearer(request);
  if (!token) return { ok: false, response: json(401, { error: "authentication_required" }) };
  const claims = await verifyRelaySessionToken(env.OPENCRAFT_RELAY_SIGNING_KEY, token, env.OPENCRAFT_RELAY_ORIGIN);
  if (!claims) return { ok: false, response: json(401, { error: "invalid_or_expired_session" }) };

  const isWsUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const dpopHeader =
    request.headers.get("x-opencraft-dpop") ?? (isWsUpgrade ? new URL(request.url).searchParams.get("dpop") : null);
  const verifyDpopAgainstRequest = async (rawDpop: string) => {
    const direct = await verifyDeviceDpopHeader(rawDpop, request.method, request.url);
    if (direct) return direct;
    if (isWsUpgrade) {
      return verifyDeviceDpopHeader(rawDpop, request.method, canonicalDpopUrl(request.url));
    }
    return null;
  };
  if (claims.cnf) {
    if (!dpopHeader) return { ok: false, response: json(401, { error: "dpop_proof_required" }) };
    const proof = await verifyDpopAgainstRequest(dpopHeader);
    if (!proof || proof.thumbprint !== claims.cnf) {
      return { ok: false, response: json(401, { error: "invalid_dpop_proof" }) };
    }
    return { ok: true, claims, deviceThumbprint: proof.thumbprint };
  }
  if (dpopHeader) {
    const proof = await verifyDpopAgainstRequest(dpopHeader);
    if (!proof) return { ok: false, response: json(401, { error: "invalid_dpop_proof" }) };
    return { ok: true, claims, deviceThumbprint: proof.thumbprint };
  }
  return { ok: true, claims };
}

function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return /^[a-z0-9._@-]{3,128}$/u.test(trimmed) ? trimmed : null;
}

function validatePasswordInput(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const bytes = new TextEncoder().encode(raw).byteLength;
  return bytes >= 12 && bytes <= 1024 ? raw : null;
}

function indexShard(env: CloudRelayEnv, bindingHash: string) {
  return env.IDENTITY_INDEX.get(env.IDENTITY_INDEX.idFromName(identityShardNameSafe(bindingHash)));
}

function identityShardNameSafe(bindingHash: string): string {
  return identityIndexShardName(bindingHash);
}

const VALID_LOCATION_HINTS = new Set<DurableObjectLocationHint>([
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "oc",
  "afr",
  "me",
]);

function inferLocationHint(request: Request, env: CloudRelayEnv): DurableObjectLocationHint | undefined {
  const explicit =
    request.headers.get("x-opencraft-location-hint")?.trim().toLowerCase() ??
    env.OPENCRAFT_RELAY_LOCATION_HINT?.trim().toLowerCase();
  if (explicit && VALID_LOCATION_HINTS.has(explicit as DurableObjectLocationHint)) {
    return explicit as DurableObjectLocationHint;
  }
  const cf = (request as Request & { cf?: { continent?: string } }).cf;
  switch (cf?.continent) {
    case "AS":
      return "apac";
    case "EU":
      return "weur";
    case "OC":
      return "oc";
    case "SA":
      return "sam";
    case "AF":
      return "afr";
    case "NA":
      return "wnam";
    default:
      return undefined;
  }
}

function userStub(env: CloudRelayEnv, actorId: string, hint?: DurableObjectLocationHint) {
  const id = env.USER_RELAY.idFromName(userRelayObjectName(actorId));
  return hint ? env.USER_RELAY.get(id, { locationHint: hint }) : env.USER_RELAY.get(id);
}

function machineStub(env: CloudRelayEnv, machineId: string, hint?: DurableObjectLocationHint) {
  const id = env.MACHINE_RELAY.idFromName(machineRelayObjectName(machineId));
  return hint ? env.MACHINE_RELAY.get(id, { locationHint: hint }) : env.MACHINE_RELAY.get(id);
}

function internalInit(method: string, body?: unknown, extraHeaders: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: {
      [INTERNAL_CALLER_HEADER]: INTERNAL_CALLER_VALUE,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

function parseCompoundToken(raw: string): { readonly actorId: string; readonly secret: string } | null {
  // Format: `<36-char-uuid>_<secret>` where `actorId = "actor_" + uuid`
  if (typeof raw !== "string" || raw.length < 38 || raw[36] !== "_") return null;
  const uuid = raw.slice(0, 36);
  const secret = raw.slice(37);
  if (!/^[a-f0-9-]{36}$/u.test(uuid) || !/^[A-Za-z0-9_-]{16,96}$/u.test(secret)) return null;
  return { actorId: `actor_${uuid}`, secret };
}

function sessionCookieHeader(token: string, origin: string): string {
  const secure = origin.startsWith("https:") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
}

async function callerIpHash(request: Request, env: CloudRelayEnv): Promise<string> {
  const rawIp =
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "local";
  return hmacSha256Hex(env.OPENCRAFT_RELAY_SIGNING_KEY, "client-ip-rate-limit", rawIp);
}

function requiredPowBits(env: CloudRelayEnv): number {
  const raw = env.OPENCRAFT_RELAY_POW_BITS;
  if (raw === undefined) return DEFAULT_POW_BITS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 24 ? parsed : DEFAULT_POW_BITS;
}

/**
 * Two-tier per-IP rate limiter:
 * 1. In-isolate sliding bucket catches single-POP bursts in 0ms with 0 DO calls;
 * 2. 4,096-shard `IdentityIndexDO` enforces cross-POP limits globally.
 */
async function enforceIpRateLimit(
  request: Request,
  env: CloudRelayEnv,
  scope: "enroll" | "redeem" | "auth",
  limit: number,
  windowMs: number,
): Promise<{ readonly ok: true; readonly ipHash: string } | { readonly ok: false; readonly response: Response }> {
  const ipHash = await callerIpHash(request, env);
  const bucketKey = `${scope}:${ipHash}`;
  const now = Date.now();
  if (isolateRateWindows.size > 4096) {
    for (const [k, v] of isolateRateWindows) if (v.resetAt <= now) isolateRateWindows.delete(k);
  }
  const local = isolateRateWindows.get(bucketKey);
  if (local && local.resetAt > now && local.count >= limit) {
    const retryAfter = String(Math.max(1, Math.ceil((local.resetAt - now) / 1000)));
    return { ok: false, response: json(429, { error: "rate_limit_exceeded" }, { "retry-after": retryAfter }) };
  }
  const shardRes = await indexShard(env, ipHash).fetch(
    new Request("https://identity-index.internal/rate-limit", internalInit("POST", { bucketKey, limit, windowMs })),
  );
  if (shardRes.status === 429) {
    const body = (await shardRes.json()) as { retryAfterSec?: number };
    const retrySec = body.retryAfterSec ?? 60;
    isolateRateWindows.set(bucketKey, { count: limit, resetAt: now + retrySec * 1000 });
    return { ok: false, response: json(429, { error: "rate_limit_exceeded" }, { "retry-after": String(retrySec) }) };
  }
  if (!local || local.resetAt <= now) {
    isolateRateWindows.set(bucketKey, { count: 1, resetAt: now + windowMs });
  } else {
    local.count += 1;
  }
  return { ok: true, ipHash };
}

async function applyVerifiedLicenseToActor(
  env: CloudRelayEnv,
  actorId: string,
  licenseKeyRaw: string,
  hint?: DurableObjectLocationHint,
): Promise<
  | { readonly ok: true; readonly tier: "pro" | "team"; readonly machineLimit: number; readonly maxBlobBytes: number }
  | { readonly ok: false; readonly status: number; readonly error: string }
> {
  const licenseSecret = env.OPENCRAFT_RELAY_LICENSE_SIGNING_KEY || env.OPENCRAFT_RELAY_SIGNING_KEY;
  const claims = await verifyRelayLicenseKey(licenseSecret, licenseKeyRaw);
  if (!claims) return { ok: false, status: 400, error: "invalid_or_expired_license_key" };
  const lidHash = await hmacSha256Hex(env.OPENCRAFT_RELAY_SIGNING_KEY, "license-claim", claims.lid);
  const claimRes = await indexShard(env, lidHash).fetch(
    new Request(
      "https://identity-index.internal/license/claim",
      internalInit("POST", { licenseId: claims.lid, actorId, tier: claims.tier }),
    ),
  );
  if (claimRes.status === 409) {
    return { ok: false, status: 409, error: "license_already_claimed" };
  }
  if (!claimRes.ok) {
    return { ok: false, status: 503, error: "license_service_unavailable" };
  }
  const actRes = await userStub(env, actorId, hint).fetch(
    new Request(
      "https://user-relay.internal/license/activate",
      internalInit("POST", {
        licenseId: claims.lid,
        tier: claims.tier,
        machineLimit: claims.machineLimit,
        maxBlobBytes: claims.maxBlobBytes,
        expiresAt: claims.exp,
      }),
    ),
  );
  if (!actRes.ok) return { ok: false, status: 503, error: "license_activation_failed" };
  return { ok: true, tier: claims.tier, machineLimit: claims.machineLimit, maxBlobBytes: claims.maxBlobBytes };
}

export default {
  async fetch(request: Request, env: CloudRelayEnv): Promise<Response> {
    if (
      request.method === "OPTIONS" &&
      (new URL(request.url).pathname.startsWith("/__opencraft_cloud/") ||
        new URL(request.url).pathname.startsWith("/m/") ||
        new URL(request.url).pathname.startsWith(RELAY_BLOBS_PATH_PREFIX))
    ) {
      return new Response(null, { status: 204, headers: corsHeadersFor(request) });
    }
    const response = await this.handleRequest(request, env);
    return withCors(request, response);
  },

  async handleRequest(request: Request, env: CloudRelayEnv): Promise<Response> {
    if (!env.OPENCRAFT_RELAY_SIGNING_KEY || !env.OPENCRAFT_RELAY_ORIGIN) {
      return json(503, { error: "relay_misconfigured" });
    }
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/__opencraft_relay/live" || pathname === "/__opencraft_relay/health") {
      return json(200, { ok: true, protocol: 2, mode: "cloudflare-sharded" });
    }

    if (pathname === "/" && (request.method === "GET" || request.method === "HEAD") && !env.ASSETS) {
      const body = json(200, { service: "opencraft-cloud-relay", ok: true, protocol: 2 });
      return request.method === "HEAD" ? new Response(null, { status: 200, headers: body.headers }) : body;
    }

    // ---- 1. Host outbound mux.v2 connection (O(1) self-addressing credential) ----
    if (pathname === RELAY_MUX_PATH) {
      if (
        request.method !== "GET" ||
        request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
        request.headers.get("sec-websocket-protocol") !== RELAY_MUX_PROTOCOL ||
        request.headers.has("origin")
      ) {
        return json(401, { error: "invalid_mux_handshake" });
      }
      const parsed = parseMachineCredential(parseBearer(request));
      if (!parsed) return json(401, { error: "invalid_machine_credential" });
      return machineStub(env, parsed.machineId).fetch(
        new Request("https://machine-relay.internal/internal/host-mux", {
          headers: {
            upgrade: "websocket",
            "sec-websocket-protocol": RELAY_MUX_PROTOCOL,
            [INTERNAL_CALLER_HEADER]: INTERNAL_CALLER_VALUE,
            "x-opencraft-machine-secret": parsed.secret,
          },
        }),
      );
    }

    // ---- 2. Offload 3: Direct Edge <-> R2 large blob streaming ----
    if (pathname.startsWith(RELAY_BLOBS_PATH_PREFIX)) {
      if (!env.RELAY_BLOBS) return json(503, { error: "blob_offload_not_configured" });
      const ticketRaw = url.searchParams.get("ticket") ?? parseBearer(request) ?? "";
      const ticket = await verifyBlobOffloadTicket(env.OPENCRAFT_RELAY_SIGNING_KEY, ticketRaw);
      const requestedKey = decodeURIComponent(pathname.slice(RELAY_BLOBS_PATH_PREFIX.length));
      if (!ticket || ticket.blobKey !== requestedKey) {
        return json(403, { error: "invalid_blob_ticket" });
      }
      const store = r2BlobStore(env.RELAY_BLOBS, { prefix: `machines/${ticket.machineId}` });
      if (request.method === "PUT" && ticket.mode === "put") {
        if (!request.body) return json(400, { error: "empty_blob_body" });
        try {
          const saved = await store.put(ticket.blobKey, request.body, {
            maxBytes: ticket.maxBytes,
            ...(ticket.sha256 ? { sha256: ticket.sha256 } : {}),
          });
          return json(201, { ok: true, key: saved.key, size: saved.size, sha256: saved.sha256 });
        } catch (err) {
          return json(400, { error: err instanceof Error ? err.message : "blob_upload_failed" });
        }
      }
      if (request.method === "GET" && ticket.mode === "get") {
        const found = await store.get(ticket.blobKey);
        if (!found) return json(404, { error: "blob_not_found" });
        return new Response(found.body, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(found.size),
            "cache-control": "private, max-age=3600",
          },
        });
      }
      return json(405, { error: "method_not_allowed" });
    }

    // ---- 3. Cloud Account, Sovereign Device Key, Pairing & Share API ----
    if (pathname.startsWith("/__opencraft_cloud/")) {
      // 3.0 Stateless Hashcash PoW challenge issuer (`GET /__opencraft_cloud/pow/challenge?purpose=enroll|redeem`)
      if (pathname === "/__opencraft_cloud/pow/challenge" && request.method === "GET") {
        const purposeRaw = url.searchParams.get("purpose");
        const purpose = purposeRaw === "redeem" ? "redeem" : "enroll";
        const ipHash = await callerIpHash(request, env);
        const challenge = await issuePowChallenge(env.OPENCRAFT_RELAY_SIGNING_KEY, {
          purpose,
          ipHash,
          bits: requiredPowBits(env),
        });
        return json(200, challenge);
      }

      // 3.0b Zero-Signup Sovereign Machine Enrollment (Ed25519 DPoP + Hashcash PoW + Per-IP Rate Limit!)
      if (pathname === "/__opencraft_cloud/sovereign/enroll" && request.method === "POST") {
        const hourlyLimit = Number(env.OPENCRAFT_RELAY_IP_ENROLL_HOURLY_LIMIT ?? DEFAULT_IP_ENROLL_HOURLY_LIMIT);
        const rate = await enforceIpRateLimit(
          request,
          env,
          "enroll",
          Number.isSafeInteger(hourlyLimit) && hourlyLimit >= 1 ? hourlyLimit : DEFAULT_IP_ENROLL_HOURLY_LIMIT,
          60 * 60_000,
        );
        if (!rate.ok) return rate.response;

        const powOk = await verifyPowHeader(env.OPENCRAFT_RELAY_SIGNING_KEY, request.headers.get("x-opencraft-pow"), {
          purpose: "enroll",
          ipHash: rate.ipHash,
          minBits: requiredPowBits(env),
        });
        if (!powOk) return json(428, { error: "pow_required" });

        const dpopHeader = request.headers.get("x-opencraft-dpop");
        if (!dpopHeader) return json(401, { error: "dpop_proof_required" });
        const proof = await verifyDeviceDpopHeader(dpopHeader, request.method, request.url);
        if (!proof) return json(401, { error: "invalid_dpop_proof" });

        const body = (await request.json().catch(() => ({}))) as {
          machineId?: unknown;
          displayName?: unknown;
          approvalRequired?: unknown;
          licenseKey?: unknown;
        };
        const actorId = `actor_${deterministicUuidFromHex(proof.thumbprint)}`;
        const hint = inferLocationHint(request, env);
        const displayName =
          typeof body.displayName === "string" && body.displayName.trim()
            ? body.displayName.trim().slice(0, 128)
            : "My Workstation";

        const profileRes = await userStub(env, actorId, hint).fetch(
          new Request("https://user-relay.internal/ensure-profile", internalInit("POST", { actorId, displayName })),
        );
        if (!profileRes.ok) return json(503, { error: "profile_creation_failed" });
        const { profile } = (await profileRes.json()) as { profile: { sessionEpoch: number } };

        if (typeof body.licenseKey === "string" && body.licenseKey.trim()) {
          const lic = await applyVerifiedLicenseToActor(env, actorId, body.licenseKey.trim(), hint);
          if (!lic.ok) return json(lic.status, { error: lic.error });
        }

        const enrollRes = await userStub(env, actorId, hint).fetch(
          new Request(
            "https://user-relay.internal/machines/enroll",
            internalInit(
              "POST",
              {
                ...(typeof body.machineId === "string" ? { machineId: body.machineId } : {}),
                displayName,
                approvalRequired: body.approvalRequired === true,
                ownerDeviceThumbprint: proof.thumbprint,
              },
              hint ? { "x-opencraft-location-hint": hint } : {},
            ),
          ),
        );
        if (!enrollRes.ok) return enrollRes;
        const enrolledBody = (await enrollRes.json()) as Record<string, unknown>;
        const now = Date.now();
        const token = await issueRelaySessionToken(env.OPENCRAFT_RELAY_SIGNING_KEY, {
          sub: actorId,
          ver: profile.sessionEpoch,
          iat: now,
          exp: now + SESSION_TTL_MS,
          aud: env.OPENCRAFT_RELAY_ORIGIN,
          cnf: proof.thumbprint,
        });
        return json(201, {
          actorId,
          token,
          ownerThumbprint: proof.thumbprint,
          ...enrolledBody,
        });
      }

      // 3.0c Zero-Signup Guest Collaborator Share Claim (`POST /__opencraft_cloud/shares/claim-guest`)
      if (pathname === "/__opencraft_cloud/shares/claim-guest" && request.method === "POST") {
        const redeemLimit = Number(env.OPENCRAFT_RELAY_IP_REDEEM_LIMIT ?? DEFAULT_IP_REDEEM_LIMIT);
        const rate = await enforceIpRateLimit(
          request,
          env,
          "redeem",
          Number.isSafeInteger(redeemLimit) && redeemLimit >= 1 ? redeemLimit : DEFAULT_IP_REDEEM_LIMIT,
          10 * 60_000,
        );
        if (!rate.ok) return rate.response;

        const powOk = await verifyPowHeader(env.OPENCRAFT_RELAY_SIGNING_KEY, request.headers.get("x-opencraft-pow"), {
          purpose: "redeem",
          ipHash: rate.ipHash,
          minBits: requiredPowBits(env),
        });
        if (!powOk) return json(428, { error: "pow_required" });

        const body = (await request.json().catch(() => null)) as {
          shareToken?: unknown;
          guestPublicKey?: unknown;
        } | null;
        if (!body || typeof body.shareToken !== "string" || typeof body.guestPublicKey !== "string") {
          return json(400, { error: "invalid_guest_claim_request" });
        }
        const compound = parseCompoundToken(body.shareToken);
        if (!compound) return json(400, { error: "invalid_share_token" });
        let guestThumbprint: string;
        try {
          guestThumbprint = await computeEd25519Thumbprint(body.guestPublicKey);
        } catch {
          return json(400, { error: "invalid_guest_public_key" });
        }
        const granteeActorId = `actor_${deterministicUuidFromHex(guestThumbprint)}`;
        const claimRes = await userStub(env, compound.actorId).fetch(
          new Request(
            "https://user-relay.internal/shares/claim",
            internalInit("POST", { rawSecret: compound.secret, granteeActorId }),
          ),
        );
        if (!claimRes.ok) return claimRes;
        const claimed = (await claimRes.json()) as {
          grant: Record<string, unknown>;
          machineDisplayName?: string;
        };
        const now = Date.now();
        const token = await issueRelaySessionToken(env.OPENCRAFT_RELAY_SIGNING_KEY, {
          sub: granteeActorId,
          ver: 1,
          iat: now,
          exp: now + SESSION_TTL_MS,
          aud: env.OPENCRAFT_RELAY_ORIGIN,
          cnf: guestThumbprint,
        });
        return json(
          200,
          {
            actorId: granteeActorId,
            token,
            deviceThumbprint: guestThumbprint,
            grant: claimed.grant,
            ...(claimed.machineDisplayName ? { machineDisplayName: claimed.machineDisplayName } : {}),
          },
          { "set-cookie": sessionCookieHeader(token, env.OPENCRAFT_RELAY_ORIGIN) },
        );
      }
      // 3.0d WebAuthn Passkey Personal Hub Registration & Login (Zero password, zero email!)
      if (pathname === "/__opencraft_cloud/passkey/register/options" && request.method === "POST") {
        const rate = await enforceIpRateLimit(request, env, "auth", 30, 10 * 60_000);
        if (!rate.ok) return rate.response;
        const body = (await request.json().catch(() => ({}))) as { labelHint?: unknown };
        const rpId = resolveWebAuthnRpId(request.headers.get("origin"), env.OPENCRAFT_RELAY_ORIGIN);
        const actorId = `actor_${crypto.randomUUID()}`;
        const dateTag = new Date().toISOString().slice(0, 7);
        const hintClean =
          typeof body.labelHint === "string" && body.labelHint.trim()
            ? body.labelHint.trim().slice(0, 48)
            : "Personal Hub";
        const userName = `OpenCraft · ${hintClean} (${dateTag})`;
        const issued = await issuePasskeyChallengeTicket(env.OPENCRAFT_RELAY_SIGNING_KEY, {
          purpose: "register",
          rpId,
          actorId,
        });
        return json(200, {
          rpId: issued.rpId,
          rpName: "OpenCraft",
          challenge: issued.challenge,
          challengeTicket: issued.challengeTicket,
          user: {
            id: actorId,
            name: userName,
            displayName: hintClean,
          },
          expiresAt: issued.expiresAt,
        });
      }

      if (pathname === "/__opencraft_cloud/passkey/register/verify" && request.method === "POST") {
        const rate = await enforceIpRateLimit(request, env, "auth", 20, 10 * 60_000);
        if (!rate.ok) return rate.response;
        const body = (await request.json().catch(() => null)) as {
          challengeTicket?: unknown;
          credentialId?: unknown;
          clientDataJSON?: unknown;
          attestationObject?: unknown;
          devicePublicKey?: unknown;
          label?: unknown;
        } | null;
        if (
          !body ||
          typeof body.challengeTicket !== "string" ||
          typeof body.credentialId !== "string" ||
          typeof body.clientDataJSON !== "string" ||
          typeof body.attestationObject !== "string" ||
          typeof body.devicePublicKey !== "string"
        ) {
          return json(400, { error: "invalid_passkey_registration_payload" });
        }
        const ticket = await verifyPasskeyChallengeTicket(
          env.OPENCRAFT_RELAY_SIGNING_KEY,
          body.challengeTicket,
          "register",
        );
        if (!ticket || !ticket.actorId) return json(400, { error: "expired_or_invalid_passkey_challenge" });

        let deviceThumbprint: string;
        try {
          deviceThumbprint = await computeEd25519Thumbprint(body.devicePublicKey);
        } catch {
          return json(400, { error: "invalid_device_public_key" });
        }

        const verified = await verifyPasskeyRegistration({
          credentialIdB64: body.credentialId,
          clientDataJsonB64: body.clientDataJSON,
          attestationObjectB64: body.attestationObject,
          expectedChallenge: ticket.challenge,
          expectedRpId: ticket.rpId,
        });
        if (!verified) return json(400, { error: "passkey_attestation_verification_failed" });

        const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 64) : "Passkey";
        const credShardHash = await hmacSha256Hex(
          env.OPENCRAFT_RELAY_SIGNING_KEY,
          "passkey-cred",
          verified.credentialId,
        );
        const regRes = await indexShard(env, credShardHash).fetch(
          new Request(
            "https://identity-index.internal/passkey/register",
            internalInit("POST", {
              credentialId: verified.credentialId,
              actorId: ticket.actorId,
              algorithm: verified.algorithm,
              publicKey: verified.publicKey,
              signCount: verified.signCount,
              label,
            }),
          ),
        );
        if (regRes.status === 409) return json(409, { error: "passkey_already_registered" });
        if (!regRes.ok) return json(503, { error: "passkey_index_unavailable" });

        const hint = inferLocationHint(request, env);
        const profileRes = await userStub(env, ticket.actorId, hint).fetch(
          new Request(
            "https://user-relay.internal/ensure-profile",
            internalInit("POST", { actorId: ticket.actorId, displayName: label }),
          ),
        );
        if (!profileRes.ok) return json(503, { error: "profile_creation_failed" });
        const { profile } = (await profileRes.json()) as {
          profile: { actorId: string; sessionEpoch: number; displayName: string };
        };

        await userStub(env, ticket.actorId, hint).fetch(
          new Request(
            "https://user-relay.internal/passkey/record",
            internalInit("POST", { credentialId: verified.credentialId, label }),
          ),
        );

        const now = Date.now();
        const token = await issueRelaySessionToken(env.OPENCRAFT_RELAY_SIGNING_KEY, {
          sub: profile.actorId,
          ver: profile.sessionEpoch,
          iat: now,
          exp: now + SESSION_TTL_MS,
          aud: env.OPENCRAFT_RELAY_ORIGIN,
          cnf: deviceThumbprint,
        });
        return json(
          201,
          {
            actorId: profile.actorId,
            displayName: profile.displayName,
            token,
            credentialId: verified.credentialId,
          },
          { "set-cookie": sessionCookieHeader(token, env.OPENCRAFT_RELAY_ORIGIN) },
        );
      }

      if (pathname === "/__opencraft_cloud/passkey/login/options" && request.method === "POST") {
        const rate = await enforceIpRateLimit(request, env, "auth", 40, 10 * 60_000);
        if (!rate.ok) return rate.response;
        const rpId = resolveWebAuthnRpId(request.headers.get("origin"), env.OPENCRAFT_RELAY_ORIGIN);
        const issued = await issuePasskeyChallengeTicket(env.OPENCRAFT_RELAY_SIGNING_KEY, {
          purpose: "login",
          rpId,
        });
        return json(200, {
          rpId: issued.rpId,
          challenge: issued.challenge,
          challengeTicket: issued.challengeTicket,
          expiresAt: issued.expiresAt,
        });
      }

      if (pathname === "/__opencraft_cloud/passkey/login/verify" && request.method === "POST") {
        const rate = await enforceIpRateLimit(request, env, "auth", 30, 10 * 60_000);
        if (!rate.ok) return rate.response;
        const body = (await request.json().catch(() => null)) as {
          challengeTicket?: unknown;
          credentialId?: unknown;
          authenticatorData?: unknown;
          clientDataJSON?: unknown;
          signature?: unknown;
          devicePublicKey?: unknown;
        } | null;
        if (
          !body ||
          typeof body.challengeTicket !== "string" ||
          typeof body.credentialId !== "string" ||
          typeof body.authenticatorData !== "string" ||
          typeof body.clientDataJSON !== "string" ||
          typeof body.signature !== "string" ||
          typeof body.devicePublicKey !== "string"
        ) {
          return json(400, { error: "invalid_passkey_login_payload" });
        }
        const ticket = await verifyPasskeyChallengeTicket(
          env.OPENCRAFT_RELAY_SIGNING_KEY,
          body.challengeTicket,
          "login",
        );
        if (!ticket) return json(400, { error: "expired_or_invalid_passkey_challenge" });

        let deviceThumbprint: string;
        try {
          deviceThumbprint = await computeEd25519Thumbprint(body.devicePublicKey);
        } catch {
          return json(400, { error: "invalid_device_public_key" });
        }

        const credShardHash = await hmacSha256Hex(env.OPENCRAFT_RELAY_SIGNING_KEY, "passkey-cred", body.credentialId);
        const readRes = await indexShard(env, credShardHash).fetch(
          new Request(
            "https://identity-index.internal/passkey/read",
            internalInit("POST", { credentialId: body.credentialId }),
          ),
        );
        if (!readRes.ok) return json(503, { error: "passkey_index_unavailable" });
        const { record } = (await readRes.json()) as { record: PasskeyCredentialRecord | null };
        if (!record) return json(401, { error: "passkey_not_recognized" });

        const asserted = await verifyPasskeyAssertion({
          credentialIdB64: body.credentialId,
          authenticatorDataB64: body.authenticatorData,
          clientDataJsonB64: body.clientDataJSON,
          signatureB64: body.signature,
          expectedChallenge: ticket.challenge,
          expectedRpId: ticket.rpId,
          storedAlgorithm: record.algorithm,
          storedPublicKeyB64: record.publicKey,
          storedSignCount: record.signCount,
        });
        if (!asserted) return json(401, { error: "passkey_signature_invalid" });

        await indexShard(env, credShardHash).fetch(
          new Request(
            "https://identity-index.internal/passkey/touch",
            internalInit("POST", { credentialId: body.credentialId, signCount: asserted.newSignCount }),
          ),
        );

        const hint = inferLocationHint(request, env);
        const profileRes = await userStub(env, record.actorId, hint).fetch(
          new Request(
            "https://user-relay.internal/ensure-profile",
            internalInit("POST", { actorId: record.actorId, displayName: record.label || "Personal Hub" }),
          ),
        );
        if (!profileRes.ok) return json(503, { error: "profile_unavailable" });
        const { profile } = (await profileRes.json()) as {
          profile: { actorId: string; sessionEpoch: number; displayName: string };
        };

        await userStub(env, record.actorId, hint).fetch(
          new Request(
            "https://user-relay.internal/passkey/record",
            internalInit("POST", { credentialId: record.credentialId, label: record.label }),
          ),
        );

        // Explicit WebAuthn re-verification restores access on any previously revoked Personal Hub machine
        const summaryRes = await userStub(env, record.actorId, hint).fetch(
          new Request("https://user-relay.internal/summary", internalInit("GET")),
        );
        if (summaryRes.ok) {
          const sum = (await summaryRes.json()) as {
            machines?: ReadonlyArray<{ machineId: string; approvalRequired: boolean }>;
          };
          await Promise.all(
            (sum.machines ?? []).map((m) =>
              machineStub(env, m.machineId)
                .fetch(
                  new Request(
                    "https://machine-relay.internal/internal/register-device",
                    internalInit("POST", {
                      thumbprint: deviceThumbprint,
                      label: record.label || "Passkey Browser",
                      forceApprove: !m.approvalRequired,
                      clearRevocation: true,
                    }),
                  ),
                )
                .catch(() => undefined),
            ),
          );
        }

        const now = Date.now();
        const token = await issueRelaySessionToken(env.OPENCRAFT_RELAY_SIGNING_KEY, {
          sub: profile.actorId,
          ver: profile.sessionEpoch,
          iat: now,
          exp: now + SESSION_TTL_MS,
          aud: env.OPENCRAFT_RELAY_ORIGIN,
          cnf: deviceThumbprint,
        });
        return json(
          200,
          {
            actorId: profile.actorId,
            displayName: profile.displayName,
            token,
            credentialId: record.credentialId,
          },
          { "set-cookie": sessionCookieHeader(token, env.OPENCRAFT_RELAY_ORIGIN) },
        );
      }

      // 3.0e Seamless Workstation Owner Sync after Browser Personal Hub Claim (`POST /__opencraft_cloud/machines/sync-owner`)
      if (pathname === "/__opencraft_cloud/machines/sync-owner" && request.method === "POST") {
        const dpopHeader = request.headers.get("x-opencraft-dpop");
        if (!dpopHeader) return json(401, { error: "dpop_proof_required" });
        const proof = await verifyDeviceDpopHeader(dpopHeader, request.method, request.url);
        if (!proof) return json(401, { error: "invalid_dpop_proof" });
        const body = (await request.json().catch(() => null)) as { machineId?: unknown } | null;
        if (!body || typeof body.machineId !== "string" || !isValidRelayMachineId(body.machineId)) {
          return json(400, { error: "invalid_machine_id" });
        }
        const inspectRes = await machineStub(env, body.machineId).fetch(
          new Request("https://machine-relay.internal/internal/inspect", internalInit("GET")),
        );
        if (!inspectRes.ok) return json(404, { error: "machine_unavailable" });
        const inspected = (await inspectRes.json()) as {
          ownerActorId?: string | null;
          ownerDeviceThumbprint?: string | null;
        };
        const sovereignActor = `actor_${deterministicUuidFromHex(proof.thumbprint)}`;
        if (
          !inspected.ownerActorId ||
          (inspected.ownerDeviceThumbprint !== proof.thumbprint && inspected.ownerActorId !== sovereignActor)
        ) {
          return json(403, { error: "not_workstation_owner" });
        }
        const profileRes = await userStub(env, inspected.ownerActorId).fetch(
          new Request(
            "https://user-relay.internal/ensure-profile",
            internalInit("POST", { actorId: inspected.ownerActorId, displayName: "Personal Hub" }),
          ),
        );
        if (!profileRes.ok) return json(503, { error: "profile_unavailable" });
        const { profile } = (await profileRes.json()) as { profile: { sessionEpoch: number } };
        const now = Date.now();
        const token = await issueRelaySessionToken(env.OPENCRAFT_RELAY_SIGNING_KEY, {
          sub: inspected.ownerActorId,
          ver: profile.sessionEpoch,
          iat: now,
          exp: now + SESSION_TTL_MS,
          aud: env.OPENCRAFT_RELAY_ORIGIN,
          cnf: proof.thumbprint,
        });
        return json(200, {
          actorId: inspected.ownerActorId,
          hubClaimed: inspected.ownerActorId !== sovereignActor,
          token,
        });
      }

      // 3a. Register local account (native WebCrypto PBKDF2-SHA256 + pepper on stateless Edge Worker)
      if (pathname === "/__opencraft_cloud/auth/register" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        const username = normalizeUsername(body?.username);
        const password = validatePasswordInput(body?.password);
        if (!username || !password) return json(400, { error: "invalid_credentials_format" });
        const passwordPhc = await hashCloudRelayPassword(env.OPENCRAFT_RELAY_SIGNING_KEY, password);
        const bindingHash = await hmacSha256Hex(
          env.OPENCRAFT_RELAY_SIGNING_KEY,
          "identity-binding",
          `local:${username}`,
        );
        const candidateActorId = `actor_${crypto.randomUUID()}`;
        const bindRes = await indexShard(env, bindingHash).fetch(
          new Request(
            "https://identity-index.internal/resolve-or-register",
            internalInit("POST", {
              bindingHash,
              provider: "local",
              candidateActorId,
              passwordPhc,
              allowExistingResolve: false,
            }),
          ),
        );
        if (bindRes.status === 409) return json(409, { error: "account_already_exists" });
        if (!bindRes.ok) return json(503, { error: "registration_unavailable" });
        const { record } = (await bindRes.json()) as { record: { actorId: string } };
        const profileRes = await userStub(env, record.actorId).fetch(
          new Request(
            "https://user-relay.internal/ensure-profile",
            internalInit("POST", {
              actorId: record.actorId,
              displayName:
                typeof body?.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : username,
            }),
          ),
        );
        if (!profileRes.ok) return json(503, { error: "profile_creation_failed" });
        const { profile } = (await profileRes.json()) as {
          profile: { actorId: string; sessionEpoch: number; displayName: string };
        };
        const now = Date.now();
        const token = await issueRelaySessionToken(env.OPENCRAFT_RELAY_SIGNING_KEY, {
          sub: profile.actorId,
          ver: profile.sessionEpoch,
          iat: now,
          exp: now + SESSION_TTL_MS,
          aud: env.OPENCRAFT_RELAY_ORIGIN,
        });
        return json(
          201,
          { actorId: profile.actorId, displayName: profile.displayName, token },
          { "set-cookie": sessionCookieHeader(token, env.OPENCRAFT_RELAY_ORIGIN) },
        );
      }

      // 3b. Sign in with local account (Argon2id verified on stateless Edge Worker!)
      if (pathname === "/__opencraft_cloud/auth/login" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        const username = normalizeUsername(body?.username);
        const password = typeof body?.password === "string" ? body.password : "";
        if (!username || !password || password.length > 1024) {
          return json(401, { error: "invalid_credentials" });
        }
        const bindingHash = await hmacSha256Hex(
          env.OPENCRAFT_RELAY_SIGNING_KEY,
          "identity-binding",
          `local:${username}`,
        );
        const readRes = await indexShard(env, bindingHash).fetch(
          new Request("https://identity-index.internal/read", internalInit("POST", { bindingHash })),
        );
        if (!readRes.ok) return json(503, { error: "login_unavailable" });
        const { record } = (await readRes.json()) as {
          record: { actorId: string; passwordPhc: string | null } | null;
        };
        if (!record || !record.passwordPhc) {
          await verifyCloudRelayPassword(env.OPENCRAFT_RELAY_SIGNING_KEY, password, DUMMY_CLOUD_PASSWORD_PHC);
          return json(401, { error: "invalid_credentials" });
        }
        const verified = await verifyCloudRelayPassword(env.OPENCRAFT_RELAY_SIGNING_KEY, password, record.passwordPhc);
        if (!verified) return json(401, { error: "invalid_credentials" });
        const profileRes = await userStub(env, record.actorId).fetch(
          new Request(
            "https://user-relay.internal/ensure-profile",
            internalInit("POST", { actorId: record.actorId, displayName: username }),
          ),
        );
        if (!profileRes.ok) return json(503, { error: "profile_unavailable" });
        const { profile } = (await profileRes.json()) as {
          profile: { actorId: string; sessionEpoch: number; displayName: string };
        };
        const now = Date.now();
        const token = await issueRelaySessionToken(env.OPENCRAFT_RELAY_SIGNING_KEY, {
          sub: profile.actorId,
          ver: profile.sessionEpoch,
          iat: now,
          exp: now + SESSION_TTL_MS,
          aud: env.OPENCRAFT_RELAY_ORIGIN,
        });
        return json(
          200,
          { actorId: profile.actorId, displayName: profile.displayName, token },
          { "set-cookie": sessionCookieHeader(token, env.OPENCRAFT_RELAY_ORIGIN) },
        );
      }

      // 3c. Redeem QR / `opencraft://pair` code with Ed25519 DPoP device public key
      if (pathname === "/__opencraft_cloud/pair/redeem" && request.method === "POST") {
        const redeemLimit = Number(env.OPENCRAFT_RELAY_IP_REDEEM_LIMIT ?? DEFAULT_IP_REDEEM_LIMIT);
        const rate = await enforceIpRateLimit(
          request,
          env,
          "redeem",
          Number.isSafeInteger(redeemLimit) && redeemLimit >= 1 ? redeemLimit : DEFAULT_IP_REDEEM_LIMIT,
          10 * 60_000,
        );
        if (!rate.ok) return rate.response;
        const body = (await request.json().catch(() => null)) as {
          machineId?: unknown;
          code?: unknown;
          devicePublicKey?: unknown;
          deviceLabel?: unknown;
        } | null;
        if (
          !body ||
          typeof body.machineId !== "string" ||
          !isValidRelayMachineId(body.machineId) ||
          typeof body.code !== "string"
        ) {
          return json(400, { error: "invalid_pairing_request" });
        }
        const compound = parseCompoundToken(body.code);
        if (!compound) return json(400, { error: "invalid_pairing_code" });
        let thumbprint: string | undefined;
        if (typeof body.devicePublicKey === "string") {
          try {
            thumbprint = await computeEd25519Thumbprint(body.devicePublicKey);
          } catch {
            return json(400, { error: "invalid_device_public_key" });
          }
        }
        const redeemRes = await userStub(env, compound.actorId).fetch(
          new Request(
            "https://user-relay.internal/machines/redeem-pair",
            internalInit("POST", { machineId: body.machineId, rawSecret: compound.secret }),
          ),
        );
        if (!redeemRes.ok) return redeemRes;
        const redeemed = (await redeemRes.json()) as {
          actorId: string;
          sessionEpoch: number;
          approvalRequired: boolean;
          displayName?: string;
        };
        const now = Date.now();
        const token = await issueRelaySessionToken(env.OPENCRAFT_RELAY_SIGNING_KEY, {
          sub: redeemed.actorId,
          ver: redeemed.sessionEpoch,
          iat: now,
          exp: now + SESSION_TTL_MS,
          aud: env.OPENCRAFT_RELAY_ORIGIN,
          ...(thumbprint ? { cnf: thumbprint } : {}),
        });
        if (thumbprint) {
          const devRes = await machineStub(env, body.machineId).fetch(
            new Request(
              "https://machine-relay.internal/internal/register-device",
              internalInit("POST", {
                thumbprint,
                label: typeof body.deviceLabel === "string" ? body.deviceLabel : "Mobile Device",
                forceApprove: !redeemed.approvalRequired,
                clearRevocation: true,
              }),
            ),
          );
          const devBody = (await devRes.json()) as Record<string, unknown>;
          return json(
            devRes.status,
            {
              actorId: redeemed.actorId,
              machineId: body.machineId,
              ...(redeemed.displayName ? { displayName: redeemed.displayName } : {}),
              token,
              deviceThumbprint: thumbprint,
              ...devBody,
            },
            { "set-cookie": sessionCookieHeader(token, env.OPENCRAFT_RELAY_ORIGIN) },
          );
        }
        return json(
          200,
          {
            actorId: redeemed.actorId,
            machineId: body.machineId,
            ...(redeemed.displayName ? { displayName: redeemed.displayName } : {}),
            token,
            status: "approved",
          },
          { "set-cookie": sessionCookieHeader(token, env.OPENCRAFT_RELAY_ORIGIN) },
        );
      }

      // Authenticated control-plane endpoints below
      const caller = await authenticateCaller(request, env);
      if (!caller.ok) return caller.response;
      const actorId = caller.claims.sub;

      if (pathname === "/__opencraft_cloud/me" && request.method === "GET") {
        return userStub(env, actorId).fetch(new Request("https://user-relay.internal/summary", internalInit("GET")));
      }

      if (pathname === "/__opencraft_cloud/hub/overview" && request.method === "GET") {
        const sumRes = await userStub(env, actorId).fetch(
          new Request("https://user-relay.internal/summary", internalInit("GET")),
        );
        if (!sumRes.ok) return sumRes;
        const summary = (await sumRes.json()) as {
          profile: Record<string, unknown>;
          machines: ReadonlyArray<{
            machineId: string;
            displayName: string;
            approvalRequired: boolean;
            createdAt: number;
          }>;
          passkeys?: ReadonlyArray<{ credentialId: string; label: string; createdAt: number; lastUsedAt: number }>;
          threadIndex?: ReadonlyArray<{
            machineId: string;
            threadId: string;
            title: string;
            status: string;
            updatedAt: number;
          }>;
        };

        const enrichedMachinesRaw = await Promise.all(
          summary.machines.map(async (m) => {
            try {
              if (caller.deviceThumbprint && !m.approvalRequired) {
                const regRes = await machineStub(env, m.machineId).fetch(
                  new Request(
                    "https://machine-relay.internal/internal/register-device",
                    internalInit("POST", {
                      thumbprint: caller.deviceThumbprint,
                      label: "Personal Hub Browser",
                      forceApprove: true,
                    }),
                  ),
                );
                if (regRes.status === 403) return null;
              }
              const inspRes = await machineStub(env, m.machineId).fetch(
                new Request("https://machine-relay.internal/internal/inspect", internalInit("GET")),
              );
              if (inspRes.ok) {
                const insp = (await inspRes.json()) as {
                  online?: boolean;
                  activeWsStreams?: number;
                  directRoutesCount?: number;
                  displayName?: string;
                };
                return {
                  ...m,
                  displayName: insp.displayName || m.displayName,
                  online: Boolean(insp.online),
                  activeWatchers: insp.activeWsStreams ?? 0,
                  directRoutesCount: insp.directRoutesCount ?? 0,
                };
              }
            } catch {
              /* Keep offline fallback */
            }
            return { ...m, online: false, activeWatchers: 0, directRoutesCount: 0 };
          }),
        );
        const enrichedMachines = enrichedMachinesRaw.filter((m): m is NonNullable<typeof m> => m !== null);

        return json(200, {
          actorId,
          profile: summary.profile,
          passkeys: summary.passkeys ?? [],
          machines: enrichedMachines,
          threadIndex: summary.threadIndex ?? [],
        });
      }

      if (pathname === "/__opencraft_cloud/machines/claim" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as { ticket?: unknown; browserLabel?: unknown } | null;
        if (!body || typeof body.ticket !== "string") {
          return json(400, { error: "invalid_claim_ticket" });
        }
        const verifiedTicket = await verifyMachineClaimTicket(body.ticket, env.OPENCRAFT_RELAY_ORIGIN);
        if (!verifiedTicket || !isValidRelayMachineId(verifiedTicket.machineId)) {
          return json(400, { error: "expired_or_invalid_claim_ticket" });
        }
        let ownerThumbprint: string;
        try {
          ownerThumbprint = await computeEd25519Thumbprint(verifiedTicket.ownerPublicKey);
        } catch {
          return json(400, { error: "invalid_owner_public_key" });
        }

        const transferRes = await machineStub(env, verifiedTicket.machineId).fetch(
          new Request(
            "https://machine-relay.internal/internal/transfer-owner",
            internalInit("POST", {
              newOwnerActorId: actorId,
              ownerDeviceThumbprint: ownerThumbprint,
              displayName: verifiedTicket.displayName,
              ...(caller.deviceThumbprint ? { approvedBrowserThumbprint: caller.deviceThumbprint } : {}),
              ...(typeof body.browserLabel === "string" ? { approvedBrowserLabel: body.browserLabel } : {}),
            }),
          ),
        );
        if (!transferRes.ok) return transferRes;
        const transferred = (await transferRes.json()) as {
          prevOwnerActorId: string;
          secretHash: string;
          approvalRequired: boolean;
          displayName: string;
        };

        const adoptRes = await userStub(env, actorId).fetch(
          new Request(
            "https://user-relay.internal/machines/adopt",
            internalInit("POST", {
              machineId: verifiedTicket.machineId,
              displayName: transferred.displayName,
              secretHash: transferred.secretHash,
              approvalRequired: transferred.approvalRequired,
            }),
          ),
        );
        if (!adoptRes.ok) return adoptRes;

        if (transferred.prevOwnerActorId && transferred.prevOwnerActorId !== actorId) {
          await userStub(env, transferred.prevOwnerActorId)
            .fetch(
              new Request(
                "https://user-relay.internal/machines/detach",
                internalInit("POST", { machineId: verifiedTicket.machineId }),
              ),
            )
            .catch(() => undefined);
        }

        return json(200, {
          ok: true,
          actorId,
          machineId: verifiedTicket.machineId,
          displayName: transferred.displayName,
          prevOwnerActorId: transferred.prevOwnerActorId,
        });
      }

      const threadIdxMatch = /^\/__opencraft_cloud\/machines\/([0-9a-f-]{36})\/thread-index$/u.exec(pathname);
      if (threadIdxMatch && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as { threads?: unknown } | null;
        if (!body || !Array.isArray(body.threads)) return json(400, { error: "invalid_threads" });
        return userStub(env, actorId).fetch(
          new Request(
            "https://user-relay.internal/machines/thread-index",
            internalInit("POST", { machineId: threadIdxMatch[1], threads: body.threads }),
          ),
        );
      }

      if (pathname === "/__opencraft_cloud/machines" && request.method === "POST") {
        const hint = inferLocationHint(request, env);
        return userStub(env, actorId, hint).fetch(
          new Request(
            "https://user-relay.internal/machines/enroll",
            internalInit("POST", await request.json(), hint ? { "x-opencraft-location-hint": hint } : {}),
          ),
        );
      }

      const pairMatch = /^\/__opencraft_cloud\/machines\/([0-9a-f-]{36})\/pair-code$/u.exec(pathname);
      if (pairMatch && request.method === "POST") {
        const extra = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        return userStub(env, actorId).fetch(
          new Request(
            "https://user-relay.internal/machines/pair-code",
            internalInit("POST", { ...extra, machineId: pairMatch[1] }),
          ),
        );
      }

      const approveMatch = /^\/__opencraft_cloud\/machines\/([0-9a-f-]{36})\/approve-device$/u.exec(pathname);
      if (approveMatch && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { shortCode?: unknown };
        if (typeof body.shortCode !== "string") return json(400, { error: "invalid_short_code" });
        return machineStub(env, approveMatch[1]!).fetch(
          new Request(
            "https://machine-relay.internal/internal/approve-device",
            internalInit("POST", { actorId, shortCode: body.shortCode }),
          ),
        );
      }

      const revokeDevMatch = /^\/__opencraft_cloud\/machines\/([0-9a-f-]{36})\/revoke-device$/u.exec(pathname);
      if (revokeDevMatch && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { thumbprint?: unknown };
        if (typeof body.thumbprint !== "string" || !body.thumbprint.trim()) {
          return json(400, { error: "invalid_device_thumbprint" });
        }
        return machineStub(env, revokeDevMatch[1]!).fetch(
          new Request(
            "https://machine-relay.internal/internal/revoke-device",
            internalInit("POST", { actorId, thumbprint: body.thumbprint.trim() }),
          ),
        );
      }

      const revokeMachMatch = /^\/__opencraft_cloud\/machines\/([0-9a-f-]{36})\/revoke$/u.exec(pathname);
      if (revokeMachMatch && request.method === "POST") {
        return userStub(env, actorId).fetch(
          new Request(
            "https://user-relay.internal/machines/revoke",
            internalInit("POST", { machineId: revokeMachMatch[1] }),
          ),
        );
      }

      if (pathname === "/__opencraft_cloud/shares" && request.method === "POST") {
        return userStub(env, actorId).fetch(
          new Request("https://user-relay.internal/shares/create", internalInit("POST", await request.json())),
        );
      }

      if (pathname === "/__opencraft_cloud/shares/claim" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as { shareToken?: unknown } | null;
        if (!body || typeof body.shareToken !== "string") return json(400, { error: "invalid_share_token" });
        const compound = parseCompoundToken(body.shareToken);
        if (!compound) return json(400, { error: "invalid_share_token" });
        return userStub(env, compound.actorId).fetch(
          new Request(
            "https://user-relay.internal/shares/claim",
            internalInit("POST", { rawSecret: compound.secret, granteeActorId: actorId }),
          ),
        );
      }

      const revokeShareMatch = /^\/__opencraft_cloud\/shares\/([0-9a-f-]{36})\/revoke$/u.exec(pathname);
      if (revokeShareMatch && request.method === "POST") {
        return userStub(env, actorId).fetch(
          new Request(
            "https://user-relay.internal/shares/revoke",
            internalInit("POST", { grantId: revokeShareMatch[1] }),
          ),
        );
      }

      if (pathname === "/__opencraft_cloud/license/activate" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as { licenseKey?: unknown } | null;
        if (!body || typeof body.licenseKey !== "string") return json(400, { error: "invalid_license_key" });
        const hint = inferLocationHint(request, env);
        const outcome = await applyVerifiedLicenseToActor(env, actorId, body.licenseKey.trim(), hint);
        if (!outcome.ok) return json(outcome.status, { error: outcome.error });
        return json(200, outcome);
      }

      return json(404, { error: "not_found" });
    }

    // ---- 4. Per-Machine Data-Plane, Route Hints & R2 Ticket Issuance (`/m/:machineId/*`) ----
    const machineRouteMatch = /^\/m\/([0-9a-f-]{36})(\/.*)?$/u.exec(pathname);
    if (machineRouteMatch) {
      const machineId = machineRouteMatch[1]!;
      const forwardSearch = new URLSearchParams(url.searchParams);
      forwardSearch.delete("access_token");
      forwardSearch.delete("dpop");
      const searchSuffix = forwardSearch.toString() ? `?${forwardSearch.toString()}` : "";
      const subPath = (machineRouteMatch[2] || "/") + searchSuffix;
      if (!isValidRelayMachineId(machineId)) return json(404, { error: "invalid_machine_id" });

      // Test/diagnostics inspection endpoint (metadata only, no secrets)
      if (machineRouteMatch[2] === "/__inspect" && request.method === "GET") {
        const caller = await authenticateCaller(request, env);
        if (!caller.ok) return caller.response;
        return machineStub(env, machineId).fetch(
          new Request("https://machine-relay.internal/internal/inspect", internalInit("GET")),
        );
      }

      const caller = await authenticateCaller(request, env);
      if (!caller.ok) return caller.response;
      const grantId = url.searchParams.get("grant") ?? request.headers.get("x-opencraft-grant-id") ?? undefined;

      if (machineRouteMatch[2] === "/__routes" && request.method === "GET") {
        return machineStub(env, machineId).fetch(
          new Request(
            "https://machine-relay.internal/internal/authorize-routes",
            internalInit("POST", {
              actorId: caller.claims.sub,
              ...(caller.deviceThumbprint ? { deviceThumbprint: caller.deviceThumbprint } : {}),
              ...(grantId ? { grantId } : {}),
            }),
          ),
        );
      }

      if (machineRouteMatch[2] === "/__blobs/ticket" && request.method === "POST") {
        if (!env.RELAY_BLOBS) return json(503, { error: "blob_offload_not_configured" });
        const authRes = await machineStub(env, machineId).fetch(
          new Request(
            "https://machine-relay.internal/internal/authorize-routes",
            internalInit("POST", {
              actorId: caller.claims.sub,
              ...(caller.deviceThumbprint ? { deviceThumbprint: caller.deviceThumbprint } : {}),
              ...(grantId ? { grantId } : {}),
            }),
          ),
        );
        if (!authRes.ok) return authRes;
        const authMeta = (await authRes.json()) as { maxBlobBytes?: number };
        const allowedMaxBlobBytes = Math.min(
          typeof authMeta.maxBlobBytes === "number" && authMeta.maxBlobBytes > 0
            ? authMeta.maxBlobBytes
            : 16 * 1024 * 1024,
          MAX_BLOB_OFFLOAD_BYTES,
        );
        const body = (await request.json().catch(() => null)) as {
          blobKey?: unknown;
          mode?: unknown;
          maxBytes?: unknown;
          sha256?: unknown;
        } | null;
        if (
          !body ||
          typeof body.blobKey !== "string" ||
          !/^[A-Za-z0-9._/-]{1,256}$/u.test(body.blobKey) ||
          body.blobKey.includes("..") ||
          (body.mode !== "put" && body.mode !== "get")
        ) {
          return json(400, { error: "invalid_blob_request" });
        }
        if (typeof body.maxBytes === "number" && body.maxBytes > allowedMaxBlobBytes) {
          return json(413, { error: "blob_exceeds_plan_limit", allowedMaxBlobBytes });
        }
        const maxBytes =
          typeof body.maxBytes === "number" && Number.isSafeInteger(body.maxBytes) && body.maxBytes > 0
            ? Math.min(body.maxBytes, allowedMaxBlobBytes)
            : allowedMaxBlobBytes;
        const ticket = await issueBlobOffloadTicket(env.OPENCRAFT_RELAY_SIGNING_KEY, {
          machineId,
          blobKey: body.blobKey,
          mode: body.mode,
          maxBytes,
          ...(typeof body.sha256 === "string" ? { sha256: body.sha256 } : {}),
          actorId: caller.claims.sub,
          exp: Date.now() + BLOB_TICKET_TTL_MS,
        });
        return json(200, {
          ticket,
          url: `${env.OPENCRAFT_RELAY_ORIGIN}${RELAY_BLOBS_PATH_PREFIX}${encodeURIComponent(body.blobKey)}?ticket=${encodeURIComponent(ticket)}`,
          maxBytes,
        });
      }

      if (!relayPathAllowed(subPath)) return json(403, { error: "access_denied" });

      const headers = new Headers(request.headers);
      headers.delete("cookie");
      headers.delete("authorization");
      headers.set(INTERNAL_CALLER_HEADER, INTERNAL_CALLER_VALUE);
      headers.set("x-opencraft-actor-id", caller.claims.sub);
      headers.set("x-opencraft-target-path", subPath);
      headers.set("x-opencraft-target-method", request.method);
      if (caller.deviceThumbprint) headers.set("x-opencraft-device-thumbprint", caller.deviceThumbprint);
      if (grantId) headers.set("x-opencraft-grant-id", grantId);

      return machineStub(env, machineId).fetch(
        new Request("https://machine-relay.internal/internal/client-forward", {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        }),
      );
    }

    // ---- 5. Offload 1: Workers Static Assets (Workbench SPA) ----
    if (env.ASSETS && (request.method === "GET" || request.method === "HEAD")) {
      const wrapHead = (res: Response) =>
        request.method === "HEAD"
          ? new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers })
          : res;
      const targetPath = pathname === "/" ? "/index.html" : pathname;
      const assetRes = await env.ASSETS.fetch(new Request(new URL(targetPath, url.origin), { method: "GET" }));
      if (assetRes.status !== 404) return wrapHead(assetRes);
      const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
      const isSpaRoute =
        !lastSegment.includes(".") ||
        pathname === "/pair" ||
        pathname.startsWith("/s/") ||
        Boolean(request.headers.get("accept")?.includes("text/html"));
      if (isSpaRoute) {
        const spaRes = await env.ASSETS.fetch(new Request(new URL("/index.html", url.origin), { method: "GET" }));
        return wrapHead(spaRes);
      }
    }

    return json(404, { error: "not_found" });
  },
};
