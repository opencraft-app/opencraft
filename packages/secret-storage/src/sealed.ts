// Sealed secrets: every value is encrypted (AES-256-GCM) under a deployment key
// held outside the store, before the inner store ever sees it. For owners whose
// storage is not a private file of the operator's machine (a Durable Object's
// storage), so a copy of that storage alone does not reveal a credential.
// Runtime-neutral: WebCrypto only.
import { SecretStoreCorruptError, validateSecretName, validateSecretValue, type SecretStore } from "./contract.js";

/** A sealing key and the id written beside every value it seals. */
export interface SecretSealingKey {
  readonly id: string;
  readonly key: CryptoKey;
}

/** The sealing key is missing, malformed, or not the key a stored value names. */
export class SecretSealingKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretSealingKeyError";
  }
}

const FORMAT = "ocs1";
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/u;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function bytesOf(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) throw new SecretStoreCorruptError();
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Parses a key configured as `<id>.<base64url of 32 random bytes>` into its id
 * and raw bytes. The caller imports the bytes and then zeroes them.
 */
export function parseSecretSealingKey(configured: string | undefined): {
  readonly id: string;
  readonly raw: Uint8Array<ArrayBuffer>;
} {
  const [id, encoded, ...rest] = (configured ?? "").split(".");
  if (!id || !KEY_ID.test(id) || encoded === undefined || rest.length)
    throw new SecretSealingKeyError("Secret sealing key must be <id>.<base64url 32 bytes>");
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = bytesOf(encoded);
  } catch {
    throw new SecretSealingKeyError("Secret sealing key must be <id>.<base64url 32 bytes>");
  }
  if (raw.byteLength !== 32) throw new SecretSealingKeyError("Secret sealing key must be 32 bytes");
  return { id, raw };
}

/** base64url text of `bytes` and back, as sealed values spell them. */
export const sealedText = {
  encode: base64url,
  decode: bytesOf,
};

/**
 * Imports a key configured as `<id>.<base64url of 32 random bytes>` (for
 * example a Secrets binding). The key is not extractable.
 */
export async function importSecretSealingKey(configured: string | undefined): Promise<SecretSealingKey> {
  const { id, raw } = parseSecretSealingKey(configured);
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  raw.fill(0);
  return { id, key };
}

/** Binds a sealed value to its name, so a stored value cannot be moved to another name. */
const associated = (name: string) => new TextEncoder().encode(`opencraft-secret:${FORMAT}:${name}`);

async function seal(sealing: SecretSealingKey, name: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associated(name) },
    sealing.key,
    new TextEncoder().encode(value),
  );
  return `${FORMAT}.${sealing.id}.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
}

async function unseal(sealing: SecretSealingKey, name: string, stored: string): Promise<string> {
  const [format, id, iv, sealed, ...rest] = stored.split(".");
  // A plaintext or foreign value is never returned as if it were sealed.
  if (format !== FORMAT || !id || iv === undefined || sealed === undefined || rest.length)
    throw new SecretStoreCorruptError();
  if (id !== sealing.id) throw new SecretSealingKeyError("Secret was sealed with another key");
  let opened: ArrayBuffer;
  try {
    opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytesOf(iv), additionalData: associated(name) },
      sealing.key,
      bytesOf(sealed),
    );
  } catch {
    throw new SecretStoreCorruptError();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(opened);
}

/**
 * Seals every value of `inner` under `sealing`. Names stay readable (they are
 * references, not secrets). Rewriting a name with its current value keeps the
 * stored ciphertext, so `stamp` still changes exactly when a value changes.
 * Key rotation (re-sealing under a new id) is not implemented: a value sealed
 * under another id is refused, never returned.
 */
export function sealedSecretStore(inner: SecretStore, sealing: SecretSealingKey): SecretStore {
  if (!KEY_ID.test(sealing.id)) throw new SecretSealingKeyError("Invalid secret sealing key id");
  return {
    async get(name) {
      validateSecretName(name);
      const stored = await inner.get(name);
      return stored === undefined ? undefined : unseal(sealing, name, stored);
    },
    async set(name, value) {
      validateSecretName(name);
      validateSecretValue(value);
      const stored = await inner.get(name);
      if (stored !== undefined && (await unseal(sealing, name, stored)) === value) return;
      await inner.set(name, await seal(sealing, name, value));
    },
    delete: (name) => inner.delete(name),
    stamp: () => inner.stamp(),
  };
}
