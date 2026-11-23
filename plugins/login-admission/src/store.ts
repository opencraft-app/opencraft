// Worker-only module: it owns the SQLite connection. The network thread
// reaches it through `login-admission.worker.ts` and never imports this file.
import type { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, type DatabaseOutcome } from "@opencraft/sqlite-node";
import type { ServedOwner } from "@opencraft/worker-owner/serve";
import { LOGIN_ADMISSION_MIGRATIONS } from "./migrations";
import {
  LoginAdmissionConflict,
  type LoginAdmissionStoreData,
  type LoginAdmissionStoreMethods,
  type StoredHistory,
  type StoredIdentity,
  type StoredImport,
  type StoredPolicy,
} from "./store-protocol";

/** Single owner of one deployment's login admission policies, history and verified identities. */
export class LoginAdmissionStore implements LoginAdmissionStoreMethods {
  readonly outcome: DatabaseOutcome;
  readonly #db: DatabaseSync;
  constructor(path: string) {
    const managed = openManagedDatabase({ schemaId: "login-admission", path, migrations: LOGIN_ADMISSION_MIGRATIONS });
    this.#db = managed.database;
    this.outcome = managed.outcome;
  }
  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  #revision(policy: string): number {
    return Number(
      this.#db.prepare("SELECT revision FROM login_admission_policies WHERE policy=?").get(policy)?.revision ?? 0,
    );
  }
  #commit(
    policy: string,
    revision: number,
    rules: string,
    operator: string,
    at: number,
    action: string,
    detail: string,
  ): void {
    this.#db
      .prepare(
        "INSERT INTO login_admission_policies VALUES(?,?,?,?,?) ON CONFLICT(policy) DO UPDATE SET revision=excluded.revision,rules=excluded.rules,updated_at=excluded.updated_at,operator=excluded.operator",
      )
      .run(policy, revision, rules, at, operator);
    this.#db
      .prepare("INSERT INTO login_admission_versions VALUES(?,?,?,?,?)")
      .run(policy, revision, rules, at, operator);
    this.#db
      .prepare("INSERT INTO login_admission_audit(policy,revision,action,at,operator,detail) VALUES(?,?,?,?,?,?)")
      .run(policy, revision, action, at, operator, detail);
  }
  load(policy: string): StoredPolicy {
    const row = this.#db
      .prepare("SELECT revision,rules,updated_at FROM login_admission_policies WHERE policy=?")
      .get(policy);
    const identities = this.#db
      .prepare("SELECT subject,attributes FROM login_admission_identities WHERE policy=? ORDER BY subject")
      .all(policy)
      .map((item) => ({ subject: String(item.subject), attributes: String(item.attributes) }));
    return row
      ? { revision: Number(row.revision), rules: String(row.rules), updatedAt: Number(row.updated_at), identities }
      : { revision: 0, rules: null, updatedAt: null, identities };
  }
  history(policy: string, limit: number): StoredHistory {
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    return {
      versions: this.#db
        .prepare("SELECT revision,rules,at FROM login_admission_versions WHERE policy=? ORDER BY revision DESC LIMIT ?")
        .all(policy, bounded)
        .map((row) => ({ revision: Number(row.revision), rules: String(row.rules), at: Number(row.at) })),
      audit: this.#db
        .prepare(
          "SELECT revision,action,at,operator FROM login_admission_audit WHERE policy=? ORDER BY id DESC LIMIT ?",
        )
        .all(policy, bounded)
        .map((row) => ({
          revision: Number(row.revision),
          action: String(row.action),
          at: Number(row.at),
          operator: String(row.operator),
        })),
    };
  }
  publish(policy: string, expected: number, rules: string, operator: string, at: number, detail: string): number {
    return this.#transaction(() => {
      if (this.#revision(policy) !== expected) throw new LoginAdmissionConflict();
      this.#commit(policy, expected + 1, rules, operator, at, "publish", detail);
      return expected + 1;
    });
  }
  recordIdentity(policy: string, subject: string, attributes: string, at: number): void {
    this.#db
      .prepare(
        "INSERT INTO login_admission_identities VALUES(?,?,?,?) ON CONFLICT(policy,subject) DO UPDATE SET attributes=excluded.attributes,seen_at=excluded.seen_at WHERE attributes IS NOT excluded.attributes",
      )
      .run(policy, subject, attributes, at);
  }
  importPolicy(
    policy: string,
    source: string,
    rules: string,
    identities: readonly StoredIdentity[],
    operator: string,
    at: number,
    detail: string,
  ): StoredImport {
    return this.#transaction(() => {
      if (this.#db.prepare("SELECT 1 FROM login_admission_imports WHERE policy=? AND source=?").get(policy, source))
        return { imported: false, applied: false };
      // Never overwrite a document an administrator already published here.
      const revision = this.#revision(policy),
        applied = revision === 0;
      if (applied) this.#commit(policy, 1, rules, operator, at, "import", detail);
      const insert = this.#db.prepare(
        "INSERT INTO login_admission_identities VALUES(?,?,?,?) ON CONFLICT(policy,subject) DO NOTHING",
      );
      for (const identity of identities) insert.run(policy, identity.subject, identity.attributes, at);
      this.#db.prepare("INSERT INTO login_admission_imports VALUES(?,?,?)").run(policy, source, at);
      return { imported: true, applied };
    });
  }
  close(): void {
    this.#db.close();
  }
}

export function openLoginAdmissionStore(data: LoginAdmissionStoreData): ServedOwner {
  const store = new LoginAdmissionStore(data.path);
  return {
    methods: {
      load: (policy: string) => store.load(policy),
      history: (policy: string, limit: number) => store.history(policy, limit),
      publish: (policy: string, expected: number, rules: string, operator: string, at: number, detail: string) =>
        store.publish(policy, expected, rules, operator, at, detail),
      recordIdentity: (policy: string, subject: string, attributes: string, at: number) =>
        store.recordIdentity(policy, subject, attributes, at),
      importPolicy: (
        policy: string,
        source: string,
        rules: string,
        identities: readonly StoredIdentity[],
        operator: string,
        at: number,
        detail: string,
      ) => store.importPolicy(policy, source, rules, identities, operator, at, detail),
    },
    concurrentReads: ["history"],
    ready: store.outcome,
    close: () => store.close(),
  };
}
