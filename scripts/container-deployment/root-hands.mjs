import fs from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { startContainerHands } from "./hands-application.mjs";

/**
 * Root Hands: the Hands supervisor and its execution, terminal and files owners
 * run as UID 0, while every client (Gateway, Brain, Proxy) and the browser owner
 * keep the deployment's nonroot numeric identity.
 *
 * The two identities never share a private directory. Root state lives in the
 * server directory, the client identity owns the client directory, and both are
 * children of one common mount so sockets can be published between them with
 * atomic hardlinks (separate bind mounts would fail with EXDEV):
 *
 * - root owner sockets (`exec-owner.sock`, `files.sock`, `terminal.sock`) are
 *   published from the server directory into the client directory;
 * - the browser owner's socket is published from its client-owned profile into
 *   `<server>/browser`, where root-side owners and the health check expect it;
 * - every owner credential has one root-owned and one client-owned 0600 copy
 *   with the same value. Only sockets cross the boundary; a connection still
 *   needs the credential and the 0700 directory that holds it.
 *
 * Startup never recursively re-owns, moves or copies existing data. Directories
 * it creates are new, empty and owned by their declared identity; anything that
 * does not match is a startup error, never a repair.
 *
 * Configuration (see deploy/docker/deploy/compose.root-hands.yaml):
 *   OPENCRAFT_ROOT_HANDS_SERVER_DIRECTORY  root-owned owner state (= OPENCRAFT_EXECUTION_DIR)
 *   OPENCRAFT_ROOT_HANDS_CLIENT_DIRECTORY  client-owned directory in the same mount
 *   OPENCRAFT_HANDS_CLIENT_DIRECTORY       the same client directory at the path clients use
 *   OPENCRAFT_HANDS_CLIENT_UID / _GID      nonroot client and browser identity
 *   OPENCRAFT_HANDS_BROWSER_NAME           `browser` (default) or `.` for a profile kept in the client root
 *   OPENCRAFT_HANDS_BROWSER_DIRECTORY      optional existing retained profile outside the server directory
 */

const MAX_ID = 2 ** 31 - 1;
/** Owner credentials shared by value between the root and client directories. */
export const ROOT_HANDS_CREDENTIALS = Object.freeze(["exec-owner.token", "files.token", "terminal.token"]);
/** Root owner endpoints published into the client directory. */
export const ROOT_HANDS_ENDPOINTS = Object.freeze(["exec-owner.sock", "files.sock", "terminal.sock"]);
const BROWSER_ENDPOINT = "owner.sock";
const CREDENTIAL = /^[a-f0-9]{64}$/u;
const SYNCHRONIZE_INTERVAL_MS = 100;

const contains = (parent, path) => path === parent || path.startsWith(parent + "/");
const suffix = () => `${process.pid}-${randomBytes(6).toString("hex")}`;
const ignoreMissing = (operation) => {
  try {
    operation();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};

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
  // The bridge publishes exactly these root-side paths; anything else would
  // leave an owner or the health check waiting on an endpoint nobody serves.
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
 * A private directory owned by `owner`, reached only through directories owned
 * by root or the client identity that nobody else can modify (root-owned sticky
 * directories such as /tmp excepted).
 */
function assertPrivateDirectory(path, owner, { uid }) {
  const info = fs.lstatSync(path, { throwIfNoEntry: false });
  if (!info) throw new Error(`Root Hands directory ${path} does not exist`);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`Root Hands directory ${path} must be a directory, not a link`);
  if (info.uid !== owner.uid || info.gid !== owner.gid)
    throw new Error(`Root Hands directory ${path} must be owned by ${owner.uid}:${owner.gid}`);
  if (info.mode & 0o077) throw new Error(`Root Hands directory ${path} must be private (no group/other access)`);
  for (let current = dirname(path); ; current = dirname(current)) {
    const parent = fs.lstatSync(current);
    const replaceable = (parent.mode & 0o022) !== 0 && !(parent.uid === 0 && (parent.mode & 0o1000) !== 0);
    if (parent.isSymbolicLink() || !parent.isDirectory() || replaceable || (parent.uid !== 0 && parent.uid !== uid))
      throw new Error(`Root Hands directory ancestor ${current} must not be replaceable by another user`);
    if (current === dirname(current)) break;
  }
}

/**
 * Creates one new empty private directory for `owner`, or accepts an existing
 * one that already satisfies the private-directory rule. Ownership is applied
 * through a no-follow descriptor, so a swapped-in link is never re-owned.
 */
