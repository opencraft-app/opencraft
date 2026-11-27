// Pure WebCrypto primitives shared across the stateless Edge Worker and sharded DOs.
// Zero `node:*` runtime imports so bundles run in workerd without nodejs_compat overhead.
import { verifyHashcashPow } from "@opencraft/relay-protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.byteLength; i++) out += view[i]!.toString(16).padStart(2, "0");
  return out;
}

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.byteLength; i++) binary += String.fromCharCode(view[i]!);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new Error("Invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? encoder.encode(input) : input;
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return toHex(await crypto.subtle.digest("SHA-256", copy.buffer));
}

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

function getHmacKey(secret: string, purpose: string): Promise<CryptoKey> {
  if (!secret || secret.length < 16) throw new Error("Signing key must be at least 16 characters");
  const cacheKey = `${purpose}:${secret}`;
  let pending = hmacKeyCache.get(cacheKey);
  if (!pending) {
    pending = crypto.subtle.importKey(
      "raw",
      encoder.encode(`${purpose}:${secret}`),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    hmacKeyCache.set(cacheKey, pending);
  }
  return pending;
}

export async function hmacSha256Hex(secret: string, purpose: string, message: string): Promise<string> {
  const key = await getHmacKey(secret, purpose);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.byteLength !== b.byteLength) return false;
  const subtle = crypto.subtle as unknown as { timingSafeEqual?: (x: Uint8Array, y: Uint8Array) => boolean };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function randomBase64Url(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

const SHORT_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Unambiguous 6-character device approval code formatted as `XXX-XXX`. */
export function randomApprovalCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let chars = "";
  for (let i = 0; i < 6; i++) chars += SHORT_ALPHABET[bytes[i]! % SHORT_ALPHABET.length];
  return `${chars.slice(0, 3)}-${chars.slice(3, 6)}`;
}

const PBKDF2_ITERATIONS = 100_000;
const PASSWORD_PEPPER_PURPOSE = "opencraft-cloud-relay-password-pepper-v1";
export const DUMMY_CLOUD_PASSWORD_PHC = `$pbkdf2-sha256$i=${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

async function derivePbkdf2Sha256(
  signingKey: string,
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const pepperKey = await getHmacKey(signingKey, PASSWORD_PEPPER_PURPOSE);
  const peppered = await crypto.subtle.sign("HMAC", pepperKey, encoder.encode(password));
  const baseKey = await crypto.subtle.importKey("raw", peppered, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations,
    },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Native WebCrypto PBKDF2-HMAC-SHA256 (`100,000` iterations) + HMAC server pepper.
 * Executes in native BoringSSL C++ on Cloudflare Workers (<2ms isolate CPU vs
 * ~800-1,050ms pure-JS Argon2id that triggers Cloudflare Error 1102 CPU limits).
 */
export async function hashCloudRelayPassword(signingKey: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derivePbkdf2Sha256(signingKey, password, salt, PBKDF2_ITERATIONS);
  return `$pbkdf2-sha256$i=${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

export async function verifyCloudRelayPassword(signingKey: string, password: string, phc: string): Promise<boolean> {
  const parts = phc.split("$");
  // ["", "pbkdf2-sha256", "i=100000", "<salt>", "<hash>"]
  if (parts.length !== 5 || parts[1] !== "pbkdf2-sha256" || !parts[2]?.startsWith("i=")) {
    return false;
  }
  const iterations = Number(parts[2].slice(2));
  if (!Number.isSafeInteger(iterations) || iterations < 10_000 || iterations > 100_000) {
    return false;
  }
  try {
    const salt = fromBase64Url(parts[3]!);
    const expected = fromBase64Url(parts[4]!);
    if (salt.byteLength < 12 || expected.byteLength !== 32) return false;
    const actual = await derivePbkdf2Sha256(signingKey, password, salt, iterations);
    if (actual.byteLength !== expected.byteLength) return false;
    let diff = 0;
    for (let i = 0; i < actual.byteLength; i++) diff |= actual[i]! ^ expected[i]!;
    return diff === 0;
  } catch {
    return false;
  }
}

export interface RelaySessionClaims {
  readonly sub: string;
  readonly ver: number;
  readonly iat: number;
  readonly exp: number;
  readonly aud: string;
  /** Optional device thumbprint when bound to a paired client device key (DPoP). */
  readonly cnf?: string;
}

const SESSION_PURPOSE = "opencraft-cloud-relay-session-v1";

export async function issueRelaySessionToken(signingKey: string, claims: RelaySessionClaims): Promise<string> {
  const header = toBase64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "oc-relay+jwt" })));
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const key = await getHmacKey(signingKey, SESSION_PURPOSE);
  const sig = toBase64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput)));
  return `${signingInput}.${sig}`;
}

