// The model usage policy owner over the runtime-neutral SQL port. Whoever opens
// and migrates the database (the Node owner in index.ts, a Durable Object
// through sql-owner.ts) hands it over; this module never opens storage itself.
import type { SqlDatabase } from "@opencraft/sql";
import type { SqlMigration } from "@opencraft/sql/migrations";
import { parseRules, type Rule } from "./rules.mjs";

/** The published schema (version 1); never rewritten. */
export const MODEL_POLICY_SCHEMA = `CREATE TABLE model_usage_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,rules TEXT NOT NULL) STRICT;
CREATE TABLE model_usage_audit(revision INTEGER PRIMARY KEY,actor TEXT NOT NULL,at INTEGER NOT NULL,before_rules TEXT NOT NULL,after_rules TEXT NOT NULL) STRICT;`;
export const modelPolicyMigrations: readonly SqlMigration[] = [
  { version: 1, name: "model-usage-policy", sql: MODEL_POLICY_SCHEMA },
];

/** How the opener found the database (the shape of the Node owner's `DatabaseOutcome`). */
export interface ModelPolicyOutcome {
  readonly status: string;
  readonly appliedVersion: number;
  readonly movedAsidePaths: readonly string[];
}

/** A migrated policy database handed over by the owner that opened it. */
export interface ModelPolicyDatabase {
  readonly database: SqlDatabase;
  readonly outcome: ModelPolicyOutcome | null;
  close(): void;
}

/** The deployment's model usage policy and its audit; the only writer of its database. */
export class ModelPolicyStore {
  protected readonly storage: ModelPolicyDatabase;
  constructor(storage: ModelPolicyDatabase) {
    this.storage = storage;
    this.storage.database.prepare("INSERT OR IGNORE INTO model_usage_policy VALUES(1,0,?)").run("[]");
  }
  get outcome() {
    return this.storage.outcome;
  }
  read(): { revision: number; rules: Rule[] } {
    const row = this.storage.database.prepare("SELECT revision,rules FROM model_usage_policy WHERE singleton=1").get()!;
    return { revision: Number(row.revision), rules: parseRules(JSON.parse(String(row.rules))) };
  }
  audit() {
    return this.storage.database.prepare("SELECT * FROM model_usage_audit ORDER BY revision DESC LIMIT 100").all();
  }
  write(revision: number, rules: Rule[], actor: string) {
    const valid = parseRules(rules),
      db = this.storage.database;
    if (!Number.isSafeInteger(revision) || revision < 0 || !actor) throw Error("invalid_model_policy");
    return db.transaction(() => {
      const previous = this.read();
      if (previous.revision !== revision) throw Error("revision_conflict");
      db.prepare("UPDATE model_usage_policy SET revision=?,rules=? WHERE singleton=1").run(
        revision + 1,
        JSON.stringify(valid),
      );
      db.prepare("INSERT INTO model_usage_audit VALUES(?,?,?,?,?)").run(
        revision + 1,
        actor,
        Date.now(),
        JSON.stringify(previous.rules),
        JSON.stringify(valid),
      );
      return { revision: revision + 1, rules: valid };
    });
  }
  close() {
    this.storage.close();
  }
}
