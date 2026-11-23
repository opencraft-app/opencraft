import { lstatSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Optional per-role privilege policy for the Hands owner processes.
 *
 * A composition that runs Hands as UID 0 can name owner roles that must run under
 * an unprivileged numeric identity instead:
 *
 *   { browser: { uid: 1000, gid: 1000, home: "/var/lib/opencraft/browser-home" } }
 *
 * The policy is checked once, before any service or owner starts. Every problem
 * is a startup error: a declared drop is never skipped, so an owner can never
 * silently keep the supervisor's root identity.
 */

const MAX_ID = 2 ** 31 - 1;
const ENTRY_KEYS = new Set(["uid", "gid", "home"]);
// Owners whose private state directory is selected by the existing environment.
const ROLE_STATE_DIRECTORY = Object.freeze({ browser: "OPENCRAFT_BROWSER_DATA_DIR" });
// Per-user locations inherited from the supervisor would point a dropped owner at
// root's configuration and caches; without them, tools fall back to HOME.
const SUPERVISOR_USER_ENVIRONMENT = Object.freeze([
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
]);

function identity(role, name, value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ID)
    throw new Error(`Hands owner "${role}" ${name} must be an integer between 1 and ${MAX_ID}`);
  return value;
}

function absoluteDirectoryPath(role, name, value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === "/")
    throw new Error(`Hands owner "${role}" ${name} must be a normalized absolute directory other than /`);
  return value;
}

/**
 * The directory must exist, be a real directory owned by the dropped identity,
 * grant nothing to group or others, and be reachable only through directories
 * that another unprivileged user cannot replace.
 */
export function assertPrivateOwnedDirectory(path, { uid, gid }, label, stat = lstatSync) {
  let info;
  try {
    info = stat(path);
  } catch (error) {
    throw new Error(`${label} ${path} is not accessible (${error.code ?? error.message})`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} ${path} must be a directory, not a link`);
  if (info.uid !== uid || info.gid !== gid) throw new Error(`${label} ${path} must be owned by ${uid}:${gid}`);
  if (info.mode & 0o077) throw new Error(`${label} ${path} must not be accessible to group or others`);
  for (let current = dirname(path); ; current = dirname(current)) {
    const parent = stat(current);
    if (parent.isSymbolicLink() || !parent.isDirectory())
      throw new Error(`${label} ancestor ${current} must be a directory, not a link`);
    // A group/other-writable ancestor lets someone swap the path, unless it is a
    // root-owned sticky directory such as /tmp.
    const replaceable = (parent.mode & 0o022) !== 0 && !(parent.uid === 0 && (parent.mode & 0o1000) !== 0);
    if (replaceable || (parent.uid !== 0 && parent.uid !== uid))
      throw new Error(`${label} ancestor ${current} must not be replaceable by another user`);
    if (current === dirname(current)) break;
  }
}

/**
 * Validates `policy` against the known owner roles and the current filesystem.
 * Returns a frozen map from role to `{ uid, gid, home }`; an absent or empty
 * policy returns an empty map and changes nothing.
 */
export function resolveHandsOwnerPrivileges(
  policy,
  { roles, environment = process.env, currentUid = process.getuid?.(), stat = lstatSync },
) {
  if (policy === undefined) return Object.freeze({});
  if (policy === null || typeof policy !== "object" || Array.isArray(policy))
    throw new Error("Hands owner privileges must be an object keyed by owner role");
  const known = new Set(roles);
  const resolved = {};
  for (const [role, entry] of Object.entries(policy)) {
    if (!known.has(role)) throw new Error(`Unknown Hands owner role "${role}"`);
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`Hands owner "${role}" privileges must be an object`);
    for (const key of Object.keys(entry))
      if (!ENTRY_KEYS.has(key)) throw new Error(`Unsupported Hands owner "${role}" privilege setting "${key}"`);
    const uid = identity(role, "uid", entry.uid),
      gid = identity(role, "gid", entry.gid);
    const stateVariable = ROLE_STATE_DIRECTORY[role];
    const stateDirectory =
      stateVariable === undefined ? undefined : absoluteDirectoryPath(role, stateVariable, environment[stateVariable]);
    if (entry.home === undefined && stateDirectory === undefined)
      throw new Error(`Hands owner "${role}" needs an explicit home directory`);
    const home = entry.home === undefined ? stateDirectory : absoluteDirectoryPath(role, "home", entry.home);
    resolved[role] = Object.freeze({ uid, gid, home, ...(stateDirectory ? { stateDirectory } : {}) });
  }
  if (Object.keys(resolved).length === 0) return Object.freeze({});
  // Only root can switch identity; any other supervisor would fail at spawn time
  // or, worse, run the owner as itself.
  if (currentUid !== 0) throw new Error("Hands owner privilege drops require the Hands supervisor to run as UID 0");
  for (const [role, privilege] of Object.entries(resolved)) {
    if (privilege.stateDirectory)
      assertPrivateOwnedDirectory(privilege.stateDirectory, privilege, `Hands owner "${role}" state directory`, stat);
    if (privilege.home !== privilege.stateDirectory)
      assertPrivateOwnedDirectory(privilege.home, privilege, `Hands owner "${role}" home`, stat);
  }
  return Object.freeze(resolved);
}

/** Maps the base spawn options of one owner to its dropped identity. */
export function handsOwnerSpawnOptions(options, privilege) {
  if (!privilege) return options;
  const env = { ...options.env, HOME: privilege.home };
  for (const name of SUPERVISOR_USER_ENVIRONMENT) delete env[name];
  return { ...options, uid: privilege.uid, gid: privilege.gid, env };
}