export async function verifyRelaySessionToken(
  signingKey: string,
  token: string,
  expectedAudience: string,
  now = Date.now(),
): Promise<RelaySessionClaims | null> {
  if (!token || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  try {
    const key = await getHmacKey(signingKey, SESSION_PURPOSE);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(sig) as BufferSource,
      encoder.encode(`${header}.${payload}`),
    );
    if (!valid) return null;
    const hdr = JSON.parse(decoder.decode(fromBase64Url(header))) as { alg?: unknown; typ?: unknown };
    if (hdr.alg !== "HS256" || hdr.typ !== "oc-relay+jwt") return null;
    const parsed = JSON.parse(decoder.decode(fromBase64Url(payload))) as Partial<RelaySessionClaims>;
    if (
      typeof parsed.sub !== "string" ||
      !parsed.sub ||
      typeof parsed.ver !== "number" ||
      !Number.isSafeInteger(parsed.ver) ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number" ||
      parsed.exp <= now ||
      parsed.aud !== expectedAudience ||
      (parsed.cnf !== undefined && (typeof parsed.cnf !== "string" || !/^[a-f0-9]{64}$/u.test(parsed.cnf)))
    ) {
      return null;
    }
    return {
      sub: parsed.sub,
      ver: parsed.ver,
      iat: parsed.iat,
      exp: parsed.exp,
      aud: parsed.aud,
      ...(parsed.cnf ? { cnf: parsed.cnf } : {}),
    };
  } catch {
    return null;
  }
}

export interface BlobOffloadTicketClaims {
  readonly machineId: string;
  readonly blobKey: string;
  readonly mode: "put" | "get";
  readonly maxBytes: number;
  readonly sha256?: string;
  readonly actorId: string;
  readonly exp: number;
}

const BLOB_PURPOSE = "opencraft-cloud-relay-blob-v1";

export async function issueBlobOffloadTicket(signingKey: string, claims: BlobOffloadTicketClaims): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const key = await getHmacKey(signingKey, BLOB_PURPOSE);
  const sig = toBase64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return `${payload}.${sig}`;
}

export async function verifyBlobOffloadTicket(
  signingKey: string,
  ticket: string,
  now = Date.now(),
): Promise<BlobOffloadTicketClaims | null> {
  if (!ticket || ticket.length > 2048) return null;
  const dot = ticket.indexOf(".");
  if (dot <= 0 || dot !== ticket.lastIndexOf(".")) return null;
  const payload = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);
  try {
    const key = await getHmacKey(signingKey, BLOB_PURPOSE);
    const valid = await crypto.subtle.verify("HMAC", key, fromBase64Url(sig) as BufferSource, encoder.encode(payload));
    if (!valid) return null;
    const parsed = JSON.parse(decoder.decode(fromBase64Url(payload))) as Partial<BlobOffloadTicketClaims>;
    if (
      typeof parsed.machineId !== "string" ||
      typeof parsed.blobKey !== "string" ||
      !parsed.blobKey ||
      (parsed.mode !== "put" && parsed.mode !== "get") ||
      typeof parsed.maxBytes !== "number" ||
      !Number.isSafeInteger(parsed.maxBytes) ||
      parsed.maxBytes <= 0 ||
      typeof parsed.actorId !== "string" ||
      typeof parsed.exp !== "number" ||
      parsed.exp <= now ||
      (parsed.sha256 !== undefined && (typeof parsed.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(parsed.sha256)))
    ) {
      return null;
    }
    return {
      machineId: parsed.machineId,
      blobKey: parsed.blobKey,
      mode: parsed.mode,
      maxBytes: parsed.maxBytes,
      actorId: parsed.actorId,
      exp: parsed.exp,
      ...(parsed.sha256 ? { sha256: parsed.sha256 } : {}),
    };
  } catch {
    return null;
  }
}

