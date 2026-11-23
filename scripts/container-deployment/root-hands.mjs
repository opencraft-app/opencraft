import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { startContainerHands } from "./hands-application.mjs";
import { assertPrivateOwnedDirectory } from "./hands-owner-privileges.mjs";

/**
 * Root Hands: one identity and directory composition of the Hands workspace agent.
 * The agent and its execution, terminal and files owners run as UID 0, while the
 * browser owner and every client (Gateway, Brain, Proxy) keep the deployment's
 * nonroot numeric identity. Every owner is still a critical agent child, and the
 * Gateway reaches all of them only through the agent's named endpoints, over the
 * static-docker link the root agent serves to the client identity.
 *
 * The two identities never share a private directory. Root state lives in the
 * server directory and the client identity owns the client directory; both are
 * children of one common mount. Only Brain still reaches Hands outside the agent,
 * through the shared execution directory (`exec-owner.sock` for Codex execution,
 * `files.sock` for Pi and DSH, until Brain and Hands merge). For it, those two root
 * owner sockets are published from the server directory into the client directory
 * by atomic hardlink (separate bind mounts would fail with EXDEV), and their
 * credentials have one root-owned and one client-owned 0600 copy with the same
 * value. Terminal and browser have no such second route: they are endpoints only.
 *
 * Startup never recursively re-owns, moves or copies existing data. Directories it
 * creates are new, empty and owned by their declared identity; anything that does
 * not match is a startup error, never a repair.
 *
 * Configuration (see deploy/docker/deploy/compose.root-hands.yaml):
 *   OPENCRAFT_ROOT_HANDS_SERVER_DIRECTORY  root-owned owner state (= OPENCRAFT_EXECUTION_DIR)
 *   OPENCRAFT_ROOT_HANDS_CLIENT_DIRECTORY  client-owned directory in the same mount
 *   OPENCRAFT_HANDS_CLIENT_DIRECTORY       the same client directory at the path clients use
 *   OPENCRAFT_HANDS_CLIENT_UID / _GID      nonroot client and browser identity
 *   OPENCRAFT_HANDS_BROWSER_NAME           `browser` (default) or `.` for a profile kept in the client root
 *   OPENCRAFT_HANDS_BROWSER_DIRECTORY      optional existing retained profile outside the server directory
 *   OPENCRAFT_AGENT_RUN_DIR                the root agent's own private run directory (root-owned tmpfs)
 */

const MAX_ID = 2 ** 31 - 1;
/** Owner credentials shared by value between the root and client directories (Brain's direct route). */
export const ROOT_HANDS_CREDENTIALS = Object.freeze(["exec-owner.token", "files.token"]);
/** Root owner sockets Brain dials in its execution directory; published into the client directory. */
export const ROOT_HANDS_ENDPOINTS = Object.freeze(["exec-owner.sock", "files.sock"]);
const CREDENTIAL = /^[a-f0-9]{64}$/u;
const SYNCHRONIZE_INTERVAL_MS = 100;
const ROOT = Object.freeze({ uid: 0, gid: 0 });

const contains = (parent, path) => path === parent || path.startsWith(parent + "/");
const suffix = () => `${process.pid}-${randomBytes(6).toString("hex")}`;
const ignoreMissing = async (operation) => {
  try {
    await operation();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};
const lstatOrNull = (path) => lstat(path).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));

