import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import { validateKeyName, type KeyMaterial, type SecretStore } from "./contract.js";
import { documentSecretStore } from "./documents.js";

/**
 * Upper bound for a secrets document read in private mode. Entries are single
 * line API keys and tokens of at most a few KiB each, so 1 MiB holds hundreds
 * of them; a larger file is refused rather than read into memory.
 */
const SECRET_DOCUMENT_MAX_BYTES = 1_048_576;

/**
 * Node composition of `documentSecretStore` over a private
 * `fileStateDocumentStore`: reads refuse symlinks (`ELOOP`) and throw
 * `StateDocumentNotPrivateError` unless the file is a regular file of at most
 * 1 MiB owned by this user with no group or other permission bits; writes are
 * atomic and 0600.
 */
export function fileSecretStore(directory: string, key = "credentials.json"): SecretStore {
  return documentSecretStore(fileStateDocumentStore(directory, { private: { maxBytes: SECRET_DOCUMENT_MAX_BYTES } }), key);
}

/** Directory handles cannot be fsynced on Windows; rename/link durability there is the file system's. */
async function syncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * One private file per key in `directory`, created exactly once (link-based,
 * so concurrent creators converge on the first complete file). Reads fail
 * closed unless the key is a regular, non-symlinked file owned by this user
 * with no group or other permission bits.
 */
export function fileKeyMaterial(directory: string): KeyMaterial {
  const read = async (name: string) => {
    validateKeyName(name);
    let file;
    try {
      file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
        throw new Error("Key material file must be private");
      }
      const raw = await file.readFile();
      try { return new Uint8Array(raw); } finally { raw.fill(0); }
    } finally {
      await file.close();
    }
  };
  return {
    read,
    async ensure(name, create) {
      const existing = await read(name);
      if (existing) return existing;
      const key = create();
      if (!(key instanceof Uint8Array) || !key.byteLength) throw new TypeError("Key material must be non-empty bytes");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = join(directory, name), temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, key, { flag: "wx", mode: 0o600 });
        const file = await open(temporary, "r");
        try { await file.sync(); } finally { await file.close(); }
        try {
          await link(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      await syncDirectory(directory);
      const stored = await read(name);
      if (!stored) throw new Error("Key material was not stored");
      return stored;
    },
  };
}