export interface DeviceDpopProof {
  /** Base64url raw 32-byte Ed25519 public key. */
  readonly publicKey: string;
  readonly method: string;
  readonly url: string;
  readonly timestamp: number;
  readonly nonce: string;
  /** Base64url 64-byte Ed25519 signature over `opencraft-dpop.v1\n<method>\n<url>\n<timestamp>\n<nonce>`. */
  readonly signature: string;
}

const DPOP_SKEW_MS = 5 * 60_000;

export function formatDpopSigningInput(input: Omit<DeviceDpopProof, "publicKey" | "signature">): Uint8Array {
  return encoder.encode(
    `opencraft-dpop.v1\n${input.method.toUpperCase()}\n${input.url}\n${input.timestamp}\n${input.nonce}`,
  );
}

export async function computeEd25519Thumbprint(publicKeyBase64Url: string): Promise<string> {
  const raw = fromBase64Url(publicKeyBase64Url);
  if (raw.byteLength !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return sha256Hex(raw);
}

/**
 * Verifies an Ed25519 DPoP header (`x-opencraft-dpop: <base64url JSON DeviceDpopProof>`)
 * and returns the verified 64-hex SHA-256 device thumbprint.
 */
export async function verifyDeviceDpopHeader(
  headerValue: string,
  expectedMethod: string,
  expectedUrl: string,
  now = Date.now(),
): Promise<{ readonly thumbprint: string; readonly nonce: string } | null> {
  if (!headerValue || headerValue.length > 4096) return null;
  try {
    const parsed = JSON.parse(decoder.decode(fromBase64Url(headerValue))) as Partial<DeviceDpopProof>;
    if (
      typeof parsed.publicKey !== "string" ||
      typeof parsed.method !== "string" ||
      typeof parsed.url !== "string" ||
      typeof parsed.timestamp !== "number" ||
      !Number.isSafeInteger(parsed.timestamp) ||
      Math.abs(now - parsed.timestamp) > DPOP_SKEW_MS ||
      typeof parsed.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{12,64}$/u.test(parsed.nonce) ||
      typeof parsed.signature !== "string"
    ) {
      return null;
    }
    if (parsed.method.toUpperCase() !== expectedMethod.toUpperCase() || parsed.url !== expectedUrl) {
      return null;
    }
    const pubBytes = fromBase64Url(parsed.publicKey);
    const sigBytes = fromBase64Url(parsed.signature);
    if (pubBytes.byteLength !== 32 || sigBytes.byteLength !== 64) return null;
    const key = await crypto.subtle.importKey("raw", pubBytes as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    const message = formatDpopSigningInput({
      method: parsed.method,
      url: parsed.url,
      timestamp: parsed.timestamp,
      nonce: parsed.nonce,
    });
    const ok = await crypto.subtle.verify("Ed25519", key, sigBytes as BufferSource, message as BufferSource);
    if (!ok) return null;
    return { thumbprint: await sha256Hex(pubBytes), nonce: parsed.nonce };
  } catch {
    return null;
  }
}

// ---- Stateless Hashcash Proof-of-Work Challenge & Verification --------------

const POW_PURPOSE = "opencraft-cloud-relay-pow-v1";
export const POW_CHALLENGE_TTL_MS = 2 * 60_000;

export interface PowChallengeClaims {
  readonly purpose: "enroll" | "redeem";
  readonly ipHash: string;
  readonly bits: number;
  readonly exp: number;
  readonly rnd: string;
}

export async function issuePowChallenge(
  signingKey: string,
  input: {
    readonly purpose: "enroll" | "redeem";
    readonly ipHash: string;
    readonly bits: number;
    readonly now?: number;
  },
): Promise<{ readonly challenge: string; readonly bits: number; readonly expiresAt: number }> {
  const now = input.now ?? Date.now();
  const expiresAt = now + POW_CHALLENGE_TTL_MS;
  const claims: PowChallengeClaims = {
    purpose: input.purpose,
    ipHash: input.ipHash,
    bits: input.bits,
    exp: expiresAt,
    rnd: randomBase64Url(12),
  };
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const key = await getHmacKey(signingKey, POW_PURPOSE);
  const sig = toBase64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return { challenge: `${payload}.${sig}`, bits: input.bits, expiresAt };
}

/**
 * Verifies `x-opencraft-pow: <challenge>.<nonce>` in <0.1ms (1 HMAC + 1 SHA-256)
 * at the stateless Edge Worker before touching any Durable Object.
 */
export async function verifyPowHeader(
  signingKey: string,
  headerValue: string | null,
  expected: {
    readonly purpose: "enroll" | "redeem";
    readonly ipHash: string;
    readonly minBits: number;
    readonly now?: number;
  },
): Promise<boolean> {
  if (!headerValue || headerValue.length > 1024) return false;
  const lastColon = headerValue.lastIndexOf(":");
  if (lastColon <= 0) return false;
  const challenge = headerValue.slice(0, lastColon);
  const nonce = headerValue.slice(lastColon + 1);
  const dot = challenge.indexOf(".");
  if (dot <= 0 || dot !== challenge.lastIndexOf(".")) return false;
  const payload = challenge.slice(0, dot);
  const sig = challenge.slice(dot + 1);
  try {
    const key = await getHmacKey(signingKey, POW_PURPOSE);
    const validSig = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(sig) as BufferSource,
      encoder.encode(payload),
    );
    if (!validSig) return false;
    const claims = JSON.parse(decoder.decode(fromBase64Url(payload))) as Partial<PowChallengeClaims>;
    const now = expected.now ?? Date.now();
    if (
      claims.purpose !== expected.purpose ||
      claims.ipHash !== expected.ipHash ||
      typeof claims.bits !== "number" ||
      claims.bits < expected.minBits ||
      typeof claims.exp !== "number" ||
      claims.exp <= now
    ) {
      return false;
    }
    return verifyHashcashPow(challenge, nonce, claims.bits);
  } catch {
    return false;
  }
}

// ---- Mullvad / Surge Style Cryptographic License Keys (`ocl1_...`) ----------

const LICENSE_PURPOSE = "opencraft-cloud-relay-license-v1";

export interface RelayLicenseClaims {
  readonly lid: string;
  readonly tier: "pro" | "team";
  readonly machineLimit: number;
  readonly maxBlobBytes: number;
  readonly exp: number;
}

export async function issueRelayLicenseKey(licenseSigningKey: string, claims: RelayLicenseClaims): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const key = await getHmacKey(licenseSigningKey, LICENSE_PURPOSE);
  const sig = toBase64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return `ocl1.${payload}.${sig}`;
}

