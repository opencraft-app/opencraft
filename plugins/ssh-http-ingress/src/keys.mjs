// Personal SSH public keys: parsed and validated with Node crypto only, so the
// network thread, the Worker-free admin tool and its bundle need no ssh2. The
// ingress still verifies every signature with ssh2 against the stored key.
import { createHash, createPublicKey } from "node:crypto";

/** Algorithms a person may register. DSA, certificates and security-key types are refused. */
const PERSONAL_KEY_ALGORITHMS = Object.freeze([
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
]);
const MINIMUM_RSA_BITS = 2048;
const CURVES = { nistp256: ["P-256", 32], nistp384: ["P-384", 48], nistp521: ["P-521", 66] };

function sshPublicKeyFingerprint(blob) {
  return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "");
}

/** The SSH wire fields of a public key blob, or null if it does not split exactly. */
function fields(blob) {
  const values = [];
  let offset = 0;
  while (offset < blob.length) {
    if (offset + 4 > blob.length) return null;
    const length = blob.readUInt32BE(offset);
    if (offset + 4 + length > blob.length) return null;
    values.push(blob.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return values;
}

/** An unsigned SSH mpint as minimal big-endian bytes, or null if negative or empty. */
function unsigned(mpint) {
  if (!mpint.length || mpint[0] & 0x80) return null;
  let start = 0;
  while (start < mpint.length && mpint[start] === 0) start++;
  return start === mpint.length ? null : mpint.subarray(start);
}

/** The key as a JWK Node can import, which checks curve points and sizes. */
function jwk(algorithm, values) {
  const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
  if (algorithm === "ssh-ed25519")
    return values.length === 2 && values[1].length === 32 ? { kty: "OKP", crv: "Ed25519", x: b64(values[1]) } : null;
  if (algorithm === "ssh-rsa") {
    const [e, n] = values.length === 3 ? [unsigned(values[1]), unsigned(values[2])] : [];
    if (!e || !n) return null;
    const bits = (n.length - 1) * 8 + (32 - Math.clz32(n[0]));
    return bits >= MINIMUM_RSA_BITS && bits <= 16384 ? { kty: "RSA", n: b64(n), e: b64(e) } : null;
  }
  const curve = algorithm.slice("ecdsa-sha2-".length);
  const [crv, size] = CURVES[curve] ?? [];
  if (!crv || values.length !== 3 || values[1].toString("latin1") !== curve) return null;
  const point = values[2];
  if (point.length !== 1 + 2 * size || point[0] !== 0x04) return null;
  return { kty: "EC", crv, x: b64(point.subarray(1, 1 + size)), y: b64(point.subarray(1 + size)) };
}

/**
 * One OpenSSH `authorized_keys` line without options: `<algorithm> <base64> [comment]`.
 * Returns the normalized key (no comment) and its SHA-256 fingerprint, or null.
 */
function parsePersonalPublicKey(value) {
  if (typeof value !== "string" || value.length > 16384) return null;
  const line = value.trim();
  if (!line || /[\r\n\0]/u.test(line)) return null;
  const [algorithm, body, ...comment] = line.split(/[ \t]+/u);
  if (!PERSONAL_KEY_ALGORITHMS.includes(algorithm) || !body || !/^[A-Za-z0-9+/]+={0,2}$/u.test(body)) return null;
  const blob = Buffer.from(body, "base64");
  // Canonical base64 only: no stray bits, so one key has one stored form.
  if (blob.toString("base64") !== body.padEnd(Math.ceil(body.length / 4) * 4, "=")) return null;
  const values = fields(blob);
  if (!values || values[0]?.toString("latin1") !== algorithm) return null;
  const key = jwk(algorithm, values);
  if (!key) return null;
  try {
    createPublicKey({ key, format: "jwk" });
  } catch {
    return null;
  }
  const label = comment
    .join(" ")
    .replace(/[\x00-\x1f\x7f]/gu, "")
    .trim()
    .slice(0, 128);
  return Object.freeze({
    algorithm,
    publicKey: `${algorithm} ${blob.toString("base64")}`,
    fingerprint: sshPublicKeyFingerprint(blob),
    comment: label || null,
  });
}

export { PERSONAL_KEY_ALGORITHMS, parsePersonalPublicKey, sshPublicKeyFingerprint };
