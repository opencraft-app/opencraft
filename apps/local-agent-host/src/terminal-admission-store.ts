import { constants } from "node:fs";
import { open, rename, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TERMINAL_RESOURCE_LIMITS as limits } from "@opencraft/appserver-protocol";
import { TerminalCapacityError } from "./process-identity.js";
/** The Actor epoch and owner incarnation a local reservation was admitted
 * under for delivered ENV (journal v2). Present only while the reservation is
 * held and nothing has been launched for it: launching removes it durably
 * before spawn, so a row carrying it is positive proof that no process exists. */
export interface TerminalLaunchAdmission {
  account: string;
  actorGeneration: number;
  membershipRevision: number;
  hostId: "local-codex" | "opencraft-server";
  threadId: string | null;
  incarnation: string;
}
interface Reservation {
  token: string;
  kind: "local" | "remote";
  quotaOwner: string;
  resource: string;
  operation: string;
  launch?: TerminalLaunchAdmission;
}
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 1024 && !/[\x00-\x1f\x7f]/u.test(v);
const LAUNCH_KEYS = ["account", "actorGeneration", "membershipRevision", "hostId", "threadId", "incarnation"];
/** Exact v2 launch admission; the incarnation is the local reservation's resource. */
function launchAdmission(value: unknown, resource: string): TerminalLaunchAdmission | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== LAUNCH_KEYS.length ||
    !LAUNCH_KEYS.every((k) => Object.hasOwn(v, k)) ||
    !text(v.account) ||
    !/^actor:human:\/\/[^/]+\/[^/]+$/u.test(v.account) ||
    !Number.isSafeInteger(v.actorGeneration) ||
    (v.actorGeneration as number) <= 0 ||
    !Number.isSafeInteger(v.membershipRevision) ||
    (v.membershipRevision as number) < 0 ||
    (v.hostId !== "local-codex" && v.hostId !== "opencraft-server") ||
    !(v.threadId === null || text(v.threadId)) ||
    v.incarnation !== resource
  )
    return null;
  return {
    account: v.account,
    actorGeneration: v.actorGeneration as number,
    membershipRevision: v.membershipRevision as number,
    hostId: v.hostId,
    threadId: v.threadId as string | null,
    incarnation: v.incarnation as string,
  };
}
/** Journal v1 is written whenever no reservation is held for a launch, byte for
 * byte as before, so an owner without v2 support can still open it. v2 exists
 * only while a launch admission is held; such an owner refuses it and does not
 * start (it never drops a reservation it cannot read). */
const journalVersion = (rows: readonly Reservation[]) => (rows.some((r) => r.launch) ? 2 : 1);
const nonce = () => randomBytes(32).toString("hex");
/** Single writer is the existing independent Hands PTY owner, under its existing
 * directory lock. All filesystem IO is asynchronous. Unknown reservations are
 * retained across owner restart; neither disconnect nor absence proves exit. */
