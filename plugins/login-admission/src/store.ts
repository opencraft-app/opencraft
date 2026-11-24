// Worker-only module: it owns the SQLite connection. The network thread
// reaches it through `login-admission.worker.ts` and never imports this file.
// The rows themselves are kept by the runtime-neutral `SqlLoginAdmissionStore`.
import { nodeSqlDatabase, openManagedDatabase, type DatabaseOutcome } from "@opencraft/sqlite-node";
import type { ServedOwner } from "@opencraft/worker-owner/serve";
import { LOGIN_ADMISSION_MIGRATIONS } from "./migrations";
import { SqlLoginAdmissionStore } from "./sql-store";
import type { LoginAdmissionStoreData, StoredIdentity } from "./store-protocol";

/** Node owner of `login-admission.sqlite`: managed lifecycle (ledger, backups, recovery) around the neutral store. */
export class LoginAdmissionStore extends SqlLoginAdmissionStore {
  readonly outcome: DatabaseOutcome;
  readonly #close: () => void;
  constructor(path: string) {
    const managed = openManagedDatabase({ schemaId: "login-admission", path, migrations: LOGIN_ADMISSION_MIGRATIONS });
    super(nodeSqlDatabase(managed.database));
    this.outcome = managed.outcome;
    this.#close = () => managed.database.close();
  }
  close(): void {
    this.#close();
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
