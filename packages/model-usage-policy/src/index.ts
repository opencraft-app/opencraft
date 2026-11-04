import { openManagedDatabase, createSchemaValidator } from '@opencraft/sqlite-node';
import { parseRules, type Rule } from './native.mjs';
export * from './native.mjs';
const schema = `CREATE TABLE model_usage_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,rules TEXT NOT NULL) STRICT;
CREATE TABLE model_usage_audit(revision INTEGER PRIMARY KEY,actor TEXT NOT NULL,at INTEGER NOT NULL,before_rules TEXT NOT NULL,after_rules TEXT NOT NULL) STRICT;`;
export const modelPolicyMigrations = [{version:1,name:'model-usage-policy',sql:schema}];
export class ModelPolicyStore {
  private managed;
  constructor(path:string) {
    this.managed = openManagedDatabase({path,migrations:modelPolicyMigrations,legacyPolicy:'reject',validateSchema:createSchemaValidator(schema)});
    this.managed.database.prepare('INSERT OR IGNORE INTO model_usage_policy VALUES(1,0,?)').run('[]');
  }
  get outcome() { return this.managed.outcome; }
  read() {
    const row = this.managed.database.prepare('SELECT revision,rules FROM model_usage_policy WHERE singleton=1').get()!;
    return {revision:Number(row.revision),rules:parseRules(JSON.parse(String(row.rules)))};
  }
  audit() { return this.managed.database.prepare('SELECT * FROM model_usage_audit ORDER BY revision DESC LIMIT 100').all(); }
  write(revision:number,rules:Rule[],actor:string) {
    const valid = parseRules(rules), db=this.managed.database;
    if (!Number.isSafeInteger(revision) || revision<0 || !actor) throw Error('invalid_model_policy');
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous=this.read(); if(previous.revision!==revision) throw Error('revision_conflict');
      db.prepare('UPDATE model_usage_policy SET revision=?,rules=? WHERE singleton=1').run(revision+1,JSON.stringify(valid));
      db.prepare('INSERT INTO model_usage_audit VALUES(?,?,?,?,?)').run(revision+1,actor,Date.now(),JSON.stringify(previous.rules),JSON.stringify(valid));
      db.exec('COMMIT'); return {revision:revision+1,rules:valid};
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  close() {this.managed.database.close();}
}