/** Parses and validates the root Hands environment without touching the filesystem. */
export function rootHandsConfiguration(env = process.env) {
  const path = (key) => {
    const value = env[key];
    if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === "/")
      throw new Error(`Root Hands ${key} must be a normalized absolute path other than /`);
    return value;
  };
  const id = (key) => {
    const value = env[key];
    if (!/^[1-9][0-9]*$/u.test(value ?? "") || Number(value) > MAX_ID)
      throw new Error(`Root Hands ${key} must be a nonroot numeric identity`);
    return Number(value);
  };
  const server = path("OPENCRAFT_ROOT_HANDS_SERVER_DIRECTORY");
  const client = path("OPENCRAFT_ROOT_HANDS_CLIENT_DIRECTORY");
  const publicClient = path("OPENCRAFT_HANDS_CLIENT_DIRECTORY");
  if (contains(server, client) || contains(client, server))
    throw new Error("Root Hands server and client directories must be separate");
  if (env.OPENCRAFT_EXECUTION_DIR !== server)
    throw new Error("Root Hands OPENCRAFT_EXECUTION_DIR must be the server directory");
  // Root owners keep their state at exactly these server paths; anything else would
  // leave Brain's published copy or the health check on an endpoint nobody serves.
  const expected = {
    OPENCRAFT_HANDS_EXECUTION_SOCKET: join(server, "exec-owner.sock"),
    OPENCRAFT_HANDS_EXECUTION_TOKEN: join(server, "exec-owner.token"),
    OPENCRAFT_BROWSER_DATA_DIR: join(server, "browser"),
  };
  for (const [key, value] of Object.entries(expected))
    if (env[key] !== undefined && env[key] !== value) throw new Error(`Root Hands ${key} must be ${value}`);
  const browserName = env.OPENCRAFT_HANDS_BROWSER_NAME || "browser";
  if (browserName !== "browser" && browserName !== ".")
    throw new Error("Root Hands OPENCRAFT_HANDS_BROWSER_NAME must be browser or .");
  const browserDirectory = env.OPENCRAFT_HANDS_BROWSER_DIRECTORY
    ? path("OPENCRAFT_HANDS_BROWSER_DIRECTORY")
    : undefined;
  if (browserDirectory && contains(server, browserDirectory))
    throw new Error("A retained browser profile must stay outside the root server directory");
  return {
    server,
    client,
    publicClient,
    browserName,
    ...(browserDirectory ? { browserDirectory } : {}),
    uid: id("OPENCRAFT_HANDS_CLIENT_UID"),
    gid: id("OPENCRAFT_HANDS_CLIENT_GID"),
  };
}

/** The client-owned browser profile, as seen through `root` (client or public path). */
export function rootHandsBrowserDirectory(configuration, root) {
  if (configuration.browserDirectory) return configuration.browserDirectory;
  return configuration.browserName === "." ? root : join(root, "browser");
}

/**
 * A private directory owned by `owner`, reached only through directories owned by
 * root or the client identity that nobody else can modify (root-owned sticky
 * directories such as /tmp excepted). The same rule the agent applies to a dropped
 * owner's state directory (hands-owner-privileges.mjs).
 */
const assertPrivateDirectory = (path, owner, { uid }) =>
  assertPrivateOwnedDirectory(path, { ...owner, ancestorUid: uid }, "Root Hands private directory");

/** Opens `path` without following a final link, as a directory. */
const openDirectory = (path) => open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);

/**
 * Creates one new empty private directory for `owner`, or accepts an existing one
 * that already satisfies the private-directory rule. Ownership is applied through a
 * no-follow descriptor, so a swapped-in link is never re-owned.
 */
async function ensurePrivateDirectory(path, owner, configuration) {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (created) {
    const directory = await openDirectory(path);
    try {
      await directory.chown(owner.uid, owner.gid);
    } finally {
      await directory.close();
    }
  }
  await assertPrivateDirectory(path, owner, configuration);
}