function ensurePrivateDirectory(path, owner, configuration) {
  let created = false;
  try {
    fs.mkdirSync(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (created) {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      fs.fchownSync(fd, owner.uid, owner.gid);
    } finally {
      fs.closeSync(fd);
    }
  }
  assertPrivateDirectory(path, owner, configuration);
}

function readCredential(path, owner) {
  let fd;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Root Hands credential ${path} is not a readable regular file (${error.code})`);
  }
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== owner.uid || info.gid !== owner.gid || info.mode & 0o077 || info.size > 4096)
      throw new Error(`Root Hands credential ${path} must be a 0600 file owned by ${owner.uid}:${owner.gid}`);
    const value = fs.readFileSync(fd, "utf8").trim();
    if (!CREDENTIAL.test(value)) throw new Error(`Root Hands credential ${path} has an invalid format`);
    return value;
  } finally {
    fs.closeSync(fd);
  }
}

function writeCredential(path, value, owner) {
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(path, flags, 0o600);
  try {
    fs.fchownSync(fd, owner.uid, owner.gid);
    fs.writeFileSync(fd, value + "\n");
  } finally {
    fs.closeSync(fd);
  }
}

/** Fails before any owner starts if `from` cannot be hardlinked into `to`. */
function assertHardlinks(from, to) {
  const source = join(from, `.root-hands-probe-${suffix()}`),
    target = join(to, `.root-hands-probe-${suffix()}`);
  try {
    fs.writeFileSync(source, "", { flag: "wx", mode: 0o600 });
    fs.linkSync(source, target);
  } catch (error) {
    throw new Error(`Root Hands cannot hardlink ${from} into ${to} (${error.code}); use one common mount`);
  } finally {
    for (const path of [target, source]) ignoreMissing(() => fs.unlinkSync(path));
  }
}

/**
 * Validates the declared layout and prepares only what is missing: credential
 * copies and the empty default browser directories. Safe to repeat on restart:
 * existing credentials are kept, and disagreeing copies fail instead of rotating.
 */
export function prepareRootHands(configuration, { currentUid = process.getuid?.() } = {}) {
  if (currentUid !== 0) throw new Error("Root Hands requires the Hands supervisor to run as UID 0");
  const c = configuration,
    root = { uid: 0, gid: 0 },
    client = { uid: c.uid, gid: c.gid };
  assertPrivateDirectory(c.server, root, c);
  assertPrivateDirectory(c.client, client, c);
  assertPrivateDirectory(c.publicClient, client, c);
  if (c.browserDirectory) assertPrivateDirectory(c.browserDirectory, client, c);
  const bridged = fs.statSync(c.client),
    visible = fs.statSync(c.publicClient);
  if (bridged.dev !== visible.dev || bridged.ino !== visible.ino)
    throw new Error("Root Hands client directory and its client-visible path must be the same directory");
  assertHardlinks(c.server, c.client);
  if (c.browserDirectory) assertHardlinks(c.browserDirectory, c.server);

  for (const name of ROOT_HANDS_CREDENTIALS) {
    const rootPath = join(c.server, name),
      clientPath = join(c.client, name);
    const rootValue = readCredential(rootPath, root),
      clientValue = readCredential(clientPath, client);
    if (rootValue && clientValue && !timingSafeEqual(Buffer.from(rootValue), Buffer.from(clientValue)))
      throw new Error(`Root Hands credential copies of ${name} disagree; refusing to rotate them`);
    const value = rootValue ?? clientValue ?? randomBytes(32).toString("hex");
    if (!rootValue) writeCredential(rootPath, value, root);
    if (!clientValue) writeCredential(clientPath, value, client);
  }

  ensurePrivateDirectory(join(c.server, "browser"), root, c);
  const profile = rootHandsBrowserDirectory(c, c.client);
  // A declared or client-root profile is retained as is; only the default
  // `browser` child may be created, empty, for the client identity.
  if (profile === c.browserDirectory || profile === c.client) assertPrivateDirectory(profile, client, c);
  else ensurePrivateDirectory(profile, client, c);
}

/**
 * Creates missing default projectless session directories under the shared
 * workspace for the client identity, so root execution does not create them
 * root-owned for Brain. Existing directories and cwds outside the workspace are
 * retained as they are.
 */
export function prepareRootWorkspace(configuration, env = process.env) {
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
        fs.mkdirSync(path, { mode: 0o700 });
        const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try {
          fs.fchownSync(fd, client.uid, client.gid);
        } finally {
          fs.closeSync(fd);
        }
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const info = fs.lstatSync(path);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Projectless directory component ${path} must be a directory, not a link`);
    }
  }
}

