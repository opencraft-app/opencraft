import {
  writeFileSync,
  existsSync,
  readFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { stable, digest } from "../../domain/values.mjs";
import { MemoryFileStore } from "./file-store.mjs";
import { MemoryFileTransaction } from "./file-transaction.mjs";

/** Files own facts. The local UoW only coordinates the reconstructable index and business receipts. */
export class MemoryFileAuthority {
  constructor(profile, uow, index, { committed, fault = () => {}, onExternalChange = () => {} } = {}) {
    Object.assign(this, { profile, uow, index, onExternalChange });
    this.store = new MemoryFileStore(profile);
    this.snapshots = [];
    this.files = new MemoryFileTransaction(this.store, {
      committed: (j) => (j.profile === profile.path ? index.committed(j.id) : committed(j)),
      markCommit: (id) => index.markCommit(id),
      forgetCommit: (j) => {
        if (j.profile === profile.path) index.forgetCommit(j.id);
      },
      fault,
    });
    this.files.acquire();
    try {
      this.store.initialize();
    } finally {
      this.files.release();
    }
  }
  enter(depth) {
    if (depth) {
      this.snapshots.push(new Map(this.store.staged));
      return;
    }
    this.files.acquire();
    try {
      this.files.recover();
      this.store.staged.clear();
      this.needsExport = false;
      const state = this.index.state(),
        scan = this.store.scan();
      this.before = scan;
      this.grantsHash = digest(this.store.resources());
      this.needIndexState = !state || state.fingerprint !== scan.fingerprint || state.cache_hash !== this.index.hash();
      if (state && (state.root !== this.store.root || state.agent_id !== this.store.agentId))
        throw new Error("Memory root/agent binding changed; migrate explicitly");
      if (!state) {
        const rows = this.index.rows(),
          tombstones = this.index.tombstones(),
          refreshes = this.index.refreshes();
        if (rows.length) {
          const backup = join(this.profile.path, "memory-migration-schema14.json");
          if (!existsSync(backup)) {
            const temp = `${backup}.tmp-${crypto.randomUUID()}`;
            try {
              writeFileSync(temp, stable({ rows, tombstones, refreshes }) + "\n", { flag: "wx", mode: 0o600 });
              const fd = openSync(temp, "r");
              try {
                fsyncSync(fd);
              } finally {
                closeSync(fd);
              }
              renameSync(temp, backup);
            } finally {
              try {
                unlinkSync(temp);
              } catch (error) {
                if (error.code !== "ENOENT") throw error;
              }
            }
          } else JSON.parse(readFileSync(backup, "utf8"));
        }
        const own = scan.rows.some((r) => r.agentId === this.store.agentId);
        this.needsExport = rows.length > 0 && !own;
        this.index.replace({
          rows: own
            ? scan.rows
            : [
                ...scan.rows,
                ...rows.map((r) => ({
                  ...r,
                  agentId: this.store.agentId,
                  agentName: this.profile.config.assistantName ?? this.store.agentId,
                })),
              ],
          tombstones: own ? scan.tombstones : [...scan.tombstones, ...tombstones],
          refreshes: own ? scan.refreshes : [...scan.refreshes, ...refreshes],
        });
      } else if (state.fingerprint !== scan.fingerprint || state.cache_hash !== this.index.hash()) {
        const previous = this.index.rows(),
          keys = new Set([...previous.map((r) => r.key), ...scan.rows.map((r) => r.key)]);
        const factShape = (r) => r && [r.value, r.deleted, r.origin, r.scope, r.projectId, r.kind, r.revision];
        const changed = [...keys]
          .map((key) => [previous.find((r) => r.key === key), scan.rows.find((r) => r.key === key)])
          .filter(([a, b]) => stable(factShape(a)) !== stable(factShape(b)));
        const fence =
          this.index.grantsHash() !== this.grantsHash ||
          changed.some(
            ([a, b]) =>
              (a ?? b).agentId === this.store.agentId || [a, b].filter(Boolean).some((r) => r.origin !== "automatic"),
          );
        this.index.replace(scan);
        this.onExternalChange(fence);
      }
      this.cacheBefore = this.index.hash();
    } catch (error) {
      this.store.staged.clear();
      this.files.release();
      throw error;
    }
  }
  diskScan() {
    const staged = this.store.staged;
    this.store.staged = new Map();
    try {
      return this.store.scan();
    } finally {
      this.store.staged = staged;
    }
  }
  prepare() {
    if (this.diskScan().fingerprint !== this.before.fingerprint)
      throw new Error("Memory files changed during the transaction");
    if (!this.needsExport && !this.store.staged.size && this.index.hash() === this.cacheBefore) {
      if (this.needIndexState)
        this.index.saveState(this.store.root, this.store.agentId, this.before.fingerprint, this.grantsHash);
      return;
    }
    const after = this.index.rows();
    for (const row of after.filter((r) => r.agentId && r.agentId !== this.store.agentId)) {
      const previous = this.before.rows.find((r) => r.key === row.key);
      if (stable(row) !== stable(previous)) throw new Error("Cannot write another assistant memory shard");
    }
    this.store.stageRecords(this.before.rows, after, this.index.tombstones(), this.index.refreshes());
    this.files.prepare();
    const scan = this.store.scan();
    this.index.replace(scan);
    this.index.saveState(this.store.root, this.store.agentId, scan.fingerprint, digest(this.store.resources()));
  }
  commit(depth) {
    if (depth) {
      this.snapshots.pop();
      return;
    }
    try {
      this.files.committedCleanup();
      this.store.staged.clear();
    } finally {
      this.files.release();
    }
  }
  rollback(depth, committed) {
    if (depth) {
      this.store.staged = this.snapshots.pop() ?? new Map();
      return;
    }
    this.files.rollback(committed);
  }
  synchronize() {
    if (!this.uow.depth) this.uow.transaction(() => {});
  }
  browserFiles() {
    this.synchronize();
    const directory = this.store.shard("agent"),
      images = new Map(
        [...this.store.scan().images].filter(
          ([path]) => path.startsWith(directory + "/") && /\/(profile\.md|log\/\d{4}-\d{2}\.md)$/.test(path),
        ),
      );
    return { directory, images };
  }
  resources() {
    return this.store.resources();
  }
  projects() {
    this.synchronize();
    return this.store.projects();
  }
  project(action, params) {
    if (!this.uow.depth) throw new Error("Project changes require the business transaction");
    return this.store.stageProject(action, params);
  }
  locations() {
    return this.store.locations();
  }
  read({ scope, projectId = null, agentId = this.store.agentId, path = "profile.md", offset = 0, limit = 2000 }) {
    if (!["agent", "user", "project"].includes(scope) || !/^(profile\.md|log\/\d{4}-\d{2}\.md)$/.test(path))
      throw new Error("Only memory profile/log files can be read");
    if (scope === "agent" && agentId !== this.store.agentId) throw new Error("Private agent memory is not shared");
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 8000
    )
      throw new Error("Memory file read exceeds its bound");
    const relative = `${this.store.shard(scope, projectId, agentId)}/${path}`,
      text = this.store.read(relative);
    return {
      path: relative,
      scope,
      projectId,
      agentId,
      version: digest(text ?? ""),
      content: (text ?? "").slice(offset, offset + limit),
      exists: text !== null,
      nextOffset: text && offset + limit < text.length ? offset + limit : null,
    };
  }
}
