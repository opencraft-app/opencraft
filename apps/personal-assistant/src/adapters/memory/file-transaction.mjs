import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { stable } from "../../domain/values.mjs";

/** Recoverable local file participant; SQL receipt decides rollback versus roll-forward. */
export class MemoryFileTransaction {
  constructor(
    store,
    { committed, markCommit, forgetCommit, fault = () => {} },
  ) {
    Object.assign(this, { store, committed, markCommit, forgetCommit, fault });
    this.lock = join(store.root, ".write-lock");
  }
  /**
   * The lock directory appears with its owner already inside: the owner is
   * written into a private directory that is then renamed into place, so a
   * process killed while claiming never leaves a lock without an owner.
   */
  claim() {
    const staged = `${this.lock}.${process.pid}.${randomUUID()}`;
    mkdirSync(staged, { mode: 0o700 });
    try {
      const token = randomUUID();
      writeFileSync(join(staged, "owner.json"), stable({ pid: process.pid, token }), {
        mode: 0o600,
      });
      renameSync(staged, this.lock);
      this.token = token;
    } catch (error) {
      rmSync(staged, { recursive: true, force: true });
      // Renaming onto an existing lock directory reports it as taken.
      if (error.code === "ENOTEMPTY" || error.code === "EEXIST" || error.code === "EPERM")
        throw Object.assign(new Error("Memory root lock is held"), { code: "EEXIST" });
      throw error;
    }
    this.held = true;
    this.sweepStaged();
  }
  /** Staging directories of claimers that died before renaming theirs into place. */
  sweepStaged() {
    const prefix = `${basename(this.lock)}.`;
    for (const name of readdirSync(dirname(this.lock))) {
      if (!name.startsWith(prefix)) continue;
      const pid = Number(name.slice(prefix.length).split(".")[0]);
      if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) continue;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH")
          rmSync(join(dirname(this.lock), name), { recursive: true, force: true });
      }
    }
  }
  acquire() {
    const until = Date.now() + 250;
    while (Date.now() <= until) {
      try {
        this.claim();
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let owner;
        try {
          owner = JSON.parse(
            readFileSync(join(this.lock, "owner.json"), "utf8"),
          );
        } catch {
          if (Date.now() < until) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
            continue;
          }
          throw new Error(
            "Memory root lock has incomplete metadata; recovery required",
          );
        }
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1)
          throw new Error("Invalid memory lock owner");
        try {
          process.kill(owner.pid, 0);
        } catch (e) {
          if (e.code === "ESRCH") {
            this.removeDeadLock(owner.pid);
            // Cleanup can consume the wait budget. Once the known-dead lock is
            // gone, try to claim the now-available root before checking time.
            try {
              this.claim();
              return;
            } catch (race) {
              if (race.code !== "EEXIST") throw race;
            }
            continue;
          }
          throw e;
        }
        if (owner.pid === process.pid) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    const error = new Error("Memory root is busy");
    error.code = "MEMORY_BUSY";
    throw error;
  }
  /**
   * A lock is only ever removed after it was renamed away from the lock path.
   * Emptying it in place would let another claimer rename its own lock onto
   * the empty directory (rename replaces an empty directory) and then lose it
   * to this removal. The private name carries this process's pid, so a crash
   * before the removal is swept like a dead claimer's staging directory.
   */
  setAside() {
    const aside = `${this.lock}.${process.pid}.${randomUUID()}`;
    renameSync(this.lock, aside);
    return aside;
  }
  ownerOf(directory) {
    try {
      return JSON.parse(readFileSync(join(directory, "owner.json"), "utf8"));
    } catch {
      return null;
    }
  }
  /** Removes a lock whose owner is dead, unless another claimer replaced it meanwhile. */
  removeDeadLock(pid) {
    let aside;
    try {
      aside = this.setAside();
    } catch (race) {
      if (race.code === "ENOENT") return; // another process already removed it
      throw race;
    }
    if (this.ownerOf(aside)?.pid === pid) {
      rmSync(aside, { recursive: true, force: true });
      return;
    }
    // A live claimer's lock was moved: put it back. Should yet another claimer
    // take the path first, the moved owner finds that out when it releases.
    try {
      renameSync(aside, this.lock);
    } catch {}
  }
  release() {
    if (!this.held) return;
    const aside = this.setAside();
    this.held = false;
    if (this.ownerOf(aside)?.token !== this.token) {
      // Another owner's lock: this one was taken over while held. Hand it back.
      try {
        renameSync(aside, this.lock);
      } catch {}
      throw new Error("Memory root lock was taken over while held");
    }
    rmSync(aside, { recursive: true, force: true });
  }
  readJournal() {
    const text = this.store.read(
      ".transactions/pending.json",
      false,
      64 * 1024 * 1024,
    );
    if (text === null) return null;
    const j = JSON.parse(text);
    if (
      j.root !== this.store.root ||
      j.owner !== this.store.owner ||
      typeof j.id !== "string" ||
      typeof j.agentId !== "string" ||
      typeof j.profile !== "string" ||
      !Array.isArray(j.changes) ||
      j.changes.length > 10000
    )
      throw new Error("Invalid memory recovery journal");
    for (const c of j.changes) {
      this.store.safe(c.path);
      if (
        !(this.store.botLayout
          ? /^memory\/(profile\.md|log\/[^/]+\.md|\.dreaming\/.+)$/.test(c.path)
          : /^(agents|user-memory|projects)\//.test(c.path)) ||
        ![c.before, c.after].every((v) => v === null || typeof v === "string")
      )
        throw new Error("Invalid memory recovery file");
    }
    return j;
  }
  restore(j, forward) {
    // Validate every path before changing any. Unexpected edits are never overwritten.
    for (const c of j.changes) {
      const actual = this.store.read(c.path, false);
      if (actual !== c.before && actual !== c.after)
        throw new Error(
          `Memory recovery conflicts with external edit: ${c.path}`,
        );
    }
    for (const c of j.changes) {
      const target = forward ? c.after : c.before;
      if (this.store.read(c.path, false) !== target)
        this.store.atomic(c.path, target);
    }
  }
  recover() {
    const j = this.readJournal();
    if (!j) return;
    this.restore(j, this.committed(j));
    this.store.atomic(".transactions/pending.json", null);
    this.forgetCommit(j);
  }
  prepare() {
    const changes = [...this.store.staged]
      .map(([path, after]) => ({
        path,
        after,
        before: this.store.read(path, false),
      }))
      .filter((c) => c.before !== c.after)
      .sort((a, b) => a.path.localeCompare(b.path));
    if (!changes.length) return;
    const j = {
      id: randomUUID(),
      root: this.store.root,
      owner: this.store.owner,
      agentId: this.store.agentId,
      profile: this.store.profile.path,
      changes,
    };
    this.store.atomic(".transactions/pending.json", stable(j) + "\n");
    this.journal = j;
    this.markCommit(j.id);
    for (const c of changes) {
      if (this.store.read(c.path, false) !== c.before)
        throw new Error("Memory file changed before replacement");
      this.store.atomic(c.path, c.after);
    }
    this.fault("memory-files-before-sql-commit");
  }
  committedCleanup() {
    if (!this.journal) return;
    this.fault("memory-files-after-sql-commit");
    this.store.atomic(".transactions/pending.json", null);
    this.forgetCommit(this.journal);
    this.journal = null;
  }
  rollback(committed = false) {
    try {
      if (this.journal) {
        this.restore(this.journal, committed);
        this.store.atomic(".transactions/pending.json", null);
        this.journal = null;
      }
    } finally {
      this.store.staged.clear();
      this.release();
    }
  }
}
