import { safePath } from "./package-path.mjs";

export const PACKAGE_MANIFEST = "manifest.json";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 8 * 1024 ** 2;
const MAX_PACKAGE_BYTES = 32 * 1024 ** 2;
const MAX_ENTRIES = 512;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export async function packageDigest(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files)
    || !manifest.files.length || manifest.files.length > MAX_ENTRIES)
    throw Error("Invalid VFS package manifest");
  const paths = new Set();
  let total = 0;
  for (const file of manifest.files) {
    const path = safePath(file?.path);
    if (path === PACKAGE_MANIFEST || paths.has(path) || typeof file.sha256 !== "string"
      || !sha256Pattern.test(file.sha256) || !Number.isSafeInteger(file.size)
      || file.size < 0 || file.size > MAX_FILE_BYTES)
      throw Error("Invalid VFS package inventory");
    paths.add(path);
    total += file.size;
  }
  for (const path of paths) {
    const parts = path.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (paths.has(parts.join("/"))) throw Error("Conflicting VFS package paths");
    }
  }
  if (total > MAX_PACKAGE_BYTES) throw Error("VFS package exceeds its byte limit");
}

export function encodePackageManifest(files) {
  const manifest = { schemaVersion: 1, files };
  validateManifest(manifest);
  const bytes = new TextEncoder().encode(JSON.stringify(manifest) + "\n");
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw Error("VFS package manifest exceeds its byte limit");
  return bytes;
}

async function readVerified(readFile, path, limit, expected) {
  const bytes = await readFile(path, limit);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > limit)
    throw Error("Invalid VFS package bytes: " + path);
  // Copy through the typed array constructor; Buffer.slice() would alias the reader.
  const snapshot = new Uint8Array(bytes);
  if (await packageDigest(snapshot) !== expected) throw Error("VFS package SHA-256 mismatch: " + path);
  return snapshot;
}

/** Verify the selected manifest and expose only its verified files. The host
 * chooses the manifest digest and implements bounded reads from its own VFS. */
export async function openPackageVfs({ sha256, readFile }) {
  if (typeof sha256 !== "string" || !sha256Pattern.test(sha256))
    throw Error("Invalid VFS package SHA-256");
  const bytes = await readVerified(readFile, PACKAGE_MANIFEST, MAX_MANIFEST_BYTES, sha256);
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  validateManifest(manifest);
  const files = new Map();
  for (const { path, size, sha256 } of manifest.files) {
    const file = await readVerified(readFile, path, size, sha256);
    if (file.byteLength !== size) throw Error("VFS package file size mismatch: " + path);
    files.set(path, file);
  }
  return Object.freeze({
    listFiles: () => [...files.keys()],
    readFile(path) {
      const file = files.get(safePath(path));
      if (!file) throw Error("Missing VFS package file: " + path);
      return file.slice();
    },
  });
}
