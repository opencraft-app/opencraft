import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, parse, relative, resolve, sep } from "node:path";

/** privateDirectory for a Host's network thread: creates each missing level
 * owner-only and rejects links before traversing, without blocking. */
export async function privateDirectoryAsync(path) {
  path = resolve(path);
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Bot directory cannot traverse a symlink or file");
  }
  return realpath(path);
}
