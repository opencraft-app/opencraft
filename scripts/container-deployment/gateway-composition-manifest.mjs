import { readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { encodePackageManifest, PACKAGE_MANIFEST, packageDigest } from "@opencraft/runtime-plugin-host/package-vfs";
import { boundedFile } from "@opencraft/runtime-plugin-host/store";

const [input, ...extra] = process.argv.slice(2);
if (!input || extra.length) throw Error("Usage: gateway-composition-manifest.mjs PACKAGE_DIRECTORY");
const root = await realpath(resolve(input));
if (root === "/") throw Error("Use a dedicated composition directory");
const files = [];
async function scan(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (path === PACKAGE_MANIFEST) continue;
    if (entry.isDirectory()) await scan(join(directory, entry.name), path + "/");
    else {
      if (!entry.isFile()) throw Error("Invalid composition file: " + path);
      const bytes = await boundedFile(join(directory, entry.name), 8 * 1024 ** 2);
      files.push({ path, sha256: await packageDigest(bytes), size: bytes.byteLength });
    }
  }
}
await scan(root);
if (!files.some((file) => file.path === "composition.mjs")) throw Error("Missing composition.mjs");
files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
process.stdout.write(encodePackageManifest(files));
