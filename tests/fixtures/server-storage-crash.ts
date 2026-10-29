import { DatabaseSync } from "node:sqlite";
const [directory, stage] = process.argv.slice(2);
let armed = false;
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql: string) {
  const statement = prepare.call(this, sql);
  if (sql.includes("INSERT INTO opencraft_server_installation")) {
    const run = statement.run.bind(statement);
    statement.run = (...args: Parameters<typeof run>) => { const result = run(...args); armed = true; return result; };
  }
  return statement;
};
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql: string) {
  exec.call(this, sql);
  if (stage === "during-import" && sql.includes('INSERT INTO main."actor_authority"') || stage === "after-commit" && armed && sql === "COMMIT") {
    process.kill(process.pid, "SIGKILL");
  }
};
const { openServerDatabase } = await import("../../packages/storage-node/src/server/index.js");
const storage = await openServerDatabase(directory!);
await storage.close();
throw new Error("Crash boundary was not reached");
