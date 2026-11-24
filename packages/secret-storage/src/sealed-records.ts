// Synchronously sealed records: AES-256-GCM through node:crypto (Node, and
// workerd under nodejs_compat), for an owner that must read or write a sealed
// value inside a synchronous SQL transaction, such as the account pool reading
// the chosen account's credential while it reserves the affinity
// (storage-ports §7.1). The asynchronous `sealedSecretStore` (WebCrypto) seals
// named secrets; this seals records an owner keeps in its own SQL rows.
//
// The configured key text is the sealing key's (`<id>.<base64url 32 bytes>`);
// records use a subkey derived from it for this purpose only, so a record
// ciphertext can never be opened as a named secret or the other way round.
// Every record is bound to its context (for example `account:<id>`): a
// ciphertext moved to another row does not open.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { SecretStoreCorruptError } from "./contract.js";
import { SecretSealingKeyError, parseSecretSealingKey, sealedText } from "./sealed.js";

/** Seals and opens record text under one key, synchronously. */
export interface RecordSealer {
  /** The id written beside every value it seals. */
  readonly keyId: string;
  seal(context: string, plaintext: string): string;
  /** Throws SecretStoreCorruptError for a value that is not a record sealed by this key for `context`. */
  unseal(context: string, stored: string): string;
}

const FORMAT = "ocr1";
const PURPOSE = "opencraft-sealed-records:v1";
const associated = (context: string) => Buffer.from(`opencraft-record:${FORMAT}:${context}`, "utf8");

/** A sealer for the configured key; throws SecretSealingKeyError when the key is missing or malformed. */
export function recordSealer(configured: string | undefined): RecordSealer {
  const { id, raw } = parseSecretSealingKey(configured);
  const key = createHmac("sha256", Buffer.from(raw)).update(PURPOSE).digest();
  raw.fill(0);
  return {
    keyId: id,
    seal(context, plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(associated(context));
      const sealed = Buffer.concat([
        cipher.update(Buffer.from(plaintext, "utf8")),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return `${FORMAT}.${id}.${sealedText.encode(iv)}.${sealedText.encode(sealed)}`;
    },
    unseal(context, stored) {
      const [format, keyId, iv, sealed, ...rest] = typeof stored === "string" ? stored.split(".") : [];
      // A plaintext or foreign value is never returned as if it were sealed.
      if (format !== FORMAT || !keyId || iv === undefined || sealed === undefined || rest.length)
        throw new SecretStoreCorruptError();
      if (keyId !== id) throw new SecretSealingKeyError("Record was sealed with another key");
      try {
        const bytes = Buffer.from(sealedText.decode(sealed));
        if (bytes.byteLength < 16) throw new SecretStoreCorruptError();
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealedText.decode(iv)));
        decipher.setAAD(associated(context));
        decipher.setAuthTag(bytes.subarray(bytes.byteLength - 16));
        const opened = Buffer.concat([decipher.update(bytes.subarray(0, bytes.byteLength - 16)), decipher.final()]);
        return new TextDecoder("utf-8", { fatal: true }).decode(opened);
      } catch {
        throw new SecretStoreCorruptError();
      }
    },
  };
}