async function readCredential(path, owner) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Root Hands credential ${path} is not a readable regular file (${error.code})`);
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== owner.uid || info.gid !== owner.gid || info.mode & 0o077 || info.size > 4096)
      throw new Error(`Root Hands credential ${path} must be a 0600 file owned by ${owner.uid}:${owner.gid}`);
    const value = (await file.readFile("utf8")).trim();
    if (!CREDENTIAL.test(value)) throw new Error(`Root Hands credential ${path} has an invalid format`);
    return value;
  } finally {
    await file.close();
  }
}

async function writeCredential(path, value, owner) {
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
  const file = await open(path, flags, 0o600);
  try {
    await file.chown(owner.uid, owner.gid);
    await file.writeFile(value + "\n");
  } finally {
    await file.close();
  }
}

/** Fails before any owner starts if `from` cannot be hardlinked into `to`. */
async function assertHardlinks(from, to) {
  const source = join(from, `.root-hands-probe-${suffix()}`),
    target = join(to, `.root-hands-probe-${suffix()}`);
  try {
    const probe = await open(source, "wx", 0o600);
    await probe.close();
    await link(source, target);
  } catch (error) {
    throw new Error(`Root Hands cannot hardlink ${from} into ${to} (${error.code}); use one common mount`);
  } finally {
    for (const path of [target, source]) await ignoreMissing(() => unlink(path));
  }
}

/**
 * Validates the declared layout and prepares only what is missing: credential
 * copies and the empty default browser profile. Safe to repeat on restart: existing
 * credentials are kept, and disagreeing copies fail instead of rotating.
 */
export async function prepareRootHands(configuration, { currentUid = process.getuid?.() } = {}) {
  if (currentUid !== 0) throw new Error("Root Hands requires the Hands supervisor to run as UID 0");
  const c = configuration,
    client = { uid: c.uid, gid: c.gid };
  await assertPrivateDirectory(c.server, ROOT, c);
  await assertPrivateDirectory(c.client, client, c);
  await assertPrivateDirectory(c.publicClient, client, c);
  if (c.browserDirectory) await assertPrivateDirectory(c.browserDirectory, client, c);
  const [bridged, visible] = await Promise.all([stat(c.client), stat(c.publicClient)]);
  if (bridged.dev !== visible.dev || bridged.ino !== visible.ino)
    throw new Error("Root Hands client directory and its client-visible path must be the same directory");
  await assertHardlinks(c.server, c.client);

  for (const name of ROOT_HANDS_CREDENTIALS) {
    const rootPath = join(c.server, name),
      clientPath = join(c.client, name);
    const rootValue = await readCredential(rootPath, ROOT),
      clientValue = await readCredential(clientPath, client);
    if (rootValue && clientValue && !timingSafeEqual(Buffer.from(rootValue), Buffer.from(clientValue)))
      throw new Error(`Root Hands credential copies of ${name} disagree; refusing to rotate them`);
    const value = rootValue ?? clientValue ?? randomBytes(32).toString("hex");
    if (!rootValue) await writeCredential(rootPath, value, ROOT);
    if (!clientValue) await writeCredential(clientPath, value, client);
  }

  const profile = rootHandsBrowserDirectory(c, c.client);
  // A declared or client-root profile is retained as is; only the default
  // `browser` child may be created, empty, for the client identity.
  if (profile === c.browserDirectory || profile === c.client) await assertPrivateDirectory(profile, client, c);
  else await ensurePrivateDirectory(profile, client, c);
}

/**
 * Creates missing default projectless session directories under the shared
 * workspace for the client identity, so root execution does not create them
 * root-owned for Brain. Existing directories and cwds outside the workspace are
 * retained as they are.
 */
export async function prepareRootWorkspace(configuration, env = process.env) {
  const workspace = env.OPENCRAFT_WORKSPACE_DIR;
  if (!workspace || !isAbsolute(workspace) || resolve(workspace) !== workspace)
    throw new Error("Root Hands requires an absolute OPENCRAFT_WORKSPACE_DIR");
  const client = { uid: configuration.uid, gid: configuration.gid };
  const targets = [
    env.OPENCRAFT_CODEX_PROJECTLESS_DIR || join(workspace, "sessions/codex"),
    env.OPENCRAFT_DSH_PROJECTLESS_DIR || join(workspace, "sessions/dsh"),
  ];
  for (const target of targets) {
    if (!target.startsWith(workspace + "/")) continue;
    let path = workspace;
    for (const part of target.slice(workspace.length + 1).split("/")) {
      if (!part || part === "." || part === "..") throw new Error(`Invalid projectless directory ${target}`);
      path = join(path, part);
      try {
        await mkdir(path, { mode: 0o700 });
        const directory = await openDirectory(path);
        try {
          await directory.chown(client.uid, client.gid);
        } finally {
          await directory.close();
        }
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Projectless directory component ${path} must be a directory, not a link`);
    }
  }
}

