import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DshSessionRouting } from "../../apps/local-agent-host/src/dsh-session-routing.js";
import { DshExecutionAuthority } from "../../apps/local-agent-host/src/dsh-execution-authority.js";
import { ConnectorDatabase } from "@opencraft/connector-host";

export function seedLegacyHostStorage(directory: string) {
  mkdirSync(directory, { recursive: true });
  const routingPath = join(directory, "opencraft-session-routing.sqlite");
  new DshSessionRouting(routingPath).close();
  const routing = new DatabaseSync(routingPath);
  try { routing.exec("DROP TABLE schema_migrations; ALTER TABLE dsh_pending_generations DROP COLUMN intent"); }
  finally { routing.close(); }
  const threads = new DatabaseSync(join(directory, "opencraft-threads.sqlite"));
  try {
    threads.exec("CREATE TABLE opencraft_threads (id TEXT PRIMARY KEY, document TEXT NOT NULL)");
    threads.prepare("INSERT INTO opencraft_threads VALUES (?, ?)").run("legacy-thread", JSON.stringify({ snapshot: {
      id: "legacy-thread", name: "Legacy title", cwd: directory, preview: "", createdAt: 1, updatedAt: 1,
      status: { type: "idle" }, turns: [], parentThreadId: null, forkedFromId: null,
    }, manualTitle: "Legacy title", archived: false, configuration: {} }));
  } finally { threads.close(); }
  const connectorsPath = join(directory, "opencraft-managed-connectors.sqlite");
  new ConnectorDatabase(connectorsPath).close();
  const connectors = new DatabaseSync(connectorsPath);
  try { connectors.exec("DROP TABLE schema_migrations"); } finally { connectors.close(); }
}

export function seedNewerHostStorage(directory: string) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "opencraft-executions.sqlite");
  new DshExecutionAuthority(path).close();
  const database = new DatabaseSync(path);
  try { database.exec("INSERT INTO schema_migrations VALUES (2, 'future', 'future', 0)"); }
  finally { database.close(); }
}
