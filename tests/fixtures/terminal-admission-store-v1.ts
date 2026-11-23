/** The terminal admission journal reader as released before journal v2, kept
 * verbatim (only its import path changed) so rollback tests run the real old
 * owner logic against journals the current owner writes. Do not modify. */
import { constants } from "node:fs";
import { open, rename, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TERMINAL_RESOURCE_LIMITS as limits } from "@opencraft/appserver-protocol";
import { TerminalCapacityError } from "../../apps/local-agent-host/src/process-identity.js";
interface Reservation {
  token: string;
  kind: "local" | "remote";
  quotaOwner: string;
  resource: string;
  operation: string;
}
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 1024 && !/[\x00-\x1f\x7f]/u.test(v);
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
      if (
        Buffer.byteLength(raw) > 1048576 ||
        value?.version !== 1 ||
        Object.keys(value).some((k) => !["version", "reservations"].includes(k)) ||
        !Array.isArray(value.reservations) ||
        value.reservations.length > limits.activePerHost ||
        value.reservations.some(
          (r: Reservation) =>
            !r ||
            Object.keys(r).some((k) => !["token", "kind", "quotaOwner", "resource", "operation"].includes(k)) ||
            !text(r.quotaOwner) ||
            !text(r.resource) ||
            !text(r.operation) ||
            !["local", "remote"].includes(r.kind) ||
            typeof r.token !== "string" ||
            !/^[a-f0-9]{64}$/u.test(r.token),
        ) ||
        new Set(value.reservations.map((r: Reservation) => r.token)).size !== value.reservations.length
      )
        throw Error("Invalid terminal admission journal");
      store.reservations = value.reservations;
    } finally {
      await file.close();
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
      await file.writeFile(JSON.stringify({ version: 1, reservations: rows }));
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
  reserve(kind: Reservation["kind"], quotaOwner: string, resource: string, operation: string) {
    if (!["local", "remote"].includes(kind) || ![quotaOwner, resource, operation].every(text))
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
      return { rows: [...rows, { token, kind, quotaOwner, resource, operation }], result: token };
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
