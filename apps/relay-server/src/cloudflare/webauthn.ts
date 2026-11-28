// Zero-dependency runtime-neutral WebAuthn Passkey (Level 3) Relying Party verifier
// built purely on WebCrypto (`crypto.subtle`), supporting ES256 (P-256) and EdDSA (Ed25519)
// across Cloudflare Edge Workers (`workerd`) and Node.js 24+.
import { constantTimeEqual, fromBase64Url, hmacSha256Hex, randomBase64Url, toBase64Url } from "./crypto.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60_000;
export const MACHINE_CLAIM_TICKET_TTL_MS = 10 * 60_000;

export type PasskeyAlgorithm = "ES256" | "EdDSA";

export interface PasskeyChallengeClaims {
  readonly purpose: "register" | "login";
  readonly challenge: string;
  readonly rpId: string;
  readonly actorId?: string;
  readonly exp: number;
}

export interface VerifiedPasskeyRegistration {
  readonly credentialId: string;
  readonly algorithm: PasskeyAlgorithm;
  readonly publicKey: string;
  readonly signCount: number;
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
}

export interface VerifiedPasskeyAssertion {
  readonly credentialId: string;
  readonly newSignCount: number;
}

export interface MachineClaimTicket {
  readonly v: 1;
  readonly relayOrigin: string;
  readonly machineId: string;
  readonly displayName: string;
  readonly ownerPublicKey: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly signature: string;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(data)));
}

function concatUint8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/**
 * Resolves the WebAuthn Relying Party ID (`rpId`) for a request origin.
 * Production uses `"opencraft.app"` so Passkeys work seamlessly across `my.opencraft.app`
 * and `opencraft.app`; local dev and `workerd` tests use their exact hostname.
 */
export function resolveWebAuthnRpId(originHeader: string | null, relayOrigin: string): string {
  const raw = originHeader?.trim() || relayOrigin;
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    if (hostname === "opencraft.app" || hostname.endsWith(".opencraft.app")) {
      return "opencraft.app";
    }
    return hostname;
  } catch {
    return "opencraft.app";
  }
}

function isAllowedWebAuthnOrigin(clientOriginRaw: string, rpId: string): boolean {
  try {
    const url = new URL(clientOriginRaw);
    const host = url.hostname.toLowerCase();
    const hostMatches = host === rpId || host.endsWith(`.${rpId}`);
    if (!hostMatches) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host.endsWith(".test"));
  } catch {
    return false;
  }
}

export async function issuePasskeyChallengeTicket(
  secret: string,
  input: {
    readonly purpose: "register" | "login";
    readonly rpId: string;
    readonly actorId?: string;
    readonly now?: number;
  },
): Promise<{
  readonly challenge: string;
  readonly challengeTicket: string;
  readonly rpId: string;
  readonly expiresAt: number;
}> {
  const now = input.now ?? Date.now();
  const challenge = randomBase64Url(32);
  const claims: PasskeyChallengeClaims = {
    purpose: input.purpose,
    challenge,
    rpId: input.rpId,
    ...(input.actorId ? { actorId: input.actorId } : {}),
    exp: now + PASSKEY_CHALLENGE_TTL_MS,
  };
  const payloadB64 = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const sig = await hmacSha256Hex(secret, "webauthn-challenge.v1", payloadB64);
  return {
    challenge,
    challengeTicket: `pkc1.${payloadB64}.${sig}`,
    rpId: input.rpId,
    expiresAt: claims.exp,
  };
}

