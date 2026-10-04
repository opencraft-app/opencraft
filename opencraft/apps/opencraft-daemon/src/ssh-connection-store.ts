import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SshCodexServerBinding } from "./ssh-codex-connections.js";
import { SshCodexTransport } from "./ssh-codex-transport.js";

export interface SshConnectionRecord {
  serverId: string;
  revision: number;
  displayName: string;
  hostname: string;
  port: number;
  username: string;
  enabled: boolean;
  workspaceBrowseRoots: string[];
  fingerprint: string;
}
export interface SshConnectionInput {
  displayName: string;
  hostname: string;
  port: number;
  username: string;
  enabled: boolean;
  workspaceBrowseRoots: string[];
  password?: string;
}
export class SshManagementError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "missing" | "locked" | "unavailable" | "trust", readonly status = 400) {
    super(code); this.name = "SshManagementError";
  }
}

export function parseSshConnectionInput(value: unknown): SshConnectionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SshManagementError("invalid");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(k => !["displayName", "hostname", "port", "username", "enabled", "workspaceBrowseRoots", "password"].includes(k))) throw new SshManagementError("invalid");
  const { displayName, hostname, port, username, enabled, workspaceBrowseRoots, password } = row;
  if (typeof displayName !== "string" || !displayName.trim() || displayName.length > 100 || /[\r\n\0]/u.test(displayName)
    || typeof hostname !== "string" || hostname.length > 253 || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/u.test(hostname)
    || typeof username !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/u.test(username)
    || !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535 || typeof enabled !== "boolean"
    || !Array.isArray(workspaceBrowseRoots) || workspaceBrowseRoots.length > 16 || workspaceBrowseRoots.some(p => typeof p !== "string" || !p.startsWith("/") || p.length > 4096 || /[\r\n\0]/u.test(p))
    || (password !== undefined && (typeof password !== "string" || !password || password.length > 4096 || /[\r\n\0]/u.test(password)))) throw new SshManagementError("invalid");
  return { displayName: displayName.trim(), hostname, port: Number(port), username, enabled, workspaceBrowseRoots: [...workspaceBrowseRoots] as string[], ...(password === undefined ? {} : { password: password as string }) };
}

