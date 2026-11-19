import { initializeMemoryBm25 } from "./memory-bm25.mjs";
import { digest, stable } from "../../domain/values.mjs";
/** Rebuildable file projection and commit receipts, never a fallback fact source. */
export class SqliteMemoryIndex {
  constructor(uow) {
    this.db = uow.db;
    initializeMemoryBm25(this.db);
  }
  state() {
    return this.db.prepare("SELECT * FROM memory_file_state WHERE id=1").get();
  }
  rows() {
    return this.db
      .prepare(
        `SELECT m.*,coalesce(d.scope,'user') AS scope,d.project_id AS projectId,coalesce(d.kind,'profile') AS kind,coalesce(d.updated_at,0) AS updatedAt,p.origin,p.evidence_json AS evidenceJson,s.agent_id AS agentId,s.agent_name AS agentName,s.content_id AS contentId,s.path FROM memory m LEFT JOIN memory_detail d ON d.key=m.key LEFT JOIN memory_provenance p ON p.key=m.key LEFT JOIN memory_shard s ON s.key=m.key ORDER BY m.key`,
      )
      .all()
      .map(({ evidenceJson, ...m }) => ({
        ...m,
        evidenceIds: evidenceJson ? JSON.parse(evidenceJson) : [],
      }));
  }
  tombstones() {
    return this.db.prepare("SELECT * FROM memory_tombstone ORDER BY id").all();
  }
  refreshes() {
    return this.db.prepare("SELECT * FROM memory_refresh ORDER BY scope").all();
  }
  hash() {
    return digest({
      rows: this.rows(),
      tombstones: this.tombstones(),
      refreshes: this.refreshes(),
    });
  }
  replace({ rows, tombstones, refreshes }) {
    this.db.exec(
      "DELETE FROM memory_shard; DELETE FROM memory_detail; DELETE FROM memory_provenance; DELETE FROM memory; DELETE FROM memory_tombstone; DELETE FROM memory_refresh;",
    );
    const m = this.db.prepare("INSERT INTO memory VALUES(?,?,?,?,?)"),
      d = this.db.prepare("INSERT INTO memory_detail VALUES(?,?,?,?,?)"),
      p = this.db.prepare("INSERT INTO memory_provenance VALUES(?,?,?,?)"),
      s = this.db.prepare("INSERT INTO memory_shard VALUES(?,?,?,?,?)");
    for (const r of rows) {
      m.run(r.key, r.deleted ? "" : r.value, r.revision, r.input_id, r.deleted ? 1 : 0);
      d.run(r.key, r.scope, r.projectId, r.kind, r.updatedAt);
      if (r.origin) p.run(r.key, r.revision, r.origin, stable(r.evidenceIds ?? []));
      s.run(r.key, r.agentId, r.agentName ?? r.agentId, r.contentId ?? null, r.path ?? null);
    }
    const t = this.db.prepare("INSERT INTO memory_tombstone VALUES(?,?,?,?,?)");
    for (const r of tombstones) t.run(r.id, r.scope, r.project_id, "", r.created_at ?? 0);
    const f = this.db.prepare("INSERT INTO memory_refresh VALUES(?,?)");
    for (const r of refreshes) f.run(r.scope, r.next_at);
  }
  grantsHash() {
    return this.db.prepare("SELECT value FROM meta WHERE key='memory_file_grants'").get()?.value ?? null;
  }
  saveState(root, agentId, fingerprint, grantsHash) {
    this.db
      .prepare(
        "INSERT INTO memory_file_state VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET root=excluded.root,agent_id=excluded.agent_id,fingerprint=excluded.fingerprint,cache_hash=excluded.cache_hash",
      )
      .run(root, agentId, fingerprint, this.hash());
    this.db
      .prepare("INSERT INTO meta VALUES('memory_file_grants',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(grantsHash);
  }

  committed(id) {
    return !!this.db.prepare("SELECT 1 FROM memory_file_commit WHERE id=?").get(id);
  }
  markCommit(id) {
    this.db.prepare("INSERT INTO memory_file_commit VALUES(?)").run(id);
  }
  forgetCommit(id) {
    this.db.prepare("DELETE FROM memory_file_commit WHERE id=?").run(id);
  }
}

export function memoryFileCommitReceipt(Database, profile, { id, agentId, owner, root }) {
  const db = new Database(`${profile}/assistant.sqlite`, { readOnly: true });
  try {
    const identity = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='identity'").get()?.value ?? "null");
    const state = db.prepare("SELECT root,agent_id FROM memory_file_state WHERE id=1").get();
    if (
      identity?.assistantId !== agentId ||
      identity?.owner !== owner ||
      (state && (state.root !== root || state.agent_id !== agentId))
    )
      throw new Error("Recovery database identity does not match the memory writer");
    if (!state) return false;
    return !!db.prepare("SELECT 1 FROM memory_file_commit WHERE id=?").get(id);
  } finally {
    db.close();
  }
}
