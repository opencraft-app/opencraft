import { posix } from "node:path";
import type { SandboxEnvironment, SandboxProcess } from "@opencraft/sandbox";
import { workspaceFileHelper } from "./sandbox-workspace-files-helper.js";

const methods = new Set(["fs/readDirectory", "fs/getMetadata", "fs/readFile", "fs/writeFile", "fs/createDirectory"]);
/** Host-owned file port for one already-authorized execution binding. Never
 * chooses/allocates a sandbox, reads Host paths or forwards unsupported methods.
 * Limits/symlink rules are explicit; this is not a sandbox-wide read-only mount. */
export class SandboxWorkspaceFiles {
  constructor(private readonly options: {
    sandbox: Pick<SandboxEnvironment, "spawn">;
    root: string;
    python: string;
    writable: boolean;
    authorize(): Promise<void>;
    onCleanupUnconfirmed(): void;
  }) {
    for (const p of [options.root, options.python]) {
      if (!posix.isAbsolute(p) || p === "/" || posix.normalize(p) !== p || /[\\\x00-\x1f\x7f]/u.test(p))
        throw new Error("Invalid sandbox file binding");
    }
  }
  handles(method: string) { return methods.has(method); }
  async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (!methods.has(method)) throw new Error("Unsupported bound filesystem method");
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Invalid bound filesystem request");
    const value = params as Record<string, unknown>, path = value.path;
    if (Object.keys(value).some(k => k !== "path" && !(method === "fs/writeFile" && k === "dataBase64") && !(method === "fs/createDirectory" && k === "recursive"))
      || typeof path !== "string" || path.length > 4096 || /[\\\x00-\x1f\x7f]/u.test(path)
      || posix.normalize(path) !== path || !(path === this.options.root || path.startsWith(this.options.root + "/")))
      throw new Error("File path is outside the bound workspace");
    const write = method === "fs/writeFile";
    const createDirectory = method === "fs/createDirectory";
    if (createDirectory && value.recursive != null && typeof value.recursive !== "boolean") throw new Error("Invalid directory request");
    if ((write || createDirectory) && !this.options.writable) throw new Error("Bound workspace is read-only");
    const data = value.dataBase64;
    if (write && (typeof data !== "string" || data.length > 1398104
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)
      || Buffer.from(data, "base64").length > 1024 * 1024)) throw new Error("Invalid or oversized file content");
    await this.options.authorize();
    const input = { method, root: this.options.root,
      relative: path === this.options.root ? "" : path.slice(this.options.root.length + 1),
      ...(write ? { dataBase64: data } : {}),
      ...(createDirectory ? { recursive: value.recursive !== false } : {}) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let cancel: ((error: Error) => void) | undefined, expired = false;
    const run = async (): Promise<unknown> => {
      const resident = await this.residentProcess();
      // Authorization may have been revoked during remote process preparation.
      await this.options.authorize();
      signal?.throwIfAborted();
      if (expired) throw new Error("Bound filesystem request cancelled or timed out");
      const answer = await resident.call(input, reject => { cancel = reject; });
      await this.options.authorize();
      signal?.throwIfAborted();
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error("Invalid file response");
      const response = answer as Record<string, unknown>;
      if ("error" in response) throw new Error("Bound filesystem request rejected");
      if (method === "fs/readFile") {
        if (typeof response.dataBase64 !== "string" || response.dataBase64.length > 1398104
          || Buffer.from(response.dataBase64, "base64").toString("base64") !== response.dataBase64) throw new Error("Invalid file response");
      } else if (method === "fs/readDirectory") {
        if (!Array.isArray(response.entries) || response.entries.length > 2000 || response.entries.some(e =>
          !e || typeof e.fileName !== "string" || !e.fileName || e.fileName === "." || e.fileName === ".."
          || /[\/\\\x00-\x1f\x7f]/u.test(e.fileName) || typeof e.isDirectory !== "boolean" || typeof e.isFile !== "boolean"))
          throw new Error("Invalid directory response");
      } else if (method === "fs/getMetadata") {
        if (![response.isDirectory, response.isFile, response.isSymlink].every(v => typeof v === "boolean")
          || ![response.createdAtMs, response.modifiedAtMs].every(v => typeof v === "number" && Number.isFinite(v)))
          throw new Error("Invalid metadata response");
      } else if (Object.keys(response).length) throw new Error("Invalid write response");
      if (method === "fs/readFile") return { dataBase64: response.dataBase64 };
      if (method === "fs/readDirectory") return { entries: (response.entries as {fileName:string;isDirectory:boolean;isFile:boolean}[]).map(e => ({fileName:e.fileName,isDirectory:e.isDirectory,isFile:e.isFile})) };
      if (method === "fs/getMetadata") return {isDirectory:response.isDirectory,isFile:response.isFile,isSymlink:response.isSymlink,createdAtMs:response.createdAtMs,modifiedAtMs:response.modifiedAtMs};
      return {};
    };
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          const expire = () => {
            const error = new Error("Bound filesystem request cancelled or timed out");
            expired = true; cancel?.(error); reject(error);
          };
          // A stuck request may hold a helper thread; retire the resident process so the
          // next request starts a fresh one. Other in-flight requests fail; none is replayed.
          timer = setTimeout(() => { expire(); void this.retire().catch(() => {}); }, 30000);
          onAbort = expire; signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) expire();
        }),
      ]);
    } finally { clearTimeout(timer); if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }

  /** Ends the resident process. Idempotent; later requests are refused. */
  close(): Promise<void> {
    this.closed = true;
    return this.retire();
  }

  private closed = false;
  private resident: Promise<ResidentFileProcess> | undefined;
  private residentProcess(): Promise<ResidentFileProcess> {
    if (this.closed) return Promise.reject(new Error("Bound filesystem is closed"));
    const current = this.resident ??= ResidentFileProcess.start(this.options, () => {
      if (this.resident === current) this.resident = undefined;
    });
    current.catch(() => { if (this.resident === current) this.resident = undefined; });
    return current;
  }
  private async retire(): Promise<void> {
    const current = this.resident;
    this.resident = undefined;
    if (!current) return;
    let resident: ResidentFileProcess;
    try { resident = await current; } catch { return; }
    await resident.terminate();
  }
}