export async function verifyPasskeyChallengeTicket(
  secret: string,
  ticketRaw: string,
  expectedPurpose: "register" | "login",
  now = Date.now(),
): Promise<PasskeyChallengeClaims | null> {
  if (typeof ticketRaw !== "string" || !ticketRaw.startsWith("pkc1.")) return null;
  const parts = ticketRaw.split(".");
  if (parts.length !== 3) return null;
  const [, payloadB64, sig] = parts as [string, string, string];
  const expectedSig = await hmacSha256Hex(secret, "webauthn-challenge.v1", payloadB64);
  if (!constantTimeEqual(sig, expectedSig)) return null;
  try {
    const parsed = JSON.parse(decoder.decode(fromBase64Url(payloadB64))) as PasskeyChallengeClaims;
    if (
      parsed.purpose !== expectedPurpose ||
      typeof parsed.challenge !== "string" ||
      typeof parsed.rpId !== "string" ||
      typeof parsed.exp !== "number" ||
      parsed.exp <= now
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// ---- Minimal Deterministic CBOR Reader (RFC 8949 subset for WebAuthn/COSE) ----

function decodeCborItem(bytes: Uint8Array, offset: number): { readonly value: unknown; readonly nextOffset: number } {
  if (offset >= bytes.byteLength) throw new Error("Unexpected end of CBOR input");
  const initial = bytes[offset]!;
  const major = initial >> 5;
  const ai = initial & 0x1f;
  let pos = offset + 1;

  const readLength = (): number => {
    if (ai < 24) return ai;
    if (ai === 24) {
      if (pos + 1 > bytes.byteLength) throw new Error("Truncated CBOR uint8");
      return bytes[pos++]!;
    }
    if (ai === 25) {
      if (pos + 2 > bytes.byteLength) throw new Error("Truncated CBOR uint16");
      const v = (bytes[pos]! << 8) | bytes[pos + 1]!;
      pos += 2;
      return v;
    }
    if (ai === 26) {
      if (pos + 4 > bytes.byteLength) throw new Error("Truncated CBOR uint32");
      const v = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getUint32(0, false);
      pos += 4;
      return v;
    }
    if (ai === 27) {
      if (pos + 8 > bytes.byteLength) throw new Error("Truncated CBOR uint64");
      const hi = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getUint32(0, false);
      const lo = new DataView(bytes.buffer, bytes.byteOffset + pos + 4, 4).getUint32(0, false);
      pos += 8;
      return hi * 4294967296 + lo;
    }
    throw new Error(`Unsupported CBOR additional info: ${ai}`);
  };

  if (major === 0) {
    return { value: readLength(), nextOffset: pos };
  }
  if (major === 1) {
    return { value: -1 - readLength(), nextOffset: pos };
  }
  if (major === 2) {
    const len = readLength();
    if (pos + len > bytes.byteLength) throw new Error("Truncated CBOR byte string");
    return { value: bytes.slice(pos, pos + len), nextOffset: pos + len };
  }
  if (major === 3) {
    const len = readLength();
    if (pos + len > bytes.byteLength) throw new Error("Truncated CBOR text string");
    return { value: decoder.decode(bytes.subarray(pos, pos + len)), nextOffset: pos + len };
  }
  if (major === 4) {
    const count = readLength();
    const arr: unknown[] = [];
    for (let i = 0; i < count; i += 1) {
      const item = decodeCborItem(bytes, pos);
      arr.push(item.value);
      pos = item.nextOffset;
    }
    return { value: arr, nextOffset: pos };
  }
  if (major === 5) {
    const count = readLength();
    const map = new Map<unknown, unknown>();
    for (let i = 0; i < count; i += 1) {
      const k = decodeCborItem(bytes, pos);
      const v = decodeCborItem(bytes, k.nextOffset);
      map.set(k.value, v.value);
      pos = v.nextOffset;
    }
    return { value: map, nextOffset: pos };
  }
  if (major === 7) {
    if (ai === 20) return { value: false, nextOffset: pos };
    if (ai === 21) return { value: true, nextOffset: pos };
    if (ai === 22 || ai === 23) return { value: null, nextOffset: pos };
  }
  throw new Error(`Unsupported CBOR major type: ${major}`);
}

function parseCosePublicKey(cborBytes: Uint8Array): {
  readonly algorithm: PasskeyAlgorithm;
  readonly publicKey: string;
} {
  const { value } = decodeCborItem(cborBytes, 0);
  if (!(value instanceof Map)) throw new Error("COSE key must be a CBOR map");
  const kty = value.get(1);
  const alg = value.get(3);
  const crv = value.get(-1);
  const x = value.get(-2);

  // ES256: EC2 (kty = 2), alg = -7, P-256 (crv = 1)
  if (kty === 2 && alg === -7 && crv === 1) {
    const y = value.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.byteLength !== 32 || y.byteLength !== 32) {
      throw new Error("Invalid P-256 COSE coordinates");
    }
    const uncompressed = new Uint8Array(65);
    uncompressed[0] = 0x04;
    uncompressed.set(x, 1);
    uncompressed.set(y, 33);
    return { algorithm: "ES256", publicKey: toBase64Url(uncompressed) };
  }

  // EdDSA: OKP (kty = 1), alg = -8, Ed25519 (crv = 6)
  if (kty === 1 && alg === -8 && crv === 6) {
    if (!(x instanceof Uint8Array) || x.byteLength !== 32) {
      throw new Error("Invalid Ed25519 COSE key");
    }
    return { algorithm: "EdDSA", publicKey: toBase64Url(x) };
  }

  throw new Error(`Unsupported COSE key algorithm (${String(alg)})`);
}

function derEcdsaToP1363(der: Uint8Array): Uint8Array | null {
  // Some test mocks or non-DER shims already emit 64-byte raw P1363 if first byte != 0x30
  if (der.byteLength === 64 && der[0] !== 0x30) return der;
  if (der.byteLength < 8 || der[0] !== 0x30) return null;
  let pos = 1;
  let seqLen = der[pos++]!;
  if (seqLen & 0x80) {
    const lenBytes = seqLen & 0x7f;
    if (lenBytes !== 1 || pos >= der.byteLength) return null;
    seqLen = der[pos++]!;
  }
  if (pos + seqLen > der.byteLength) return null;

  const readInt32 = (): Uint8Array | null => {
    if (pos + 2 > der.byteLength || der[pos++] !== 0x02) return null;
    const len = der[pos++]!;
    if (pos + len > der.byteLength || len < 1 || len > 33) return null;
    let slice = der.subarray(pos, pos + len);
    pos += len;
    while (slice.byteLength > 32 && slice[0] === 0x00) {
      slice = slice.subarray(1);
    }
    if (slice.byteLength > 32) return null;
    const padded = new Uint8Array(32);
    padded.set(slice, 32 - slice.byteLength);
    return padded;
  };

  const r = readInt32();
  const s = readInt32();
  if (!r || !s) return null;
  return concatUint8(r, s);
}

export async function verifyPasskeyRegistration(input: {
  readonly credentialIdB64: string;
  readonly clientDataJsonB64: string;
  readonly attestationObjectB64: string;
  readonly expectedChallenge: string;
  readonly expectedRpId: string;
}): Promise<VerifiedPasskeyRegistration | null> {
  try {
    const clientDataBytes = fromBase64Url(input.clientDataJsonB64);
    const clientData = JSON.parse(decoder.decode(clientDataBytes)) as {
      type?: unknown;
      challenge?: unknown;
      origin?: unknown;
    };
    if (
      clientData.type !== "webauthn.create" ||
      typeof clientData.challenge !== "string" ||
      !constantTimeEqual(clientData.challenge, input.expectedChallenge) ||
      typeof clientData.origin !== "string" ||
      !isAllowedWebAuthnOrigin(clientData.origin, input.expectedRpId)
    ) {
      return null;
    }

    const attBytes = fromBase64Url(input.attestationObjectB64);
    const { value: attMap } = decodeCborItem(attBytes, 0);
    if (!(attMap instanceof Map)) return null;
    const authData = attMap.get("authData");
    if (!(authData instanceof Uint8Array) || authData.byteLength < 55) return null;

    const expectedRpIdHash = await sha256Bytes(encoder.encode(input.expectedRpId));
    if (!constantTimeEqual(toBase64Url(authData.subarray(0, 32)), toBase64Url(expectedRpIdHash))) {
      return null;
    }

    const flags = authData[32]!;
    const userPresent = (flags & 0x01) !== 0;
    const attestedDataPresent = (flags & 0x40) !== 0;
    if (!userPresent || !attestedDataPresent) return null;

    const backupEligible = (flags & 0x08) !== 0;
    const backedUp = (flags & 0x10) !== 0;
    const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0, false);
    const credIdLen = (authData[53]! << 8) | authData[54]!;
    if (55 + credIdLen >= authData.byteLength || credIdLen < 8 || credIdLen > 512) return null;

    const credentialId = toBase64Url(authData.subarray(55, 55 + credIdLen));
    if (input.credentialIdB64 && !constantTimeEqual(credentialId, input.credentialIdB64)) {
      return null;
    }

    const coseKeyBytes = authData.subarray(55 + credIdLen);
    const parsedKey = parseCosePublicKey(coseKeyBytes);

    return {
      credentialId,
      algorithm: parsedKey.algorithm,
      publicKey: parsedKey.publicKey,
      signCount,
      backupEligible,
      backedUp,
    };
  } catch {
    return null;
  }
}

export async function verifyPasskeyAssertion(input: {
  readonly credentialIdB64: string;
  readonly authenticatorDataB64: string;
  readonly clientDataJsonB64: string;
  readonly signatureB64: string;
  readonly expectedChallenge: string;
  readonly expectedRpId: string;
  readonly storedAlgorithm: PasskeyAlgorithm;
  readonly storedPublicKeyB64: string;
  readonly storedSignCount: number;
}): Promise<VerifiedPasskeyAssertion | null> {
  try {
    const clientDataBytes = fromBase64Url(input.clientDataJsonB64);
    const clientData = JSON.parse(decoder.decode(clientDataBytes)) as {
      type?: unknown;
      challenge?: unknown;
      origin?: unknown;
    };
    if (
      clientData.type !== "webauthn.get" ||
      typeof clientData.challenge !== "string" ||
      !constantTimeEqual(clientData.challenge, input.expectedChallenge) ||
      typeof clientData.origin !== "string" ||
      !isAllowedWebAuthnOrigin(clientData.origin, input.expectedRpId)
    ) {
      return null;
    }

    const authData = fromBase64Url(input.authenticatorDataB64);
    if (authData.byteLength < 37) return null;

    const expectedRpIdHash = await sha256Bytes(encoder.encode(input.expectedRpId));
    if (!constantTimeEqual(toBase64Url(authData.subarray(0, 32)), toBase64Url(expectedRpIdHash))) {
      return null;
    }

    const flags = authData[32]!;
    const userPresent = (flags & 0x01) !== 0;
    if (!userPresent) return null;

    const incomingSignCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0, false);
    // WebAuthn Level 3 sync-safe signCount rule:
    // Synced passkeys (iCloud Keychain / Google Password Manager / 1Password) routinely report 0.
    // Only reject monotonic rollback when BOTH stored and incoming counters are strictly positive.
    if (input.storedSignCount > 0 && incomingSignCount > 0 && incomingSignCount <= input.storedSignCount) {
      return null;
    }

    const clientDataHash = await sha256Bytes(clientDataBytes);
    const signedPayload = concatUint8(authData, clientDataHash);
    const rawSig = fromBase64Url(input.signatureB64);
    const pubBytes = fromBase64Url(input.storedPublicKeyB64);

    let verified = false;
    if (input.storedAlgorithm === "ES256") {
      const p1363 = derEcdsaToP1363(rawSig);
      if (!p1363) return null;
      const key = await crypto.subtle.importKey(
        "raw",
        toArrayBuffer(pubBytes),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      verified = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        toArrayBuffer(p1363),
        toArrayBuffer(signedPayload),
      );
    } else if (input.storedAlgorithm === "EdDSA") {
      const key = await crypto.subtle.importKey("raw", toArrayBuffer(pubBytes), { name: "Ed25519" }, false, ["verify"]);
      verified = await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        toArrayBuffer(rawSig),
        toArrayBuffer(signedPayload),
      );
    }
    if (!verified) return null;

    return {
      credentialId: input.credentialIdB64,
      newSignCount: Math.max(input.storedSignCount, incomingSignCount),
    };
  } catch {
    return null;
  }
}

