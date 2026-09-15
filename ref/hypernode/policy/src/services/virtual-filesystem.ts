import { Context, Service } from "@deepseek-ai/cordis";
import type { ByteInput } from "../runtime/bytes.ts";
import type { JsonRpcRequest } from "../types/appserver.ts";
import type { HostUserRecord } from "../types/host-policy.ts";
import type { MemoryVfsPort, VfsDirectoryEntry, VfsMetadata } from "../types/vfs.ts";
import type { LocalRuntimeFilesystemPort } from "../types/workspace.ts";

const MOUNT = "/localhost";

interface VirtualFilesystemUser extends Partial<HostUserRecord> {
  homePath?: string | null;
}

interface PathOperation {
  path: string;
  recursive?: boolean;
  force?: boolean;
}

interface CopyOperation {
  sourcePath: string;
  destinationPath: string;
  recursive?: boolean;
}

function filesystemUser(value: unknown): VirtualFilesystemUser | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as VirtualFilesystemUser
    : null;
}

function userRoot(user: VirtualFilesystemUser | null, fallback: string): string {
  return typeof user?.homePath === "string" && user.homePath.length > 0
    ? user.homePath
    : fallback;
}

function username(user: VirtualFilesystemUser | null): string | null {
  return typeof user?.username === "string" && user.username.length > 0
    ? user.username
    : null;
}

export class VirtualFilesystemService extends Service implements LocalRuntimeFilesystemPort {
  readonly mount = MOUNT;
  physicalRoot: string;

  constructor(ctx: Context) {
    super(ctx, "virtualFilesystem");
    this.physicalRoot = hostFilesystem.root();
  }

