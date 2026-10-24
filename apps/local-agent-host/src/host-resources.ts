import { readFile, readdir, stat, lstat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ProjectRepository } from "./project-repository.js";
import { LocalAttachmentStagingService } from "./attachments/local-attachment-staging.js";
import { OPENCRAFT_ATTACHMENT_STAGING_EXTENSION } from "@opencraft/appserver-protocol";

export async function fileRequest(method: string, params: unknown): Promise<unknown> {
  const value = typeof params === "object" && params !== null ? params as Record<string, unknown> : {};
  const path = resolve(String(value.path ?? homedir()));
  if (method === "fs/readDirectory") {
    const entries = await readdir(path, { withFileTypes: true });
    return {
      entries: entries.map((entry) => ({
        fileName: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      })),
    };
  }
  if (method === "fs/getMetadata") {
    const [metadata, pathMetadata] = await Promise.all([stat(path), lstat(path)]);
    return {
      isDirectory: metadata.isDirectory(),
      isFile: metadata.isFile(),
      isSymlink: pathMetadata.isSymbolicLink(),
      createdAtMs: Number.isFinite(metadata.birthtimeMs) ? metadata.birthtimeMs : 0,
      modifiedAtMs: Number.isFinite(metadata.mtimeMs) ? metadata.mtimeMs : 0,
    };
  }
  if (method === "fs/readFile") return { dataBase64: (await readFile(path)).toString("base64") };
  if (method === "fs/writeFile") {
    await writeFile(path, Buffer.from(String(value.dataBase64 ?? ""), "base64"));
    return {};
  }
  throw new Error(`Unsupported filesystem method ${method}`);
}

/** Files, projects and uploads belong to this Host, independently of its engines. */
export class LocalHostResources {
  private readonly projects: ProjectRepository;
  private readonly attachments?: LocalAttachmentStagingService;
  constructor(options: { projectDirectory?: string; attachmentDirectory?: string } = {}) {
    this.projects = new ProjectRepository(options.projectDirectory);
    if (options.attachmentDirectory) this.attachments = new LocalAttachmentStagingService(options.attachmentDirectory);
  }
  get extensions() { return this.attachments ? { [OPENCRAFT_ATTACHMENT_STAGING_EXTENSION]: this.attachments.capability } : {}; }
  handles(method: string) { return method === "project/list" || method === "project/create" || method.startsWith("fs/") || !!this.attachments && method.startsWith("attachment/"); }
  request(method: string, params: any): Promise<unknown> {
    if (method === "project/list") return this.projects.list(params);
    if (method === "project/create") return this.projects.create(params);
    if (method.startsWith("fs/")) return fileRequest(method, params);
    if (this.attachments && method.startsWith("attachment/")) return this.attachments.handle(method, params);
    return Promise.reject(new Error(`Unsupported Host resource ${method}`));
  }
  async close() { await this.attachments?.close(); }
}
