import { posix } from "node:path";
import type { SandboxEnvironment, SandboxProcess } from "@opencraft/sandbox";
import { workspaceFileHelper } from "./sandbox-workspace-files-helper.js";

const methods = new Set(["fs/readDirectory", "fs/getMetadata", "fs/readFile", "fs/writeFile", "fs/createDirectory"]);
/** Host-owned file port for one already-authorized execution binding. Never
 * chooses/allocates a sandbox, reads Host paths or forwards unsupported methods.
 * Limits/symlink rules are explicit; this is not a sandbox-wide read-only mount. */
export class SandboxWorkspaceFiles {
  constructor(
    private readonly options: {
      sandbox: Pick<SandboxEnvironment, "spawn">;
      root: string;
      python: string;
      writable: boolean;
      authorize(): Promise<void>;
      onCleanupUnconfirmed(): void;
    },
  ) {
    for (const p of [options.root, options.python]) {
      if (!posix.isAbsolute(p) || p === "/" || posix.normalize(p) !== p || /[\\\x00-\x1f\x7f]/u.test(p))
        throw new Error("Invalid sandbox file binding");
    }
  }
  handles(method: string) {
    return methods.has(method);
  }
  async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (!methods.has(method)) throw new Error("Unsupported bound filesystem method");
    if (!params || typeof params !== "object" || Array.isArray(params))
      throw new Error("Invalid bound filesystem request");
    const value = params as Record<string, unknown>,
      path = value.path;
    if (
      Object.keys(value).some(
        (k) =>
          k !== "path" &&
          !(method === "fs/writeFile" && k === "dataBase64") &&
          !(method === "fs/createDirectory" && k === "recursive"),
      ) ||
      typeof path !== "string" ||
      path.length > 4096 ||
      /[\\\x00-\x1f\x7f]/u.test(path) ||
      posix.normalize(path) !== path ||
      !(path === this.options.root || path.startsWith(this.options.root + "/"))
    )
      throw new Error("File path is outside the bound workspace");
    const write = method === "fs/writeFile";
    const createDirectory = method === "fs/createDirectory";
    if (createDirectory && value.recursive != null && typeof value.recursive !== "boolean")
      throw new Error("Invalid directory request");
    if ((write || createDirectory) && !this.options.writable) throw new Error("Bound workspace is read-only");
    const data = value.dataBase64;
    if (
      write &&
      (typeof data !== "string" ||
        data.length > 1398104 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data) ||
        Buffer.from(data, "base64").length > 1024 * 1024)
    )
      throw new Error("Invalid or oversized file content");
    await this.options.authorize();
    const input = Buffer.from(
      JSON.stringify({
        method,
        root: this.options.root,
        relative: path === this.options.root ? "" : path.slice(this.options.root.length + 1),
        ...(write ? { dataBase64: data } : {}),
        ...(createDirectory ? { recursive: value.recursive !== false } : {}),
      }),
    );
    const chunks: Buffer[] = [];
    let bytes = 0,
      overflow = false;
    let child: SandboxProcess | undefined,
      expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let cleaning: Promise<void> | undefined;
    const cleanup = async () => {
      if (child)
        try {
          await (cleaning ??= child.terminate());
        } catch {
          this.options.onCleanupUnconfirmed();
          throw new Error("File process cleanup unconfirmed");
        }
    };
    const run = async (): Promise<unknown> => {
      child = await this.options.sandbox.spawn(
        {
          command: [this.options.python, "-I", "-c", workspaceFileHelper],
          cwd: this.options.root,
          env: {},
        },
        (event) => {
          if (event.stream !== "stdout") return;
          bytes += event.data.byteLength;
          if (bytes > 2 * 1024 * 1024) overflow = true;
          else if (!overflow) chunks.push(Buffer.from(event.data));
        },
      );
      if (expired || signal?.aborted) {
        await cleanup();
        throw new Error("Bound filesystem request cancelled or timed out");
      }
      if (child.kind !== "process") {
        await child.terminate();
        throw new Error("Unexpected file transport");
      }
      // Authorization may have been revoked during remote process preparation.
      await this.options.authorize();
      signal?.throwIfAborted();
      for (let offset = 0; offset < input.length; offset += 64 * 1024) {
        if (expired) throw new Error("Bound filesystem request timed out");
        await child.writeStdin(input.subarray(offset, offset + 64 * 1024));
      }
      await child.closeStdin();
      const exit = await child.exited;
      if (expired || overflow || exit.code !== 0) throw new Error("Bound filesystem request failed");
      await this.options.authorize();
      signal?.throwIfAborted();
      const answer: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error("Invalid file response");
      const response = answer as Record<string, unknown>;
      if ("error" in response) throw new Error("Bound filesystem request rejected");
      if (method === "fs/readFile") {
        if (
          typeof response.dataBase64 !== "string" ||
          response.dataBase64.length > 1398104 ||
          Buffer.from(response.dataBase64, "base64").toString("base64") !== response.dataBase64
        )
          throw new Error("Invalid file response");
      } else if (method === "fs/readDirectory") {
        if (
          !Array.isArray(response.entries) ||
          response.entries.length > 2000 ||
          response.entries.some(
            (e) =>
              !e ||
              typeof e.fileName !== "string" ||
              !e.fileName ||
              e.fileName === "." ||
              e.fileName === ".." ||
              /[\/\\\x00-\x1f\x7f]/u.test(e.fileName) ||
              typeof e.isDirectory !== "boolean" ||
              typeof e.isFile !== "boolean",
          )
        )
          throw new Error("Invalid directory response");
      } else if (method === "fs/getMetadata") {
        if (
          ![response.isDirectory, response.isFile, response.isSymlink].every((v) => typeof v === "boolean") ||
          ![response.createdAtMs, response.modifiedAtMs].every((v) => typeof v === "number" && Number.isFinite(v))
        )
          throw new Error("Invalid metadata response");
      } else if (Object.keys(response).length) throw new Error("Invalid write response");
      if (method === "fs/readFile") return { dataBase64: response.dataBase64 };
      if (method === "fs/readDirectory")
        return {
          entries: (response.entries as { fileName: string; isDirectory: boolean; isFile: boolean }[]).map((e) => ({
            fileName: e.fileName,
            isDirectory: e.isDirectory,
            isFile: e.isFile,
          })),
        };
      if (method === "fs/getMetadata")
        return {
          isDirectory: response.isDirectory,
          isFile: response.isFile,
          isSymlink: response.isSymlink,
          createdAtMs: response.createdAtMs,
          modifiedAtMs: response.modifiedAtMs,
        };
      return {};
    };
    try {
      return await Promise.race([
        run().finally(cleanup),
        new Promise<never>((_, reject) => {
          const stop = () => {
            expired = true;
            void cleanup().catch(() => {});
            reject(new Error("Bound filesystem request cancelled or timed out"));
          };
          timer = setTimeout(stop, 30000);
          onAbort = stop;
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) stop();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }
}
