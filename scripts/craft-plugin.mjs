#!/usr/bin/env node
import { open, readFile, rename, rm, lstat, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, join, basename } from "node:path";
import { pathToFileURL } from "node:url";

/** Publish an already-built module; never import it or run package scripts. */
export async function sealCraftPlugin(folder) {
  folder = resolve(folder);
  if (!(await lstat(folder)).isDirectory()) throw new Error("Craft folder must not be a symlink");
  for (const name of ["manifest.json", "plugin.mjs"]) {
    const metadata = await lstat(join(folder, name));
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > (name === "plugin.mjs" ? 512 * 1024 : 64 * 1024)
    )
      throw new Error("Craft files must be bounded regular files");
  }
  const manifest = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8"));
  if (!/^user\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(manifest.id ?? "") || basename(folder) !== manifest.id)
    throw new Error("Craft folder must match a user.* manifest ID");
  const code = await readFile(join(folder, "plugin.mjs"));
  if (code.length > 512 * 1024) throw new Error("Craft module is too large");
  const sha256 = createHash("sha256").update(code).digest("hex");
  const temporary = join(folder, ".manifest-" + randomUUID());
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ ...manifest, moduleSha256: sha256 }, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    if (!(await readFile(join(folder, "plugin.mjs"))).equals(code))
      throw new Error("Craft changed during publication; retry after editing completes");
    await rename(temporary, join(folder, "manifest.json"));
  } finally {
    await rm(temporary, { force: true });
  }
  return { id: manifest.id, sha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node craft-plugin.mjs /absolute/path/to/crafts/user.plugin");
    console.log(JSON.stringify(await sealCraftPlugin(process.argv[2])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
