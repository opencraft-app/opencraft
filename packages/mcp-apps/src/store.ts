// Runtime-neutral MCP app definitions over the SQL port: no node:* imports, so
// the same store runs on node:sqlite (`./node`, opened by `openManagedDatabase`)
// and on Durable Object SQL. See docs/architecture/platform/storage-ports.md.
import type { SqlDatabase } from "@opencraft/sql";
import type { AppSpec } from "./spec";
export const appSchema = `
CREATE TABLE apps(owner TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,active INTEGER,next INTEGER NOT NULL,draft TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,id)) STRICT;
CREATE TABLE releases(owner TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,uri TEXT NOT NULL,spec TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(owner,id,revision),FOREIGN KEY(owner,id) REFERENCES apps(owner,id) ON DELETE CASCADE) STRICT;
`;
export const appMigrations = [
  { version: 1, name: "owned-app-definitions-and-releases", sql: appSchema },
];
export interface AppRow {
  owner: string;
  id: string;
  version: number;
  active: number | null;
  next: number;
  draft: string;
  deleted: number;
}
export interface Release {
  owner: string;
  id: string;
  revision: number;
  uri: string;
  spec: string;
  created: number;
}
/** A migrated app database lent by the owner that opened it, with the owner's outcome report. */
export interface AppStorage<Outcome = unknown> {
  readonly database: SqlDatabase;
  readonly outcome: Outcome;
  close(): void;
}
export interface AppStoreOptions {
  /** Lowercase hex SHA-256 of a UTF-8 string, from the owner's runtime. */
  readonly sha256Hex: (text: string) => string;
}
export class AppStore<Outcome = unknown> {
  readonly database: SqlDatabase;
  readonly outcome: Outcome;
  private readonly sha256Hex: (text: string) => string;
  constructor(
    private readonly storage: AppStorage<Outcome>,
    options: AppStoreOptions,
  ) {
    this.database = storage.database;
    this.outcome = storage.outcome;
    this.sha256Hex = options.sha256Hex;
    this.database.exec("PRAGMA foreign_keys=ON");
  }
  close() {
    this.storage.close();
  }
  list(owner: string, offset: number, limit: number) {
    const rows = this.database
      .prepare(
        "SELECT id AS appId,version,active AS activeRevision,json_extract(draft,'$.title') AS title,substr(json_extract(draft,'$.description'),1,240) AS description FROM apps WHERE owner=? AND deleted=0 ORDER BY id LIMIT ? OFFSET ?",
      )
      .all(owner, limit + 1, offset);
    return {
      apps: rows.slice(0, limit),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }
  get(owner: string, id: string): AppRow | null {
    return (
      (this.database
        .prepare("SELECT * FROM apps WHERE owner=? AND id=?")
        .get(owner, id) as unknown as AppRow) ?? null
    );
  }
  revisions(owner: string, id: string) {
    return this.database
      .prepare(
        "SELECT revision,uri,created FROM releases WHERE owner=? AND id=? ORDER BY revision DESC LIMIT 64",
      )
      .all(owner, id);
  }
  release(owner: string, id: string, revision: number): Release | null {
    return (
      (this.database
        .prepare("SELECT * FROM releases WHERE owner=? AND id=? AND revision=?")
        .get(owner, id, revision) as unknown as Release) ?? null
    );
  }
  /** Exact immutable URI lookup, usable only after connection-local history authorization. */
  referencedRelease(uri: string, id: string, revision: number): Release | null {
    return (this.database.prepare("SELECT * FROM releases WHERE uri=? AND id=? AND revision=? LIMIT 1")
      .get(uri, id, revision) as unknown as Release) ?? null;
  }
  mutate(
    owner: string,
    id: string,
    expected: number,
    action: string,
    spec?: AppSpec,
    revision?: number,
  ) {
    return this.database.transaction(() => {
      const old = this.get(owner, id);
      if ((old?.version ?? 0) !== expected)
        throw new Error(
          "App changed; get latest version and reconcile before writing",
        );
      if (
        (!old || old.deleted) &&
        action !== "saveDraft" &&
        action !== "publish"
      )
        throw new Error("App not found");
      if (
        (!old || old.deleted) &&
        (this.database
          .prepare("SELECT count(*) AS n FROM apps WHERE owner=? AND deleted=0")
          .get(owner)!.n as number) >= 64
      )
        throw new Error("App limit reached (64 per owner)");
      if (
        !old &&
        Number(
          this.database
            .prepare("SELECT count(*) AS n FROM apps WHERE owner=?")
            .get(owner)!.n,
        ) >= 256
      )
        throw new Error(
          "App identity limit reached (256 per owner including retired IDs)",
        );
      if (action === "delete") {
        this.database
          .prepare("DELETE FROM releases WHERE owner=? AND id=?")
          .run(owner, id);
        this.database
          .prepare(
            "UPDATE apps SET version=version+1,active=NULL,draft='null',deleted=1 WHERE owner=? AND id=?",
          )
          .run(owner, id);
      } else {
        const version = expected + 1;
        let active = old?.active ?? null,
          next = old?.next ?? 1;
        if (action === "publish") {
          if (next > 64) throw new Error("Release limit reached (64 per app)");
          active = next;
          next++;
        } else if (action === "unpublish") active = null;
        else if (action === "rollback") {
          if (!this.release(owner, id, revision!))
            throw new Error("Release not found");
          active = revision!;
        }
        const draft = spec ? JSON.stringify(spec) : old!.draft;
        this.database
          .prepare(
            "INSERT INTO apps VALUES(?,?,?,?,?,?,0) ON CONFLICT(owner,id) DO UPDATE SET version=excluded.version,active=excluded.active,next=excluded.next,draft=excluded.draft,deleted=0",
          )
          .run(owner, id, version, active, next, draft);
        if (action === "publish") {
          const digest = this.sha256Hex(spec!.uiHtml);
          const actor = this.sha256Hex(owner);
          const uri = `ui://opencraft/apps/${actor}/${id}/sha256-${digest}.html`;
          this.database
            .prepare("INSERT INTO releases VALUES(?,?,?,?,?,?)")
            .run(owner, id, active, uri, draft, Date.now());
        }
      }
      const size = this.database
        .prepare(
          "SELECT (SELECT coalesce(sum(length(CAST(draft AS BLOB))),0) FROM apps WHERE owner=?) + (SELECT coalesce(sum(length(CAST(spec AS BLOB))),0) FROM releases WHERE owner=?) AS n",
        )
        .get(owner, owner)!.n;
      if (Number(size) > 16 * 1024 * 1024)
        throw new Error(
          "App definition storage limit reached (16 MiB per owner)",
        );
      return this.get(owner, id);
    });
  }
}