/** Publishes the root-owned socket at `source` at `target` by hardlink. */
async function publishSocket(source, target) {
  const socket = await lstatOrNull(source);
  if (!socket) return;
  if (!socket.isSocket() || socket.uid !== 0)
    throw new Error(`Root Hands endpoint ${source} must be a socket owned by UID 0`);
  const existing = await lstatOrNull(target);
  if (existing && !existing.isSocket()) throw new Error(`Refusing to replace non-socket root Hands endpoint ${target}`);
  // Socket access is gated by the credential and the private directories; the
  // shared inode itself must be connectable by both identities.
  if ((socket.mode & 0o777) !== 0o666) await chmod(source, 0o666);
  if (existing && existing.dev === socket.dev && existing.ino === socket.ino) return;
  const temporary = `${target}.publish-${suffix()}`;
  try {
    await link(source, temporary);
    const linked = await lstat(temporary);
    if (!linked.isSocket() || linked.uid !== 0 || linked.ino !== socket.ino)
      throw new Error(`Root Hands endpoint ${source} changed while it was published`);
    await rename(temporary, target);
  } finally {
    await ignoreMissing(() => unlink(temporary));
  }
}

/** One synchronization pass of Brain's direct route; the agent repeats it while Hands runs. */
export async function synchronizeRootHands(configuration) {
  for (const name of ROOT_HANDS_ENDPOINTS)
    await publishSocket(join(configuration.server, name), join(configuration.client, name));
}

/**
 * The workspace agent options for root mode. The browser owner is dropped to the
 * client identity and uses its client-owned profile as OPENCRAFT_BROWSER_DATA_DIR
 * (validated by the agent before any owner starts); the agent serves its link to the
 * same identity.
 */
export function rootHandsOwnerComposition(configuration) {
  const c = configuration;
  return {
    browserData: rootHandsBrowserDirectory(c, c.publicClient),
    ownerPrivileges: { browser: { uid: c.uid, gid: c.gid, home: c.browserDirectory ?? c.publicClient } },
    linkOwner: { uid: c.uid, gid: c.gid },
  };
}

/** Repeats `synchronizeRootHands` until closed; a failed pass stops the agent. */
function rootHandsBridge(configuration, fail) {
  let closed = false,
    timer;
  const pass = async () => {
    try {
      await synchronizeRootHands(configuration);
    } catch (error) {
      if (closed) return;
      closed = true;
      console.error(`Root Hands socket bridge failed; stopping instead of running degraded: ${error.message}`);
      fail();
      return;
    }
    if (!closed) timer = setTimeout(pass, SYNCHRONIZE_INTERVAL_MS);
  };
  void pass();
  return {
    close: async () => {
      closed = true;
      clearTimeout(timer);
    },
  };
}

/** Starts the Hands workspace agent in root mode. `start` is a test seam. */
export async function startRootHands({
  env = process.env,
  start = startContainerHands,
  currentUid = process.getuid?.(),
} = {}) {
  const configuration = rootHandsConfiguration(env);
  await prepareRootHands(configuration, { currentUid });
  await prepareRootWorkspace(configuration, env);
  const { browserData, ownerPrivileges, linkOwner } = rootHandsOwnerComposition(configuration);
  // The agent validates the dropped browser against, and waits for its socket in,
  // the directory OPENCRAFT_BROWSER_DATA_DIR names.
  env.OPENCRAFT_BROWSER_DATA_DIR = browserData;
  return start({
    env,
    ownerPrivileges,
    linkOwner,
    startServices: async (fail) => [rootHandsBridge(configuration, fail)],
  });
}