  normalize(path: string): string {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new Error("virtual filesystem paths must be absolute");
    }
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return `/${parts.join("/")}`;
  }

  owns(path: string): boolean {
    if (typeof path !== "string" || !path.startsWith("/")) return false;
    const normalized = this.normalize(path);
    return normalized === MOUNT || normalized.startsWith(`${MOUNT}/`);
  }

  relative(path: string): string {
    const normalized = this.normalize(path);
    if (!this.owns(normalized)) throw new Error(`path is outside ${MOUNT}: ${normalized}`);
    return normalized === MOUNT ? "." : normalized.slice(MOUNT.length + 1);
  }

  toPhysical(path: string, rawUser: unknown = null): string {
    const relative = this.relative(path);
    const root = userRoot(filesystemUser(rawUser), this.physicalRoot);
    return relative === "." ? root : `${root}/${relative}`;
  }

  toVirtual(path: string, rawUser: unknown = null): string {
    const text = String(path);
    const root = userRoot(filesystemUser(rawUser), this.physicalRoot);
    if (text === root) return MOUNT;
    if (text.startsWith(`${root}/`)) return `${MOUNT}${text.slice(root.length)}`;
    return text;
  }

  ensureWorkingDirectory(path: string, rawUser: unknown = null): string {
    const normalized = this.normalize(path);
    if (!this.owns(normalized)) {
      throw new Error(`working directory is outside ${MOUNT}: ${normalized}`);
    }
    this.createDirectory({ path: normalized, recursive: true }, rawUser);
    return this.toPhysical(normalized, rawUser);
  }

  metadata(path: string, rawUser: unknown = null): VfsMetadata {
    const normalized = this.normalize(path);
    const relative = this.relative(normalized);
    const user = filesystemUser(rawUser);
    const name = username(user);
    const metadata = name === null
      ? hostFilesystem.metadata(relative)
      : hostFilesystem.metadataForUser(name, relative);
    if (normalized === MOUNT) metadata.fileName = "localhost";
    return metadata;
  }

  readDirectory(path: string, rawUser: unknown = null): VfsDirectoryEntry[] {
    const relative = this.relative(path);
    const name = username(filesystemUser(rawUser));
    return name === null
      ? hostFilesystem.readDirectory(relative)
      : hostFilesystem.readDirectoryForUser(name, relative);
  }

  readFile(path: string, rawUser: unknown = null): Uint8Array {
    const relative = this.relative(path);
    const name = username(filesystemUser(rawUser));
    return name === null
      ? hostFilesystem.readFile(relative)
      : hostFilesystem.readFileForUser(name, relative);
  }

  writeFile(params: PathOperation, bytes: ByteInput, rawUser: unknown = null): Record<string, never> {
    const relative = this.relative(params.path);
    const user = filesystemUser(rawUser);
    const name = username(user);
    if (name !== null) {
      hostFilesystem.writeFileForUser(name, relative, bytes, user?.linuxUid, user?.linuxGid);
    } else {
      hostFilesystem.writeFile(relative, bytes);
    }
    return {};
  }

  createDirectory(params: PathOperation, rawUser: unknown = null): Record<string, never> {
    const relative = this.relative(params.path);
    const user = filesystemUser(rawUser);
    const name = username(user);
    if (name !== null) {
      hostFilesystem.createDirectoryForUser(
        name,
        relative,
        params.recursive !== false,
        user?.linuxUid,
        user?.linuxGid,
      );
    } else {
      hostFilesystem.createDirectory(relative, params.recursive !== false);
    }
    return {};
  }

  remove(params: PathOperation, rawUser: unknown = null): Record<string, never> {
    const relative = this.relative(params.path);
    const name = username(filesystemUser(rawUser));
    if (name !== null) {
      hostFilesystem.removeForUser(
        name,
        relative,
        params.recursive !== false,
        params.force !== false,
      );
    } else {
      hostFilesystem.remove(relative, params.recursive !== false, params.force !== false);
    }
    return {};
  }

  copy(
    params: CopyOperation,
    fallback: MemoryVfsPort,
    rawUser: unknown = null,
  ): Record<string, never> {
    const source = this.normalize(params.sourcePath);
    const destination = this.normalize(params.destinationPath);
    const sourceHost = this.owns(source);
    const destinationHost = this.owns(destination);
    const metadata = sourceHost ? this.metadata(source, rawUser) : fallback.metadata(source);
    if (metadata.isFile) {
      const bytes = sourceHost ? this.readFile(source, rawUser) : fallback.readFile(source);
      if (destinationHost) this.writeFile({ path: destination }, bytes, rawUser);
      else fallback.writeFile(destination, bytes);
      return {};
    }
    if (params.recursive !== true) throw new Error("directory copies require recursive: true");
    if (destinationHost) this.createDirectory({ path: destination, recursive: true }, rawUser);
    else fallback.createDirectory(destination, true);
    const entries = sourceHost
      ? this.readDirectory(source, rawUser)
      : fallback.readDirectory(source);
    for (const entry of entries) {
      this.copy({
        sourcePath: `${source}/${entry.fileName}`,
        destinationPath: `${destination}/${entry.fileName}`,
        recursive: true,
      }, fallback, rawUser);
    }
    return {};
  }

  spawnAppServer(
    processId: string,
    cwd = MOUNT,
    rawUser: unknown = null,
    _viewId = "main",
    providerId: string | null = null,
  ): void {
    const user = filesystemUser(rawUser);
    const name = username(user);
    if (name !== null) {
      hostProcess.spawnCodexAppServerForUser(
        processId,
        this.relative(cwd),
        name,
        user?.linuxUid,
        user?.linuxGid,
        user?.installationId,
        providerId ?? "",
      );
      return;
    }
    hostProcess.spawnCodexAppServer(processId, this.relative(cwd));
  }

  spawnThreadRuntime(
    processId: string,
    cwd = MOUNT,
    rawUser: unknown = null,
    viewId = "main",
    _runtimeId = processId,
    providerId: string | null = null,
  ): void {
    this.spawnAppServer(processId, cwd, rawUser, viewId, providerId);
  }

  spawnDshEngineWorker(
    processId: string,
    cwd = MOUNT,
    rawUser: unknown = null,
    providerId: string | null = null,
  ): void {
    const user = filesystemUser(rawUser);
    const name = username(user);
    if (name === null) throw new Error("DSH engine requires an authenticated user");
    if (!providerId) throw new Error("DSH engine requires a model provider");
    hostProcess.spawnDshEngineWorkerForUser(
      processId,
      this.relative(cwd),
      name,
      user?.linuxUid,
      user?.linuxGid,
      user?.installationId,
      providerId,
    );
  }

  send(processId: string, message: JsonRpcRequest | string): void {
    const payload = typeof message === "string" ? message : JSON.stringify(message);
    hostProcess.write(processId, `${payload}\n`);
  }

  drain(processId: string): ReturnType<HostProcessPort["drain"]> {
    return hostProcess.drain(processId);
  }

  kill(processId: string): void {
    hostProcess.kill(processId);
  }

  terminateThreadRuntime(
    processId: string,
    _viewId = "main",
    _runtimeId = processId,
    timeoutMs = 5_000,
  ): void {
    hostProcess.terminate(processId, timeoutMs);
  }
}
