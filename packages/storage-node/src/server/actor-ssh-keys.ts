import { createHash } from "node:crypto";
import type { SqlDatabase } from "@opencraft/sql";

/** An active personal SSH key as the owner returns it. Never holds private key material. */
export interface StoredActorSshKey {
  readonly id: string;
  readonly actorId: string;
  readonly actorGeneration: number;
  readonly name: string;
  readonly algorithm: string;
  /** Normalized `<algorithm> <base64>` without a comment. */
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly createdAt: number;
  readonly createdBy: string;
}

/** A key with its revocation, for history listings. */
export interface StoredActorSshKeyHistory extends StoredActorSshKey {
  readonly revokedAt: number | null;
  readonly revokedBy: string | null;
  readonly revokedReason: string | null;
}

export interface ActorSshKeyAuditEntry {
  readonly id: number;
  readonly at: number;
  readonly operator: string;
  readonly actorId: string | null;
  readonly keyId: string | null;
  readonly fingerprint: string | null;
  readonly action: string;
  readonly result: string;
}

/** A key the caller already parsed and validated; the owner rechecks its shape and fingerprint. */
export interface ActorSshKeyInput {
  readonly id: string;
  readonly actorId: string;
  readonly actorGeneration: number;
  readonly name: string;
  readonly algorithm: string;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly operator: string;
  /** Audit action; an import records where its keys came from. */
  readonly action?: "add" | "import";
  readonly createdAt?: number;
}

/** Refusals carry a stable code in `message`; the owner Worker preserves it across the call. */
export class ActorSshKeyError extends Error {
  constructor(readonly code: ActorSshKeyErrorCode) {
    super(code);
    this.name = "ActorSshKeyError";
  }
}
export type ActorSshKeyErrorCode = "invalid_ssh_key" | "key_exists" | "key_in_use" | "key_limit" | "unknown_key";

export const ACTOR_SSH_KEY_ALGORITHMS = Object.freeze([
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
]);
/** Active keys one Actor may hold. */
export const ACTOR_SSH_KEY_LIMIT = 32;

export interface ActorSshKeyMethods {
  /** Every active key, loaded once into the network thread's projection. */
  actorSshKeysSnapshot(): StoredActorSshKey[];
  /** Commits one key; refuses an active fingerprint of any Actor. Every outcome is audited. */
  addActorSshKey(input: ActorSshKeyInput): StoredActorSshKey;
  /** Revokes one active key of the Actor. Every outcome is audited. */
  removeActorSshKey(
    actorId: string,
    keyId: string,
    operator: string,
  ): { readonly id: string; readonly fingerprint: string };
  /** Revokes every active key of the Actor (disable, membership revocation). Returns the revoked ids. */
  revokeActorSshKeys(actorId: string, operator: string, reason: string): string[];
  /** Active and revoked keys of one Actor, newest last. */
  actorSshKeyHistory(actorId: string): StoredActorSshKeyHistory[];
  /** Newest first; optionally for one Actor. */
  actorSshKeyAudit(actorId: string | null, limit: number): ActorSshKeyAuditEntry[];
}

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);

/** The OpenSSH SHA-256 fingerprint of a public key blob. */
export function sshKeyFingerprint(blob: Uint8Array): string {
  return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "");
}

function validInput(input: ActorSshKeyInput): void {
  if (
    !input ||
    !text(input.id, 128) ||
    !text(input.actorId, 512) ||
    !Number.isSafeInteger(input.actorGeneration) ||
    input.actorGeneration < 0 ||
    !text(input.name, 128) ||
    input.name.trim() !== input.name ||
    !ACTOR_SSH_KEY_ALGORITHMS.includes(input.algorithm) ||
    !text(input.publicKey, 16384) ||
    !text(input.operator, 256) ||
    (input.action !== undefined && input.action !== "add" && input.action !== "import") ||
    (input.createdAt !== undefined && (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0))
  )
    throw new ActorSshKeyError("invalid_ssh_key");
  const [algorithm, body, ...rest] = input.publicKey.split(" ");
  if (algorithm !== input.algorithm || !body || rest.length || !/^[A-Za-z0-9+/]+={0,2}$/u.test(body))
    throw new ActorSshKeyError("invalid_ssh_key");
  // The fingerprint is the projection's lookup key: derive it here, never trust it.
  if (sshKeyFingerprint(Buffer.from(body, "base64")) !== input.fingerprint)
    throw new ActorSshKeyError("invalid_ssh_key");
}

function active(row: Record<string, unknown>): StoredActorSshKey {
  return Object.freeze({
    id: String(row.id),
    actorId: String(row.actor_id),
    actorGeneration: Number(row.actor_generation),
    name: String(row.name),
    algorithm: String(row.algorithm),
    publicKey: String(row.public_key),
    fingerprint: String(row.fingerprint),
    createdAt: Number(row.created_at),
    createdBy: String(row.created_by),
  });
}

