import { generateKeyPair } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

// Pinning the vault owner's ENV issuer into independent execution owners.
// The only source is the private file the vault owner publishes in the shared
// data directory (same user, mode 0600, never a symlink). A Gateway relay, a
// Host descriptor, a request or an environment variable never supplies a key.
// Only `node:` imports: deployment scripts load this file without a bundler.

const ISSUER = /^[A-Za-z0-9_-]{1,256}$/u;

/** The published issuer public key, or `null` when none is published yet.
 * Anything else at that path is refused. */
export async function readPublishedEnvironmentIssuer(path: string): Promise<string | null> {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("The ENV issuer publication requires an absolute path");
  // Check and read the same open file: a path checked by lstat and then read
  // again by name could be swapped in between, trusting an unchecked file.
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new Error("The ENV issuer publication must be an owned private file");
    throw error;
  }
  let text: string;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 1024)
      throw new Error("The ENV issuer publication must be an owned private file");
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid ENV issuer publication");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== "issuer,schemaVersion" ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (value as { issuer?: unknown }).issuer !== "string" ||
    !ISSUER.test((value as { issuer: string }).issuer)
  )
    throw new Error("Invalid ENV issuer publication");
  return (value as { issuer: string }).issuer;
}

/** A valid issuer key that nothing can issue for: its private half is never
 * kept. Pinned while no key is published (or the publication is refused), so
 * every Human delivery fails closed while unowned launches stay as they are. */
export async function unissuableEnvironmentIssuer(): Promise<string> {
  const { publicKey } = await promisify(generateKeyPair)("x25519");
  return publicKey.export({ type: "spki", format: "der" }).toString("base64url");
}

export type ResolvedEnvironmentIssuer =
  { issuer: string; published: true } | { issuer: string; published: false; reason: "missing" | "refused" };

/** The key to pin at launch: the published one, else an unissuable key. */
export async function resolveEnvironmentIssuer(path: string): Promise<ResolvedEnvironmentIssuer> {
  try {
    const issuer = await readPublishedEnvironmentIssuer(path);
    if (issuer !== null) return { issuer, published: true };
    return { issuer: await unissuableEnvironmentIssuer(), published: false, reason: "missing" };
  } catch (error) {
    if (typeof path !== "string" || !isAbsolute(path)) throw error;
    return { issuer: await unissuableEnvironmentIssuer(), published: false, reason: "refused" };
  }
}

/** Launch-time pinning for an execution owner whose trusted configuration
 * names the publication (`fileField`) instead of a key (`keyField`), as under
 * systemd where a path unit restarts the owner when the publication changes.
 * A configuration without `fileField` is returned unchanged. */
export async function pinEnvironmentIssuerFromPublication<T extends object>(
  configuration: T,
  fields: { file: string; key: string },
  log: (message: string) => void = (message) => console.error(message),
): Promise<T> {
  if (
    !configuration ||
    typeof configuration !== "object" ||
    (configuration as Record<string, unknown>)[fields.file] === undefined
  )
    return configuration;
  const { [fields.file]: file, ...rest } = configuration as Record<string, unknown>;
  if (rest[fields.key] !== undefined) throw new Error("Configure either an ENV issuer or its publication");
  if (typeof file !== "string") throw new Error("The ENV issuer publication requires an absolute path");
  const pinned = await resolveEnvironmentIssuer(file);
  if (!pinned.published) log(JSON.stringify({ type: "environment-issuer-unavailable", reason: pinned.reason }));
  return { ...rest, [fields.key]: pinned.issuer } as T;
}
