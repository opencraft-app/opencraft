import { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, createSchemaValidator, type DatabaseOutcome } from "@opencraft/sqlite-node";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SshCodexServerBinding } from "./ssh-codex-connections.js";
import {
  SshManagementError,
  hostKeyFingerprint,
  knownHostsPath,
  parseSshConnectionInput,
  sshBinding,
  type SshConnectionInput,
  type SshConnectionRecord,
} from "./ssh-connection-records.js";

export * from "./ssh-connection-records.js";

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
const SCHEMA = "CREATE TABLE ssh_connections (server_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, config_json TEXT NOT NULL, host_key TEXT NOT NULL, credential BLOB NOT NULL) STRICT";
/** Published SQL is also consumed by the bounded legacy fallback builder. */
export const SSH_CONNECTION_MIGRATIONS = [
  { version: 1, name: "ssh-connections", sql: SCHEMA },
  { version: 2, name: "ssh-user-version", sql: "PRAGMA user_version=1" },
] as const;

/** Installation owner is the authority; the browser never receives credentials. */
export class SshConnectionStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  readonly outcome: DatabaseOutcome;
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
    try {
      // Existing SSH storage has a published v1 ledger. Keep its SQL and hash.
      // user_version is retained for old readers, never an alternative upgrade authority.
      if (!fresh) {
        const reader = new DatabaseSync(path, { readOnly: true });
        try {
          if (!reader.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").get()) throw new Error("Unsupported SSH database baseline");
          const userVersion = Number(reader.prepare("PRAGMA user_version").get()?.user_version);
          const history = reader.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();
          const interruptedFreshV1 = userVersion === 0 && history.length === 1 && history[0]!.version === 1
            && history[0]!.name === "ssh-connections" && history[0]!.checksum === createHash("sha256").update(SCHEMA).digest("hex");
          if ((userVersion !== 1 && !interruptedFreshV1)
            || reader.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ssh_connections'").get()?.sql !== SCHEMA
            || !reader.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").get()) {
            throw new Error("Unsupported SSH database baseline");
          }
        } finally { reader.close(); }
      }
      const managed = openManagedDatabase({ schemaId: "ssh-connection-store", path, legacyPolicy: "reject", validateSchema: createSchemaValidator(SCHEMA), migrations: SSH_CONNECTION_MIGRATIONS });
      this.db = managed.database;
      this.outcome = managed.outcome;
    } catch (error) { this.key.fill(0); throw error; }
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
      // Older clients may omit the new preference while editing another field.
      if (configuration.hideFromNewChat === undefined && row) {
        const previous = this.record(row);
        if (previous.hideFromNewChat !== undefined) configuration.hideFromNewChat = previous.hideFromNewChat;
      }
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
    this.writeKnownHosts(serverId);
    return sshBinding(this.directory, config, async () => this.password(serverId, config.revision));
  }
  /** DB is authority; known_hosts is a private, replaceable OpenSSH projection of it. */
  writeKnownHosts(serverId: string): void {
    const row = this.db.prepare("SELECT host_key FROM ssh_connections WHERE server_id=?").get(serverId);
    if (!row) throw new SshManagementError("missing", 404);
    const fd = openSync(knownHostsPath(this.directory, serverId), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, `${row.host_key}\n`); } finally { closeSync(fd); }
  }
  /** The stored password, only while the connection is enabled at the revision the binding was made for. */
  password(serverId: string, revision: number): string {
    const current = this.db.prepare("SELECT * FROM ssh_connections WHERE server_id=?").get(serverId);
    if (!current) throw new SshManagementError("missing", 404);
    const recipe = this.record(current);
    if (!recipe.enabled) throw new SshManagementError("unavailable", 409);
    if (recipe.revision !== revision) throw new SshManagementError("conflict", 409);
    return this.decrypt(serverId, current.credential as Uint8Array);
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
