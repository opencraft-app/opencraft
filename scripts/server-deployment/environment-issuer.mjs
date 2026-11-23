import { generateKeyPair } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

// Pinning the vault owner's ENV issuer into independent execution owners.
// The only source is the private file the vault owner publishes in the shared
// data directory (same user, mode 0600, never a symlink). A Gateway relay, a
// Host descriptor, a request or an environment variable never supplies a key.

const ISSUER = /^[A-Za-z0-9_-]{1,256}$/u;

/** The published issuer public key, or `null` when none is published yet.
 * Anything else at that path is refused. */
export async function readPublishedEnvironmentIssuer(path) {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("The ENV issuer publication requires an absolute path");
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.size > 1024)
    throw new Error("The ENV issuer publication must be an owned private file");
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Invalid ENV issuer publication");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== "issuer,schemaVersion" ||
    value.schemaVersion !== 1 ||
    typeof value.issuer !== "string" ||
    !ISSUER.test(value.issuer)
  )
    throw new Error("Invalid ENV issuer publication");
  return value.issuer;
}

/** A valid issuer key that nothing can issue for: its private half is never
 * kept. Pinned while no key is published (or the publication is refused), so
 * every Human delivery fails closed while unowned launches stay as they are. */
export async function unissuableEnvironmentIssuer() {
  const { publicKey } = await promisify(generateKeyPair)("x25519");
  return publicKey.export({ type: "spki", format: "der" }).toString("base64url");
}

/** The key to pin at launch: the published one, else an unissuable key. */
export async function resolveEnvironmentIssuer(path) {
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
 * names the publication (`environmentIssuerFile`) instead of a key, as under
 * systemd where the unit restarts when the publication changes. */
export async function pinPublishedEnvironmentIssuer(configuration, log = (message) => console.error(message)) {
  if (!configuration || typeof configuration !== "object" || configuration.environmentIssuerFile === undefined)
    return configuration;
  const { environmentIssuerFile, ...rest } = configuration;
  if (rest.environmentIssuer !== undefined) throw new Error("Configure either an ENV issuer or its publication");
  const pinned = await resolveEnvironmentIssuer(environmentIssuerFile);
  if (!pinned.published) log(JSON.stringify({ type: "environment-issuer-unavailable", reason: pinned.reason }));
  return { ...rest, environmentIssuer: pinned.issuer };
}

/** Supervisor loop: whenever a valid published key differs from the pinned
 * one, `replace(issuer)` must reconfigure and relaunch the execution owners.
 * An unreadable or refused publication keeps the current pin (fail closed). */
export async function watchEnvironmentIssuer({
  path,
  pinned,
  signal,
  replace,
  interval = 2000,
  read = readPublishedEnvironmentIssuer,
  log = (message) => console.error(message),
}) {
  let current = pinned,
    refused = false;
  while (!signal.aborted) {
    try {
      await delay(interval, undefined, { signal });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    let published;
    try {
      published = await read(path);
      refused = false;
    } catch {
      if (!refused) log(JSON.stringify({ type: "environment-issuer-unavailable", reason: "refused" }));
      refused = true;
      continue;
    }
    if (published === null || published === current || signal.aborted) continue;
    await replace(published);
    current = published;
  }
}
