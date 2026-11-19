import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, existsSync, lstatSync, chmodSync } from "node:fs";
import { join } from "node:path";

/** One physical connection and transaction owner. Repositories share this unit of work. */
export class SqliteUnitOfWork {
  constructor(profile) {
    this.db = new DatabaseSync(join(profile.path, "assistant.sqlite"));
    this.depth = 0;
    this.participants = [];
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21].includes(version)) {
      this.db.close();
      throw new Error(`Unsupported domain schema ${version}`);
    }
    if (version > 0 && version < 21) {
      const directory = join(profile.path, "backups"),
        backup = join(directory, `schema${version}-before-coordination.sqlite`);
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (lstatSync(directory).isSymbolicLink()) throw new Error("Unsafe database backup directory");
        if (!existsSync(backup)) {
          this.db.prepare("VACUUM INTO ?").run(backup);
          chmodSync(backup, 0o600);
        } else if (!lstatSync(backup).isFile() || lstatSync(backup).mode & 0o077)
          throw new Error("Unsafe existing database backup");
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
    this.db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    if (version < 2)
      this.transaction(() => {
        this.db.exec(`ALTER TABLE work ADD COLUMN delegation_json TEXT;
        CREATE TABLE conversation(id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL);
        CREATE TABLE conversation_message(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversation(id),role TEXT NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL);
        CREATE TABLE conversation_work(conversation_id TEXT NOT NULL REFERENCES conversation(id),work_id TEXT NOT NULL REFERENCES work(id),PRIMARY KEY(conversation_id,work_id));
        CREATE TABLE reception(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversation(id),text TEXT NOT NULL,status TEXT NOT NULL,decision_json TEXT,reply_text TEXT,work_id TEXT,created_at INTEGER NOT NULL);
        PRAGMA user_version=2;`);
      });
    if (version < 3)
      this.transaction(() => {
        this.db.exec(`CREATE TABLE interaction(
        id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES work(id),revision INTEGER NOT NULL,
        execution_id TEXT NOT NULL REFERENCES execution(id),call_id TEXT NOT NULL,question TEXT NOT NULL,
        owner TEXT NOT NULL,state TEXT NOT NULL,answer TEXT,answer_input_id TEXT,created_at INTEGER NOT NULL,answered_at INTEGER,
        UNIQUE(execution_id,call_id));
        CREATE INDEX interaction_pending ON interaction(work_id,revision,state);
        PRAGMA user_version=3;`);
      });
    if (version < 4)
      this.transaction(() => {
        this.db.exec(`ALTER TABLE work ADD COLUMN completion_json TEXT;
        CREATE TABLE completion_evidence(id TEXT PRIMARY KEY,execution_id TEXT NOT NULL REFERENCES execution(id),kind TEXT NOT NULL,data_json TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE INDEX completion_evidence_execution ON completion_evidence(execution_id);
        CREATE TABLE completion_assessment(execution_id TEXT PRIMARY KEY REFERENCES execution(id),work_id TEXT NOT NULL REFERENCES work(id),revision INTEGER NOT NULL,data_json TEXT NOT NULL,created_at INTEGER NOT NULL);
        PRAGMA user_version=4;`);
      });
    if (version < 5)
      this.transaction(() => {
        this.db.exec(
          "ALTER TABLE reception ADD COLUMN query_scope_json TEXT; CREATE INDEX IF NOT EXISTS reception_history_window ON conversation_message(conversation_id,seq); PRAGMA user_version=5;",
        );
      });
    if (version < 6)
      this.transaction(() => {
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS skill(id TEXT PRIMARY KEY,plugin_id TEXT NOT NULL,version TEXT NOT NULL,summary TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS skill_version(skill_id TEXT NOT NULL,version TEXT NOT NULL,summary TEXT NOT NULL,body TEXT NOT NULL,installed_at INTEGER NOT NULL,PRIMARY KEY(skill_id,version));
        CREATE TABLE IF NOT EXISTS skill_load(execution_id TEXT NOT NULL REFERENCES execution(id),skill_id TEXT NOT NULL,version TEXT NOT NULL,loaded_at INTEGER NOT NULL,PRIMARY KEY(execution_id,skill_id));
        PRAGMA user_version=6;`);
      });
    if (version < 7)
      this.transaction(() => {
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS memory_provenance(key TEXT PRIMARY KEY,revision INTEGER NOT NULL,origin TEXT NOT NULL,evidence_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_learning(id TEXT PRIMARY KEY,state TEXT NOT NULL,evidence_json TEXT NOT NULL,snapshot_json TEXT NOT NULL,proposal_json TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL);
        PRAGMA user_version=7;`);
      });
    if (version < 8)
      this.transaction(() => {
        this.db.exec(`ALTER TABLE work ADD COLUMN origin_json TEXT;
        ALTER TABLE routine ADD COLUMN notify TEXT NOT NULL DEFAULT 'never';
        CREATE TABLE trigger_rule(id TEXT PRIMARY KEY,type TEXT NOT NULL,path TEXT,goal TEXT NOT NULL,notify TEXT NOT NULL,resources_json TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE assistant_event(id TEXT PRIMARY KEY,type TEXT NOT NULL,data_json TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE trigger_occurrence(event_id TEXT NOT NULL,rule_id TEXT NOT NULL,revision INTEGER NOT NULL,work_id TEXT NOT NULL UNIQUE,PRIMARY KEY(event_id,rule_id,revision));
        CREATE TABLE file_observation(path TEXT PRIMARY KEY,sha256 TEXT,revision INTEGER NOT NULL);
        CREATE TABLE notification(id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL,conversation_id TEXT NOT NULL,origin_key TEXT NOT NULL,content_hash TEXT NOT NULL,work_id TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE INDEX notification_pending ON notification(state,created_at);
        PRAGMA user_version=8;`);
      });
    if (version < 9)
      this.transaction(() =>
        this.db.exec(
          `CREATE TABLE IF NOT EXISTS attention(id INTEGER PRIMARY KEY CHECK(id=1),last_active_at INTEGER NOT NULL,last_viewed_at INTEGER NOT NULL,unread_count INTEGER NOT NULL,fire_count INTEGER NOT NULL,nudged_at INTEGER,paused_at INTEGER,snoozed_until INTEGER NOT NULL); PRAGMA user_version=9;`,
        ),
      );
    if (version < 10)
      this.transaction(() =>
        this.db.exec(
          `ALTER TABLE interaction ADD COLUMN kind TEXT NOT NULL DEFAULT 'question'; ALTER TABLE interaction ADD COLUMN expires_at INTEGER; ALTER TABLE interaction ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'; PRAGMA user_version=10;`,
        ),
      );
    if (version < 11)
      this.transaction(() =>
        this.db.exec(`
        ALTER TABLE execution ADD COLUMN request_json TEXT;
        CREATE TABLE IF NOT EXISTS execution_report(
          id TEXT PRIMARY KEY,execution_id TEXT NOT NULL UNIQUE REFERENCES execution(id),
          work_id TEXT NOT NULL REFERENCES work(id),revision INTEGER NOT NULL,
          status TEXT NOT NULL,text TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL);
        ALTER TABLE reception ADD COLUMN source_json TEXT;
        ALTER TABLE reception ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE reception ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE delivery ADD COLUMN message_text TEXT;
        ALTER TABLE delivery ADD COLUMN suppress_notification INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE routine ADD COLUMN resources_json TEXT;
        PRAGMA user_version=11;
      `),
      );
    if (version < 12)
      this.transaction(() =>
        this.db.exec(`
      ALTER TABLE execution ADD COLUMN guard_json TEXT;
      CREATE TABLE IF NOT EXISTS usage_observation(id TEXT PRIMARY KEY,kind TEXT NOT NULL,work_id TEXT REFERENCES work(id),mode TEXT NOT NULL,data_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_work ON usage_observation(work_id,id);
      PRAGMA user_version=12;
    `),
      );
    if (version < 13)
      this.transaction(() =>
        this.db.exec(`
        ALTER TABLE routine ADD COLUMN schedule_json TEXT;
        ALTER TABLE routine ADD COLUMN last_scheduled_at INTEGER;
        ALTER TABLE routine ADD COLUMN stop_when TEXT;
        CREATE TABLE memory_detail(key TEXT PRIMARY KEY REFERENCES memory(key),scope TEXT NOT NULL,project_id TEXT,kind TEXT NOT NULL,updated_at INTEGER NOT NULL);
        CREATE INDEX memory_detail_scope ON memory_detail(project_id,kind,updated_at);
        PRAGMA user_version=13;
      `),
      );
    if (version < 14)
      this.transaction(() =>
        this.db.exec(`
      CREATE TABLE memory_tombstone(id TEXT PRIMARY KEY,scope TEXT NOT NULL,project_id TEXT,content TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE memory_refresh(scope TEXT PRIMARY KEY,next_at INTEGER NOT NULL);
      CREATE TABLE memory_learning_control(id TEXT PRIMARY KEY,value INTEGER NOT NULL);
      ALTER TABLE memory_learning ADD COLUMN batch_ids_json TEXT;
      ALTER TABLE memory_learning ADD COLUMN temporal INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memory_learning ADD COLUMN today TEXT;
      PRAGMA user_version=14;
    `),
      );
    if (version < 15)
      this.transaction(() =>
        this.db.exec(`
      CREATE TABLE memory_shard(key TEXT PRIMARY KEY REFERENCES memory(key),agent_id TEXT NOT NULL,agent_name TEXT NOT NULL,content_id TEXT,path TEXT);
      CREATE TABLE memory_file_state(id INTEGER PRIMARY KEY CHECK(id=1),root TEXT NOT NULL,agent_id TEXT NOT NULL,fingerprint TEXT NOT NULL,cache_hash TEXT NOT NULL);
      CREATE TABLE memory_file_commit(id TEXT PRIMARY KEY);
      PRAGMA user_version=15;
    `),
      );
    if (version < 16)
      this.transaction(() =>
        this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_context(
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversation(id),
          parent_id TEXT REFERENCES conversation_context(id), state TEXT NOT NULL,
          start_seq INTEGER NOT NULL,start_offset INTEGER NOT NULL,end_seq INTEGER NOT NULL,end_offset INTEGER NOT NULL,
          source_json TEXT NOT NULL,summary_json TEXT,attempts INTEGER NOT NULL DEFAULT 0,
          next_at INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL,ready_at INTEGER);
        CREATE INDEX IF NOT EXISTS conversation_context_frontier ON conversation_context(conversation_id,state,end_seq,end_offset);
        PRAGMA user_version=16;
      `),
      );
    if (version < 17)
      this.transaction(() =>
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_message(id TEXT PRIMARY KEY REFERENCES conversation_message(id),conversation_id TEXT NOT NULL REFERENCES conversation(id),body_json TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT,receipt_json TEXT,created_at INTEGER NOT NULL,accepted_at INTEGER);
      CREATE INDEX IF NOT EXISTS user_message_pending ON user_message(conversation_id,state,next_at);
      ALTER TABLE delivery ADD COLUMN user_message_json TEXT;
      ALTER TABLE notification ADD COLUMN user_message_json TEXT;
      PRAGMA user_version=17;
    `),
      );
    if (version < 18)
      this.transaction(() =>
        this.db.exec(`
      ALTER TABLE execution ADD COLUMN harness TEXT NOT NULL DEFAULT 'pi' CHECK(harness IN ('pi','codex'));
      CREATE TABLE execution_native_receipt(execution_id TEXT NOT NULL REFERENCES execution(id),call_id TEXT NOT NULL,tool TEXT NOT NULL,args_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','waiting','completed')),output_json TEXT,PRIMARY KEY(execution_id,call_id));
      PRAGMA user_version=18;
    `),
      );
    if (version < 19) {
      // Rebuild only execution to remove the former one-attempt-per-revision key.
      // Foreign keys point to the final table name; validate before committing.
      this.db.exec("PRAGMA foreign_keys=OFF");
      try {
        this.transaction(() => {
          this.db.exec(`
            CREATE TABLE execution_next(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES work(id),revision INTEGER NOT NULL,
              input_id TEXT NOT NULL,status TEXT NOT NULL,submission_id TEXT,conversation_id TEXT,context_json TEXT,
              request_json TEXT,guard_json TEXT,harness TEXT NOT NULL DEFAULT 'pi' CHECK(harness IN ('pi','codex')),
              attempt INTEGER NOT NULL DEFAULT 1,predecessor_id TEXT,session_root TEXT,
              UNIQUE(work_id,revision,attempt));
            INSERT INTO execution_next(id,work_id,revision,input_id,status,submission_id,conversation_id,context_json,request_json,guard_json,harness,session_root)
              SELECT id,work_id,revision,input_id,status,submission_id,conversation_id,context_json,request_json,guard_json,harness,id FROM execution;
            DROP TABLE execution;
            ALTER TABLE execution_next RENAME TO execution;
            ALTER TABLE work ADD COLUMN active_execution_id TEXT REFERENCES execution(id);
            UPDATE work SET active_execution_id=(SELECT id FROM execution e WHERE e.work_id=work.id AND e.revision=work.revision);
            CREATE TABLE work_directive(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,work_id TEXT NOT NULL REFERENCES work(id),
              revision INTEGER NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('accepted','scheduled','submitted','superseded')),
              execution_id TEXT REFERENCES execution(id),created_at INTEGER NOT NULL);
            PRAGMA user_version=19;
          `);
          if (this.db.prepare("PRAGMA foreign_key_check").all().length)
            throw new Error("Coordination migration violates foreign keys");
        });
      } finally {
        this.db.exec("PRAGMA foreign_keys=ON");
      }
    }
    if (version < 20)
      this.transaction(() =>
        this.db.exec(`
      CREATE TABLE goal(id TEXT PRIMARY KEY,objective TEXT NOT NULL,criteria_json TEXT NOT NULL,revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','paused','cancelled','achieved')),priority INTEGER NOT NULL,max_parallel INTEGER NOT NULL,created_at INTEGER NOT NULL,confirmation_json TEXT,resources_json TEXT NOT NULL);
      CREATE TABLE goal_work(goal_id TEXT NOT NULL REFERENCES goal(id),work_id TEXT PRIMARY KEY REFERENCES work(id),task_key TEXT NOT NULL,UNIQUE(goal_id,task_key));
      CREATE TABLE work_dependency(work_id TEXT NOT NULL REFERENCES work(id),upstream_id TEXT NOT NULL REFERENCES work(id),revision INTEGER NOT NULL,PRIMARY KEY(work_id,upstream_id));
      CREATE TABLE execution_dependency(execution_id TEXT NOT NULL REFERENCES execution(id),upstream_id TEXT NOT NULL,result_id TEXT NOT NULL REFERENCES result(id),PRIMARY KEY(execution_id,upstream_id));
      PRAGMA user_version=20;
    `),
      );
    if (version < 21)
      this.transaction(() =>
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_thread_link(
        execution_id TEXT NOT NULL REFERENCES execution(id),id TEXT NOT NULL,argv_json TEXT NOT NULL,
        operation_id TEXT,outcome_json TEXT,PRIMARY KEY(execution_id,id));
      CREATE INDEX IF NOT EXISTS execution_thread_unsettled ON execution_thread_link(execution_id) WHERE outcome_json IS NULL;
      CREATE TABLE IF NOT EXISTS execution_thread_answer(execution_id TEXT PRIMARY KEY REFERENCES execution(id),text TEXT NOT NULL,error TEXT);
      PRAGMA user_version=21;
    `),
      );
  }
  claimWriter() {
    if (this.writerToken) throw Error("Writer already claimed");
    const token = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO meta(key,value) VALUES('runtime.writer',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(token);
      this.db.exec("COMMIT");
      this.writerToken = token;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return token;
  }
  assertWriter() {
    this.authorityGuard?.();
    if (
      this.closed ||
      (this.writerToken &&
        this.db.prepare("SELECT value FROM meta WHERE key='runtime.writer'").get()?.value !== this.writerToken)
    )
      throw Error("Bot writer retired");
  }
  transaction(fn) {
    if (fn.constructor.name === "AsyncFunction")
      throw new Error("Async work is forbidden inside a synchronous unit of work");
    const depth = this.depth,
      name = `uow_${depth}`;
    this.db.exec(depth ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
    this.depth++;
    const entered = [];
    let committed = false;
    try {
      this.assertWriter();
      for (const participant of this.participants) {
        participant.enter(depth);
        entered.push(participant);
      }
      const result = fn();
      if (result && typeof result.then === "function")
        throw new Error("Async work is forbidden inside a synchronous unit of work");
      this.assertWriter();
      if (!depth) for (const participant of entered) participant.prepare();
      this.assertWriter();
      this.db.exec(depth ? `RELEASE SAVEPOINT ${name}` : "COMMIT");
      committed = true;
      for (const participant of entered) participant.commit(depth);
      return result;
    } catch (error) {
      if (!committed) {
        this.db.exec(depth ? `ROLLBACK TO SAVEPOINT ${name}` : "ROLLBACK");
        if (depth) this.db.exec(`RELEASE SAVEPOINT ${name}`);
      }
      for (const participant of entered.reverse()) participant.rollback(depth, committed);
      throw error;
    } finally {
      this.depth--;
    }
  }
  participate(participant) {
    this.participants.push(participant);
  }

  close() {
    this.closed = true;
    this.db.close();
  }
}