type FileProcessOptions = ConstructorParameters<typeof SandboxWorkspaceFiles>[0];
/** One attached process serving many requests over its stdio, one JSON line each. Its
 * failure ends only this process (never the environment) and fails its in-flight
 * requests; requests are never resent. */
class ResidentFileProcess {
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private partial: Buffer[] = [];
  private partialBytes = 0;
  private nextId = 1;
  private writing: Promise<void> = Promise.resolve();
  private failed = false;
  private terminating: Promise<void> | undefined;
  private child!: SandboxProcess;
  private constructor(private readonly options: FileProcessOptions, private readonly onEnded: () => void) {}

  static async start(options: FileProcessOptions, onEnded: () => void): Promise<ResidentFileProcess> {
    const resident = new ResidentFileProcess(options, onEnded);
    const child = await options.sandbox.spawn({
      command: [options.python, "-I", "-u", "-c", workspaceFileHelper],
      cwd: options.root, env: {}, attached: true,
    }, event => { if (event.stream === "stdout") resident.output(event.data); });
    resident.child = child;
    if (child.kind !== "process" || resident.failed) {
      resident.terminating = undefined; resident.failed = true;
      await resident.terminate(); throw new Error(child.kind !== "process" ? "Unexpected file transport" : "File process ended");
    }
    void child.exited.then(() => resident.fail(new Error("File process ended")), () => resident.fail(new Error("File process ended")));
    return resident;
  }

  call(input: Record<string, unknown>, onCancel: (cancel: (error: Error) => void) => void): Promise<unknown> {
    if (this.failed) return Promise.reject(new Error("File process ended"));
    if (this.pending.size >= 64) return Promise.reject(new Error("Bound filesystem is busy"));
    const id = this.nextId++;
    const line = Buffer.from(JSON.stringify({ id, ...input }) + "\n");
    const answer = new Promise<unknown>((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    onCancel(error => { const entry = this.pending.get(id); this.pending.delete(id); entry?.reject(error); });
    // Lines are written whole and in order; concurrent requests never interleave bytes.
    this.writing = this.writing.then(async () => {
      if (this.failed || !this.pending.has(id)) return;
      for (let offset = 0; offset < line.length; offset += 64 * 1024) await this.child.writeStdin(line.subarray(offset, offset + 64 * 1024));
    }).catch(() => this.fail(new Error("File process input failed")));
    return answer;
  }

  private output(data: Uint8Array) {
    if (this.failed) return;
    let chunk = Buffer.from(data);
    for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10)) {
      const line = Buffer.concat([...this.partial, chunk.subarray(0, end)]).toString("utf8");
      this.partial = []; this.partialBytes = 0; chunk = chunk.subarray(end + 1);
      let value: unknown;
      try { value = JSON.parse(line); } catch { this.fail(new Error("Invalid file response")); return; }
      const id = (value as { id?: unknown } | null)?.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || id >= this.nextId) { this.fail(new Error("Invalid file response")); return; }
      const entry = this.pending.get(id);
      this.pending.delete(id);
      if (entry) { const { id: _, ...response } = value as Record<string, unknown>; entry.resolve(response); }
    }
    this.partialBytes += chunk.length;
    if (this.partialBytes > 2 * 1024 * 1024) { this.fail(new Error("File response exceeds its budget")); return; }
    if (chunk.length) this.partial.push(chunk);
  }

  private fail(error: Error) {
    if (this.failed) return;
    this.failed = true;
    this.onEnded();
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    void this.terminate().catch(() => {});
  }

  terminate(): Promise<void> {
    if (!this.failed) { this.failed = true; this.onEnded(); for (const entry of this.pending.values()) entry.reject(new Error("File process ended")); this.pending.clear(); }
    if (!this.child) return Promise.resolve();
    return this.terminating ??= (async () => {
      // Terminating an already exited process is a no-op for conforming backends.
      try { await this.child.terminate(); }
      catch { this.options.onCleanupUnconfirmed(); throw new Error("File process cleanup unconfirmed"); }
    })();
  }
}