export async function verifyRelayLicenseKey(
  licenseSigningKey: string,
  licenseKey: string,
  now = Date.now(),
): Promise<RelayLicenseClaims | null> {
  if (typeof licenseKey !== "string" || !licenseKey.startsWith("ocl1.") || licenseKey.length > 1024) {
    return null;
  }
  const rest = licenseKey.slice(5);
  const sep = rest.indexOf(".");
  if (sep <= 0 || sep !== rest.lastIndexOf(".")) return null;
  const payload = rest.slice(0, sep);
  const sig = rest.slice(sep + 1);
  try {
    const key = await getHmacKey(licenseSigningKey, LICENSE_PURPOSE);
    const ok = await crypto.subtle.verify("HMAC", key, fromBase64Url(sig) as BufferSource, encoder.encode(payload));
    if (!ok) return null;
    const parsed = JSON.parse(decoder.decode(fromBase64Url(payload))) as Partial<RelayLicenseClaims>;
    if (
      typeof parsed.lid !== "string" ||
      !/^[A-Za-z0-9_-]{8,64}$/u.test(parsed.lid) ||
      (parsed.tier !== "pro" && parsed.tier !== "team") ||
      typeof parsed.machineLimit !== "number" ||
      !Number.isSafeInteger(parsed.machineLimit) ||
      parsed.machineLimit < 1 ||
      parsed.machineLimit > 500 ||
      typeof parsed.maxBlobBytes !== "number" ||
      !Number.isSafeInteger(parsed.maxBlobBytes) ||
      parsed.maxBlobBytes < 1024 * 1024 ||
      parsed.maxBlobBytes > 5 * 1024 * 1024 * 1024 ||
      typeof parsed.exp !== "number" ||
      parsed.exp <= now
    ) {
      return null;
    }
    return {
      lid: parsed.lid,
      tier: parsed.tier,
      machineLimit: parsed.machineLimit,
      maxBlobBytes: parsed.maxBlobBytes,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}
