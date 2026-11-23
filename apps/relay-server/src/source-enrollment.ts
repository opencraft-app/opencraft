import { createHash, createPublicKey } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import { HUB_ENROLLMENT_PATH, type HubEnrollmentProof } from "@opencraft/hub-network/enrollment";
import { hubId, verified } from "@opencraft/hub-network/store";
import { publicOrigin } from "@opencraft/hub-network";
import type { RelayHub } from "./cluster-port.js";
import type { RelayRedis } from "./redis.js";
import type { RelayIngress } from "./server.js";

export { HUB_ENROLLMENT_PATH };
const NONCE_TTL_MS = 600_000,
  MAX_NONCES = 8192,
  MAX_BODY = 8192,
  SKEW_MS = 300_000;
const fields = ["audience", "relay", "hubId", "publicKey", "origin", "timestamp", "nonce", "signature"];

export interface SourceEnrollmentOptions {
  hub: RelayHub;
  /** Returns the canonical source address when the TCP peer may enroll, else null. */
  allowSource: (address: string | undefined) => string | null;
  /** Shared replay fence across replicas; without it the fence is process local. */
  redis?: RelayRedis;
  /** Entry and route origins that a self-enrolled node may never claim. */
  reservedOrigins?: readonly string[];
}

/**
 * Serves the Hub's address-based join (`requestHubEnrollment`) for machines
 * whose TCP source is inside a configured network. Authority comes only from
 * the directly connected TLS peer address: forwarded headers, Origin and
 * enterprise identity headers never widen it. The proof still binds the
 * joining node key, the relay endpoint, a fresh timestamp and a one-time nonce.
 */
export function createSourceEnrollmentIngress(options: SourceEnrollmentOptions): RelayIngress {
  const { hub, allowSource, redis } = options,
    reserved = new Set(options.reservedOrigins ?? []);
  let closed = false;
  const pending = new Set<Promise<void>>(),
    seen = new Map<string, number>();
  async function claim(key: string) {
    const now = Date.now(),
      expiry = now + NONCE_TTL_MS;
    if (redis) {
      return Number(
        await redis.evaluate(
          `redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',ARGV[1]);if redis.call('EXISTS',KEYS[1])==1 then return 0 end;if redis.call('ZCARD',KEYS[2])>=tonumber(ARGV[4]) then return -1 end;redis.call('SET',KEYS[1],'1','PX',ARGV[5]);redis.call('ZADD',KEYS[2],ARGV[2],ARGV[3]);return 1`,
          ["hub-enrollment:nonce:" + key, "hub-enrollment:nonces"],
          [now, expiry, key, MAX_NONCES, NONCE_TTL_MS],
        ),
      );
    }
    for (const [id, until] of seen) {
      if (until > now) break;
      seen.delete(id);
    }
    if (seen.has(key)) return 0;
    if (seen.size >= MAX_NONCES) return -1;
    seen.set(key, expiry);
    return 1;
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const source = allowSource(req.socket.remoteAddress);
    const deadline = setTimeout(() => req.destroy(), 10_000);
    deadline.unref();
    const finish = (code: number, error?: string, invitation?: string) => {
      if (res.destroyed) return;
      if (code >= 400) res.setHeader("connection", "close");
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(error ? { error } : { invitation }));
    };
    try {
      if (!source || (req.socket as TLSSocket).encrypted !== true || req.headers.origin !== undefined)
        return finish(403, "source_denied");
      if (req.method !== "POST") return finish(405, "method");
      if (closed) return finish(503, "unavailable");
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_BODY) return finish(413, "request_too_large");
        chunks.push(chunk);
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        return finish(400, "invalid_request");
      }
      const endpoint = hub.snapshot().endpoint;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !fields.includes(key)) ||
        body.audience !== "opencraft-hub-enrollment.v1" ||
        !endpoint ||
        body.relay !== endpoint ||
        typeof body.hubId !== "string" ||
        typeof body.publicKey !== "string" ||
        body.publicKey.length > 4096 ||
        typeof body.origin !== "string" ||
        !Number.isSafeInteger(body.timestamp) ||
        Math.abs(Date.now() - Number(body.timestamp)) > SKEW_MS ||
        typeof body.nonce !== "string" ||
        !/^[-_A-Za-z0-9]{43}$/u.test(body.nonce) ||
        typeof body.signature !== "string" ||
        body.signature.length > 128
      )
        return finish(400, "invalid_request");
      if (body.origin) {
        try {
          publicOrigin(body.origin);
        } catch {
          return finish(400, "invalid_request");
        }
        if (reserved.has(body.origin) || body.origin === endpoint) return finish(409, "origin_unavailable");
      }
      let key;
      try {
        key = createPublicKey(body.publicKey);
      } catch {
        return finish(403, "identity_denied");
      }
      if (key.asymmetricKeyType !== "ed25519" || hubId(body.publicKey) !== body.hubId)
        return finish(403, "identity_denied");
      const proof: HubEnrollmentProof = {
        audience: "opencraft-hub-enrollment.v1",
        relay: endpoint,
        hubId: body.hubId,
        publicKey: body.publicKey,
        origin: body.origin,
        timestamp: Number(body.timestamp),
        nonce: body.nonce,
      };
      if (!verified(proof, body.signature, body.publicKey)) return finish(403, "identity_denied");
      const claimed = await claim(
        createHash("sha256")
          .update(body.hubId + ":" + body.nonce)
          .digest("hex"),
      );
      if (claimed !== 1) return finish(claimed === 0 ? 409 : 503, claimed === 0 ? "replayed_request" : "unavailable");
      let revision = hub.snapshot().revision;
      // A lagging replica retries with the owner's committed revision.
      for (let attempt = 0; attempt < 8; attempt++) {
        if (closed || res.destroyed) return finish(503, "unavailable");
        const result = await hub.command(
          { action: "enroll", revision, peer: { hubId: body.hubId, publicKey: body.publicKey }, origin: body.origin },
          "source-ip:" + source,
        );
        if ("conflict" in result) {
          revision = result.snapshot.revision;
          continue;
        }
        if (!("invitation" in result) || typeof result.invitation !== "string")
          throw new Error("Enrollment unavailable");
        return finish(200, undefined, result.invitation);
      }
      finish(503, "unavailable");
    } catch {
      if (!res.headersSent) finish(503, "unavailable");
      else res.destroy();
    } finally {
      clearTimeout(deadline);
    }
  }
  const ingress: RelayIngress = (req, res) => {
    if (req.url !== HUB_ENROLLMENT_PATH) return false;
    const job = handle(req, res);
    pending.add(job);
    void job.finally(() => pending.delete(job)).catch(() => res.destroy());
    return true;
  };
  ingress.close = async () => {
    closed = true;
    await Promise.allSettled([...pending]);
    seen.clear();
  };
  return ingress;
}