/** No-follow owner-only reads, including key and legacy credential references. */
export function readPrivateSshFile(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new Error("Private SSH storage permissions required");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function privateKey(path: string, mayCreate: boolean): Buffer {
  if (mayCreate) {
    try { writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const key = readPrivateSshFile(path, 32);
  if (key.length !== 32) throw new Error("Invalid SSH credential key");
  return key;
}
export function hostKeyFingerprint(hostKey: string): string {
  const fields = hostKey.trim().split(/\s+/u);
  if (fields.length !== 3 || fields[1] !== "ssh-ed25519" || !/^[a-zA-Z0-9+/]+={0,2}$/u.test(fields[2]!)) throw new SshManagementError("trust");
  const decoded = Buffer.from(fields[2]!, "base64");
  if (decoded.length !== 51 || decoded.toString("base64") !== fields[2]
    || decoded.readUInt32BE(0) !== 11 || decoded.subarray(4, 15).toString() !== "ssh-ed25519" || decoded.readUInt32BE(15) !== 32) throw new SshManagementError("trust");
  return `SHA256:${createHash("sha256").update(decoded).digest("base64").replace(/=+$/u, "")}`;
}
const SCHEMA = "CREATE TABLE ssh_connections (server_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, config_json TEXT NOT NULL, host_key TEXT NOT NULL, credential BLOB NOT NULL) STRICT";
const BASELINE_HASH = createHash("sha256").update(SCHEMA).digest("hex");
const LEDGER_SCHEMA = "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT";

/** Installation owner is the authority; the browser never receives credentials. */
export class SshConnectionStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const info = fstatSync(dir); if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error("Private SSH directory required"); }
    finally { closeSync(dir); }
    const path = join(directory, "connections.sqlite");
    const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    let fresh: boolean;
    try { fresh = fstatSync(fd).size === 0; } finally { closeSync(fd); }
    readPrivateSshFile(path, 32 * 1024 * 1024);
    // Losing a key is a recovery failure, never permission to replace it and
    // silently strand existing encrypted credentials.
    this.key = privateKey(join(directory, "credential.key"), fresh);
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
      if (version === 0) {
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table'").get()) throw new Error("Unknown SSH database baseline");
        this.db.exec(`${LEDGER_SCHEMA}; ${SCHEMA}; PRAGMA user_version=1`);
        this.db.prepare("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(1,'ssh-connections',?,?)").run(BASELINE_HASH, Date.now());
      } else if (version !== 1) throw new Error("Unsupported SSH database version");
      const history = this.db.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();
      if (history.length !== 1 || history[0]!.version !== 1 || history[0]!.name !== "ssh-connections" || history[0]!.checksum !== BASELINE_HASH
        || this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ssh_connections'").get()?.sql !== SCHEMA) throw new Error("Unsupported SSH database migration history");
      this.db.prepare("SELECT server_id,revision,config_json,host_key,credential FROM ssh_connections LIMIT 0").all();
      this.db.exec("COMMIT");
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); this.db.close(); this.key.fill(0); throw error; }
  }
  list(): SshConnectionRecord[] {
    return this.db.prepare("SELECT server_id,revision,config_json,host_key FROM ssh_connections ORDER BY rowid").all().map(row => this.record(row));
  }
  get(serverId: string): SshConnectionRecord {
    const row = this.db.prepare("SELECT server_id,revision,config_json,host_key FROM ssh_connections WHERE server_id=?").get(serverId);
    if (!row) throw new SshManagementError("missing", 404);
    return this.record(row);
  }
  save(serverId: string | null, revision: number, input: SshConnectionInput, trustedHostKey?: string): SshConnectionRecord {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new SshManagementError("invalid");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = serverId === null ? undefined : this.db.prepare("SELECT * FROM ssh_connections WHERE server_id=?").get(serverId);
      if ((serverId !== null && !row) || (serverId === null && revision !== 0)) throw new SshManagementError("missing", 404);
      if (Number(row?.revision ?? 0) !== revision) throw new SshManagementError("conflict", 409);
      if (!row && this.list().length >= 32) throw new SshManagementError("invalid");
      if (row) {
        const previous = this.record(row);
        // A different remote identity is a new binding, never old Thread identity.
        if (previous.hostname !== input.hostname || previous.port !== input.port || previous.username !== input.username) throw new SshManagementError("invalid");
      }
      const id = serverId ?? `ssh:${randomUUID()}`;
      const hostKey = trustedHostKey ?? String(row?.host_key ?? "");
      hostKeyFingerprint(hostKey);
      const host = input.port === 22 ? input.hostname : `[${input.hostname}]:${input.port}`;
      if (hostKey.split(/\s+/u)[0] !== host) throw new SshManagementError("trust");
      const { password, ...configuration } = input;
      if (!row && !password) throw new SshManagementError("invalid");
      const credential = password ? this.encrypt(id, password) : row!.credential as Uint8Array;
      this.db.prepare("INSERT INTO ssh_connections(server_id,revision,config_json,host_key,credential) VALUES(?,?,?,?,?) ON CONFLICT(server_id) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,host_key=excluded.host_key,credential=excluded.credential")
        .run(id, revision + 1, JSON.stringify(configuration), hostKey, credential);
      this.db.exec("COMMIT");
      return this.get(id);
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }
  remove(serverId: string, revision: number): void {
    if (this.get(serverId).revision !== revision) throw new SshManagementError("conflict", 409);
    const result = this.db.prepare("DELETE FROM ssh_connections WHERE server_id=? AND revision=?").run(serverId, revision);
    if (result.changes !== 1) throw new SshManagementError("conflict", 409);
  }
  binding(serverId: string): SshCodexServerBinding {
    const config = this.get(serverId);
    if (!config.enabled) throw new SshManagementError("unavailable", 409);
    const row = this.db.prepare("SELECT host_key FROM ssh_connections WHERE server_id=?").get(serverId)!;
    const trustPath = join(this.directory, `${serverId.slice(4)}.known_hosts`);
    // DB is authority; this is a private, replaceable OpenSSH projection.
    const fd = openSync(trustPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, `${row.host_key}\n`); } finally { closeSync(fd); }
    const connection = {
      hostname: config.hostname, port: config.port, username: config.username, knownHostsFile: trustPath,
      authentication: { kind: "password" as const, resolvePassword: async () => {
        const current = this.db.prepare("SELECT * FROM ssh_connections WHERE server_id=?").get(serverId);
        if (!current) throw new SshManagementError("missing", 404);
        const recipe = this.record(current);
        if (!recipe.enabled) throw new SshManagementError("unavailable", 409);
        if (recipe.revision !== config.revision) throw new SshManagementError("conflict", 409);
        return this.decrypt(serverId, current.credential as Uint8Array);
      } },
    };
    new SshCodexTransport(connection);
    return { descriptor: { serverId, displayName: config.displayName, workspaceBrowseRoots: config.workspaceBrowseRoots }, connection };
  }
  close() { this.db.close(); this.key.fill(0); }
  private record(row: Record<string, unknown>): SshConnectionRecord {
    const config = parseSshConnectionInput(JSON.parse(String(row.config_json)));
    if (config.password !== undefined || !/^ssh:[a-zA-Z0-9._-]{1,80}$/u.test(String(row.server_id))) throw new Error("Invalid SSH database record");
    return { ...config, serverId: String(row.server_id), revision: Number(row.revision), fingerprint: hostKeyFingerprint(String(row.host_key)) };
  }
  private encrypt(id: string, secret: string): Buffer {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(id));
    return Buffer.concat([nonce, cipher.update(secret, "utf8"), cipher.final(), cipher.getAuthTag()]);
  }
  private decrypt(id: string, encrypted: Uint8Array): string {
    const data = Buffer.from(encrypted), cipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
    cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString("utf8");
  }
}
