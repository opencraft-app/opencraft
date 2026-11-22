import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateKeyName, type KeyMaterial } from "./contract.js";

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
      return new Uint8Array(await file.readFile());
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
