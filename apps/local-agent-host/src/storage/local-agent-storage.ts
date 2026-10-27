import { TasksSqliteStore } from "@opencraft/plugin-tasks/sqlite";
import { resolve } from "node:path";
import { ManagedConnectorService } from "@opencraft/connector-host";
import { SqliteDocumentStore } from "@opencraft/document-storage/sqlite";
import { SqliteLifecycleError, type DatabaseOutcome } from "@opencraft/sqlite-node";
import { DshSessionRouting } from "../dsh-session-routing.js";
import { ThreadCatalog } from "../thread-catalog.js";
import { DshExecutionAuthority } from "../dsh-execution-authority.js";

/** Only lifecycle metadata crosses the daemon boundary, never records or connections. */
export interface LocalAgentStorageSummary {
  readonly name: "session-routing" | "threads" | "executions" | "host-documents" | "managed-connectors" | "tasks";
  readonly status: DatabaseOutcome["status"];
  readonly appliedVersion: number;
  readonly backupPath?: string;
  readonly movedAside: boolean;
}

export function openLocalAgentStorage(options: { readonly dataDirectory?: string } = {}) {
  const summaries: LocalAgentStorageSummary[] = [];
  const disposers: (() => void)[] = [];
  const outcomes: { name: LocalAgentStorageSummary["name"]; outcome: DatabaseOutcome }[] = [];
  const close = () => {
    let failure: unknown;
    for (const dispose of [...disposers].reverse()) { try { dispose(); } catch (error) { failure ??= error; } }
    if (failure !== undefined) throw failure;
  };
  const open = <T extends { close(): void }>(name: LocalAgentStorageSummary["name"], factory: (path: string) => T, outcome: (store: T) => DatabaseOutcome): T => {
    try {
      const store = factory(options.dataDirectory ? resolve(options.dataDirectory, name === "tasks" ? "tasks.sqlite" : `opencraft-${name}.sqlite`) : ":memory:");
      // Services such as ThreadLifecycle also close their store. Share one idempotent release.
      const release = store.close.bind(store);
      let closed = false;
      store.close = () => { if (closed) return; closed = true; release(); };
      disposers.push(() => store.close());
      const result = outcome(store);
      outcomes.push({ name, outcome: result });
      summaries.push({ name, status: result.status, appliedVersion: result.appliedVersion,
        ...(result.backupPath === undefined ? {} : { backupPath: result.backupPath }), movedAside: result.movedAsidePaths.length > 0 });
      return store;
    } catch (error) {
      try { close(); } catch { /* Preserve the opening failure after releasing every handle. */ }
      const message = `Host storage ${name} failed${error instanceof SqliteLifecycleError ? ` (${error.kind})` : ""}`;
      if (error instanceof SqliteLifecycleError) throw new SqliteLifecycleError(error.kind, message, error);
      throw new Error(message, { cause: error });
    }
  };
  const routing = open("session-routing", path => new DshSessionRouting(path), store => store.outcome);
  const threads = open("threads", path => new ThreadCatalog(path), store => store.outcome);
  const executions = open("executions", path => new DshExecutionAuthority(path), store => store.outcome);
  const documents = open("host-documents", path => new SqliteDocumentStore(path), store => store.outcome);
  const connectors = open("managed-connectors", path => new ManagedConnectorService(path), store => store.database.outcome);
  const tasks = options.dataDirectory ? open("tasks", path => new TasksSqliteStore(path), store => store.outcome) : undefined;
  return { tasks, routing, threads, executions, documents, connectors, summaries, outcomes, close };
}

export type LocalAgentStorage = ReturnType<typeof openLocalAgentStorage>;