export async function verifyMachineClaimTicket(
  rawTicketB64: string,
  expectedRelayOrigin: string,
  now = Date.now(),
): Promise<MachineClaimTicket | null> {
  if (typeof rawTicketB64 !== "string" || rawTicketB64.length < 32 || rawTicketB64.length > 4096) return null;
  try {
    const parsed = JSON.parse(decoder.decode(fromBase64Url(rawTicketB64))) as MachineClaimTicket;
    if (
      parsed?.v !== 1 ||
      parsed.relayOrigin !== expectedRelayOrigin ||
      typeof parsed.machineId !== "string" ||
      typeof parsed.displayName !== "string" ||
      typeof parsed.ownerPublicKey !== "string" ||
      typeof parsed.timestamp !== "number" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.signature !== "string" ||
      Math.abs(now - parsed.timestamp) > MACHINE_CLAIM_TICKET_TTL_MS
    ) {
      return null;
    }
    const pubRaw = fromBase64Url(parsed.ownerPublicKey);
    const sigRaw = fromBase64Url(parsed.signature);
    if (pubRaw.byteLength !== 32 || sigRaw.byteLength !== 64) return null;
    const signingInput = encoder.encode(
      `opencraft-machine-claim.v1\n${parsed.relayOrigin}\n${parsed.machineId}\n${parsed.timestamp}\n${parsed.nonce}`,
    );
    const key = await crypto.subtle.importKey("raw", toArrayBuffer(pubRaw), { name: "Ed25519" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("Ed25519", key, toArrayBuffer(sigRaw), toArrayBuffer(signingInput));
    return ok ? parsed : null;
  } catch {
    return null;
  }
}
