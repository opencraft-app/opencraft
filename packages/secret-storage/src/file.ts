import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateKeyName, type KeyMaterial } from "./contract.js";

/**
 * One private file per key in `directory`, created exactly once (link-based,
 * so concurrent creators converge on the first complete file).
 */
export function fileKeyMaterial(directory: string): KeyMaterial {
  const read = async (name: string) => {
    validateKeyName(name);
    try {
      return new Uint8Array(await readFile(join(directory, name)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
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
      const parent = await open(directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
      const stored = await read(name);
      if (!stored) throw new Error("Key material was not stored");
      return stored;
    },
  };
}