function lstatOrNull(path) {
  return fs.lstatSync(path, { throwIfNoEntry: false }) ?? null;
}

/** Publishes the socket at `source` (owned by `ownerUid`) at `target` by hardlink. */
function publishSocket(source, target, ownerUid) {
  const socket = lstatOrNull(source);
  if (!socket) return;
  if (!socket.isSocket() || socket.uid !== ownerUid)
    throw new Error(`Root Hands endpoint ${source} must be a socket owned by UID ${ownerUid}`);
  const existing = lstatOrNull(target);
  if (existing && !existing.isSocket()) throw new Error(`Refusing to replace non-socket root Hands endpoint ${target}`);
  // Socket access is gated by the credential and the private directories; the
  // shared inode itself must be connectable by both identities.
  if ((socket.mode & 0o777) !== 0o666) fs.chmodSync(source, 0o666);
  if (existing && existing.dev === socket.dev && existing.ino === socket.ino) return;
  const temporary = `${target}.publish-${suffix()}`;
  try {
    fs.linkSync(source, temporary);
    const linked = fs.lstatSync(temporary);
    if (!linked.isSocket() || linked.uid !== ownerUid || linked.ino !== socket.ino)
      throw new Error(`Root Hands endpoint ${source} changed while it was published`);
    fs.renameSync(temporary, target);
  } finally {
    ignoreMissing(() => fs.unlinkSync(temporary));
  }
}

/** One synchronization pass; startup repeats it while Hands runs. */
export function synchronizeRootHands(configuration) {
  const c = configuration;
  for (const name of ROOT_HANDS_ENDPOINTS) publishSocket(join(c.server, name), join(c.client, name), 0);
  publishSocket(
    join(rootHandsBrowserDirectory(c, c.client), BROWSER_ENDPOINT),
    join(c.server, "browser", BROWSER_ENDPOINT),
    c.uid,
  );
}

/**
 * The core Hands options for root mode. The browser owner is dropped to the
 * client identity and sees its client-owned profile as OPENCRAFT_BROWSER_DATA_DIR
 * (validated by core before any owner starts). Owners that keep root identity
 * see the root-side directory where the bridge publishes the browser socket.
 */
export function rootHandsOwnerComposition(configuration, env = process.env) {
  const c = configuration;
  const rootBrowserData = env.OPENCRAFT_BROWSER_DATA_DIR ?? join(c.server, "browser");
  return {
    browserData: rootHandsBrowserDirectory(c, c.publicClient),
    rootBrowserData,
    ownerPrivileges: { browser: { uid: c.uid, gid: c.gid, home: c.browserDirectory ?? c.publicClient } },
    ownerEnvironment: (role, ownerEnv) =>
      role === "browser" ? ownerEnv : { ...ownerEnv, OPENCRAFT_BROWSER_DATA_DIR: rootBrowserData },
  };
}

/** Starts Hands in root mode. `start` and `spawnProcess` are test seams. */
export async function startRootHands({
  env = process.env,
  start = startContainerHands,
  spawnProcess = spawn,
  currentUid = process.getuid?.(),
} = {}) {
  const configuration = rootHandsConfiguration(env);
  prepareRootHands(configuration, { currentUid });
  prepareRootWorkspace(configuration, env);
  const { browserData, ownerPrivileges, ownerEnvironment } = rootHandsOwnerComposition(configuration, env);
  // Core validates the dropped browser against, and waits for its socket in,
  // the directory OPENCRAFT_BROWSER_DATA_DIR names in the supervisor.
  env.OPENCRAFT_BROWSER_DATA_DIR = browserData;
  await start({
    ownerPrivileges,
    spawnOwner: (command, args, options, { role } = {}) =>
      spawnProcess(command, args, { ...options, env: ownerEnvironment(role, options.env) }),
    startServices(fail) {
      const timer = setInterval(() => {
        try {
          synchronizeRootHands(configuration);
        } catch (error) {
          console.error(`Root Hands socket bridge failed; stopping instead of running degraded: ${error.message}`);
          clearInterval(timer);
          fail();
        }
      }, SYNCHRONIZE_INTERVAL_MS);
      return [{ close: async () => clearInterval(timer) }];
    },
  });
}