export class TerminalAdmissionStore {
  private reservations: Reservation[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;
  private sealed = false;
  private constructor(
    private readonly directory: string,
    private readonly path: string,
  ) {}
  static async open(directory: string) {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid()) ||
      (process.platform !== "win32" && info.mode & 0o077)
    )
      throw Error("Terminal admission directory must be private");
    const store = new TerminalAdmissionStore(directory, join(directory, "terminal-admission.json"));
    let file;
    try {
      file = await open(store.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return store;
    }
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        (process.getuid && stat.uid !== process.getuid()) ||
        (process.platform !== "win32" && stat.mode & 0o077) ||
        stat.size > 1048576
      )
        throw Error("Invalid terminal admission journal");
      const raw = await file.readFile("utf8"),
        value = JSON.parse(raw);
      const version = value?.version;
      if (
        Buffer.byteLength(raw) > 1048576 ||
        (version !== 1 && version !== 2) ||
        Object.keys(value).some((k) => !["version", "reservations"].includes(k)) ||
        !Array.isArray(value.reservations) ||
        value.reservations.length > limits.activePerHost ||
        value.reservations.some(
          (r: Reservation) =>
            !r ||
            Object.keys(r).some(
              (k) =>
                !["token", "kind", "quotaOwner", "resource", "operation", ...(version === 2 ? ["launch"] : [])].includes(
                  k,
                ),
            ) ||
            !text(r.quotaOwner) ||
            !text(r.resource) ||
            !text(r.operation) ||
            !["local", "remote"].includes(r.kind) ||
            typeof r.token !== "string" ||
            !/^[a-f0-9]{64}$/u.test(r.token) ||
            (Object.hasOwn(r, "launch") && (r.kind !== "local" || !launchAdmission(r.launch, r.resource))),
        ) ||
        new Set(value.reservations.map((r: Reservation) => r.token)).size !== value.reservations.length
      )
        throw Error("Invalid terminal admission journal");
      store.reservations = value.reservations;
    } finally {
      await file.close();
    }
    // Every held launch admission belongs to an earlier owner incarnation: this
    // one has not admitted anything yet. Held means nothing was launched, so
    // the reservation is released, and the journal returns to v1 when none remains.
    const held = store.reservations.filter((r) => r.launch);
    if (held.length) {
      const rows = store.reservations.filter((r) => !r.launch);
      await store.persist(rows);
      store.reservations = rows;
    }
    return store;
  }
  private mutate<T>(change: (rows: Reservation[]) => { rows: Reservation[]; result: T }): Promise<T> {
    if (this.sealed) return Promise.reject(Error("Terminal admission closed"));
    const work = this.queue.then(async () => {
      if (this.failed) throw Error("Terminal admission journal fenced");
      const { rows, result } = change(this.reservations);
      if (rows !== this.reservations) {
        try {
          await this.persist(rows);
          this.reservations = rows;
        } catch (error) {
          this.failed = true;
          throw error;
        }
      }
      return result;
    });
    this.queue = work.catch(() => {});
    return work;
  }
  private async persist(rows: Reservation[]) {
    const stage = this.path + ".stage-" + nonce();
    let file;
    try {
      file = await open(stage, "wx", 0o600);
      await file.writeFile(JSON.stringify({ version: journalVersion(rows), reservations: rows }));
      await file.sync();
      await file.close();
      file = undefined;
      await rename(stage, this.path);
      if (process.platform !== "win32") {
        const dir = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
    } finally {
      await file?.close();
      await rm(stage, { force: true });
    }
  }
  /** `launch` holds the reservation for one delivered-ENV launch (local only). */
  reserve(kind: Reservation["kind"], quotaOwner: string, resource: string, operation: string, launch?: unknown) {
    const admitted = launch === undefined ? undefined : launchAdmission(launch, resource);
    if (
      !["local", "remote"].includes(kind) ||
      ![quotaOwner, resource, operation].every(text) ||
      admitted === null ||
      (admitted && kind !== "local")
    )
      return Promise.reject(Error("Invalid terminal admission"));
    return this.mutate((rows) => {
      if (
        rows.length >= limits.activePerHost ||
        rows.filter((r) => r.quotaOwner === quotaOwner).length >= limits.activePerAccountHost
      )
        throw new TerminalCapacityError();
      if (rows.some((r) => r.kind === kind && r.resource === resource && r.operation === operation))
        throw Error("Terminal operation already reserved; do not replay");
      const token = nonce();
      const row: Reservation = { token, kind, quotaOwner, resource, operation };
      if (admitted) row.launch = admitted;
      return { rows: [...rows, row], result: token };
    });
  }
  /** Committed state: the launch admission of a held local reservation, or null. */
  held(resource: string, operation: string): Promise<{ quotaOwner: string; launch: TerminalLaunchAdmission } | null> {
    if (![resource, operation].every(text)) return Promise.reject(Error("Invalid terminal admission"));
    return this.queue.then(() => {
      if (this.failed || this.sealed) throw Error("Terminal admission unavailable");
      const row = this.reservations.find(
        (r) => r.kind === "local" && r.resource === resource && r.operation === operation && r.launch,
      );
      return row ? { quotaOwner: row.quotaOwner, launch: { ...row.launch! } } : null;
    });
  }
  /** The one-shot fence: removes the launch admission durably and returns the
   * receipt. Refused unless the reservation is held, for this quota owner. */
  launch(resource: string, operation: string, quotaOwner: string) {
    if (![resource, operation, quotaOwner].every(text)) return Promise.reject(Error("Invalid terminal admission"));
    return this.mutate((rows) => {
      const row = rows.find(
        (r) => r.kind === "local" && r.resource === resource && r.operation === operation && r.launch,
      );
      if (!row || row.quotaOwner !== quotaOwner) throw Error("Terminal launch not admissible");
      const { launch: _, ...launched } = row;
      return { rows: rows.map((r) => (r === row ? launched : r)), result: row.token };
    });
  }
  /** Releases a reservation only while it is still held (nothing launched). */
  abandon(resource: string, operation: string) {
    if (![resource, operation].every(text)) return Promise.reject(Error("Invalid terminal admission"));
    return this.mutate((rows) => {
      const next = rows.filter(
        (r) => !(r.kind === "local" && r.resource === resource && r.operation === operation && r.launch),
      );
      return { rows: next.length === rows.length ? rows : next, result: next.length !== rows.length };
    });
  }
  release(token: string) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token))
      return Promise.reject(Error("Invalid terminal receipt"));
    return this.mutate((rows) => ({
      rows: rows.some((r) => r.token === token) ? rows.filter((r) => r.token !== token) : rows,
      result: undefined,
    }));
  }
  destroyRemoteResource(quotaOwner: string, resource: string) {
    if (!text(quotaOwner) || !text(resource)) return Promise.reject(Error("Invalid terminal resource receipt"));
    return this.mutate((rows) => {
      const next = rows.filter((r) => r.kind !== "remote" || r.quotaOwner !== quotaOwner || r.resource !== resource);
      return { rows: next.length === rows.length ? rows : next, result: undefined };
    });
  }
  probe() {
    return this.queue.then(() => {
      if (this.failed || this.sealed) throw Error("Terminal admission unavailable");
    });
  }
  close() {
    this.sealed = true;
    return this.queue.then(() => {
      if (this.failed) throw Error("Terminal admission journal cleanup unconfirmed");
    });
  }
}