/** Invoked only in the Server owner Worker (or an offline tool holding the writer lock). */
export function actorSshKeyMethods(db: SqlDatabase, now: () => number = Date.now): ActorSshKeyMethods {
  const columns =
    "id,actor_id,actor_generation,name,algorithm,public_key,fingerprint,created_at,created_by,revoked_at,revoked_by,revoked_reason";
  const snapshot = db.prepare(`SELECT ${columns} FROM actor_ssh_keys WHERE revoked_at IS NULL ORDER BY created_at,id`);
  const byFingerprint = db.prepare("SELECT id,actor_id FROM actor_ssh_keys WHERE fingerprint=? AND revoked_at IS NULL");
  const countActive = db.prepare(
    "SELECT COUNT(*) AS count FROM actor_ssh_keys WHERE actor_id=? AND revoked_at IS NULL",
  );
  const insert =
    db.prepare(`INSERT INTO actor_ssh_keys(id,actor_id,actor_generation,name,algorithm,public_key,fingerprint,created_at,created_by)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const read = db.prepare(`SELECT ${columns} FROM actor_ssh_keys WHERE id=?`);
  const readActive = db.prepare(
    "SELECT id,fingerprint FROM actor_ssh_keys WHERE id=? AND actor_id=? AND revoked_at IS NULL",
  );
  const listActive = db.prepare(
    "SELECT id,fingerprint FROM actor_ssh_keys WHERE actor_id=? AND revoked_at IS NULL ORDER BY created_at,id",
  );
  const revoke = db.prepare(
    "UPDATE actor_ssh_keys SET revoked_at=?,revoked_by=?,revoked_reason=? WHERE id=? AND revoked_at IS NULL",
  );
  const history = db.prepare(`SELECT ${columns} FROM actor_ssh_keys WHERE actor_id=? ORDER BY created_at,id`);
  const auditInsert = db.prepare(
    "INSERT INTO actor_ssh_key_audit(at,operator,actor_id,key_id,fingerprint,action,result) VALUES(?,?,?,?,?,?,?)",
  );
  const auditAll = db.prepare("SELECT * FROM actor_ssh_key_audit ORDER BY id DESC LIMIT ?");
  const auditActor = db.prepare("SELECT * FROM actor_ssh_key_audit WHERE actor_id=? ORDER BY id DESC LIMIT ?");

  const clip = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : null);
  const audit = (
    operator: unknown,
    actorId: unknown,
    keyId: unknown,
    fingerprint: unknown,
    action: string,
    result: string,
  ) =>
    auditInsert.run(
      now(),
      clip(operator, 256) || "invalid-operator",
      clip(actorId, 512),
      clip(keyId, 128),
      typeof fingerprint === "string" && fingerprint.startsWith("SHA256:") ? fingerprint.slice(0, 64) : null,
      action,
      result,
    );
  const code = (error: unknown) => (error instanceof ActorSshKeyError ? error.code : "storage_failed");
  /** The change and its audit row commit together; a refusal is audited after the rollback. */
  const audited = <T>(write: () => T, refused: (reason: string) => void): T => {
    try {
      return db.transaction(write);
    } catch (error) {
      refused(code(error));
      throw error;
    }
  };

  return {
    actorSshKeysSnapshot: () => snapshot.all().map(active),
    addActorSshKey(input) {
      const action = input?.action ?? "add";
      return audited(
        () => {
          validInput(input);
          const prior = byFingerprint.get(input.fingerprint);
          if (prior) throw new ActorSshKeyError(prior.actor_id === input.actorId ? "key_exists" : "key_in_use");
          if (Number(countActive.get(input.actorId)!.count) >= ACTOR_SSH_KEY_LIMIT)
            throw new ActorSshKeyError("key_limit");
          insert.run(
            input.id,
            input.actorId,
            input.actorGeneration,
            input.name,
            input.algorithm,
            input.publicKey,
            input.fingerprint,
            input.createdAt ?? now(),
            input.operator,
          );
          audit(input.operator, input.actorId, input.id, input.fingerprint, action, "ok");
          return active(read.get(input.id)!);
        },
        (reason) => audit(input?.operator, input?.actorId, input?.id, input?.fingerprint, action, reason),
      );
    },
    removeActorSshKey(actorId, keyId, operator) {
      return audited(
        () => {
          if (!text(actorId, 512) || !text(keyId, 128) || !text(operator, 256))
            throw new ActorSshKeyError("invalid_ssh_key");
          const row = readActive.get(keyId, actorId);
          if (!row) throw new ActorSshKeyError("unknown_key");
          revoke.run(now(), operator, "removed", keyId);
          audit(operator, actorId, keyId, row.fingerprint, "remove", "ok");
          return { id: keyId, fingerprint: String(row.fingerprint) };
        },
        (reason) => audit(operator, actorId, keyId, null, "remove", reason),
      );
    },
    revokeActorSshKeys(actorId, operator, reason) {
      if (!text(actorId, 512) || !text(operator, 256) || !/^[a-z][a-z0-9_-]{0,63}$/u.test(reason))
        throw new ActorSshKeyError("invalid_ssh_key");
      return db.transaction(() => {
        const at = now();
        const rows = listActive.all(actorId);
        for (const row of rows) {
          revoke.run(at, operator, reason, row.id);
          audit(operator, actorId, row.id, row.fingerprint, "revoke:" + reason, "ok");
        }
        return rows.map((row) => String(row.id));
      });
    },
    actorSshKeyHistory(actorId) {
      if (!text(actorId, 512)) throw new ActorSshKeyError("invalid_ssh_key");
      return history.all(actorId).map((row) =>
        Object.freeze({
          ...active(row),
          revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
          revokedBy: row.revoked_by === null ? null : String(row.revoked_by),
          revokedReason: row.revoked_reason === null ? null : String(row.revoked_reason),
        }),
      );
    },
    actorSshKeyAudit(actorId, limit) {
      const bounded = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 1000) : 100;
      const rows =
        actorId === null ? auditAll.all(bounded) : text(actorId, 512) ? auditActor.all(actorId, bounded) : [];
      return rows.map((row) => ({
        id: Number(row.id),
        at: Number(row.at),
        operator: String(row.operator),
        actorId: row.actor_id === null ? null : String(row.actor_id),
        keyId: row.key_id === null ? null : String(row.key_id),
        fingerprint: row.fingerprint === null ? null : String(row.fingerprint),
        action: String(row.action),
        result: String(row.result),
      }));
    },
  };
}
