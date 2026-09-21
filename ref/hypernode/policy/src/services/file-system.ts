import { Service, type Context } from "@deepseek-ai/cordis";
import {
  base64Decode,
  base64Encode,
  utf8Encode,
  type ByteInput,
} from "../runtime/bytes.ts";
import type {
  AppServerConnection,
  AppServerHandler,
  AppServerParams,
} from "../types/appserver.ts";
import type { HostUserDirectoryPort } from "../types/host-policy.ts";
import type { ThreadWriteLeaseLifecyclePort } from "../types/thread-lifecycle.ts";
import type { MemoryVfsPort, VfsDirectoryEntry, VfsMetadata } from "../types/vfs.ts";
import type {
  LocalRuntimeFilesystemPort,
  WorkspaceRuntimeFilesystemPort,
  WorkspaceViewPort as RuntimeWorkspaceViewPort,
} from "../types/workspace.ts";
import {
  resolveFilesystemWatch,
  type FilesystemWatchResolver,
} from "./filesystem-watch.ts";
import { deferredAppServerResponse } from "./appserver.ts";
import { WORKSPACE_CODEX_HOME } from "./workspace-filesystem.js";

interface WorkspaceUser {
  id: string;
  username: string;
  installationId?: string;
  [key: string]: unknown;
}

interface UserDirectoryPort extends HostUserDirectoryPort {
  find(id: string): WorkspaceUser | null;
}

interface WorkspaceViewPort extends RuntimeWorkspaceViewPort {
  assertWritePath(threadId: string, path: string): void;
}

interface FileOperationParams extends AppServerParams {
  path?: unknown;
  sourcePath?: unknown;
  destinationPath?: unknown;
  watchId?: unknown;
  dataBase64?: unknown;
  recursive?: unknown;
  force?: unknown;
}

interface FileNamespacePort extends FilesystemWatchResolver {
  metadata(path: string, user?: WorkspaceUser | null): VfsMetadata;
  readDirectory(path: string, user?: WorkspaceUser | null): VfsDirectoryEntry[];
  readFile(path: string, user?: WorkspaceUser | null): ByteInput;
  createDirectory(params: FileOperationParams, user?: WorkspaceUser | null): unknown;
  remove(params: FileOperationParams, user?: WorkspaceUser | null): unknown;
  writeFile(
    params: FileOperationParams,
    bytes: ByteInput,
    user?: WorkspaceUser | null,
  ): unknown;
}

interface LocalEnvironmentPort {
  owns(path: string, user?: WorkspaceUser | null): boolean;
  normalize(path: string): string;
  acceptsDirectory(path: string): boolean;
  acceptsFile(path: string): boolean;
  metadata(path: string, user?: WorkspaceUser | null): VfsMetadata;
  readDirectory(path: string, user?: WorkspaceUser | null): VfsDirectoryEntry[];
  readFile(path: string, user?: WorkspaceUser | null): ByteInput;
  createDirectory(params: FileOperationParams, user?: WorkspaceUser | null): unknown;
  remove(params: FileOperationParams, user?: WorkspaceUser | null): unknown;
  writeFile(
    params: FileOperationParams,
    bytes: ByteInput,
    user?: WorkspaceUser | null,
  ): unknown;
}

interface VirtualFilesystemPort extends FileNamespacePort,
  Omit<LocalRuntimeFilesystemPort, "createDirectory" | "writeFile"> {
  copy(
    params: FileOperationParams,
    fallback: MemoryVfsPort,
    user?: WorkspaceUser | null,
  ): unknown;
}

interface WorkspaceFilesystemPort extends WorkspaceRuntimeFilesystemPort, FilesystemWatchResolver {
  toVirtual(path: string, user: WorkspaceUser | null, viewId: string): string;
  ownsControlPath(path: string): boolean;
  controlPathForUser(path: string): string;
  metadata(path: string, viewId: string): VfsMetadata;
  readDirectory(path: string, viewId: string): VfsDirectoryEntry[];
  readFile(path: string, viewId: string): ByteInput;
  createDirectory(params: FileOperationParams, viewId: string): unknown;
  remove(params: FileOperationParams, viewId: string): unknown;
  copy(params: FileOperationParams, viewId: string): unknown;
  writeFile(params: FileOperationParams, bytes: ByteInput, viewId: string): unknown;
  watch(watchId: string, path: string, viewId: string): void;
  drainWatch(watchId: string): string[];
  unwatch(watchId: string): void;
}

interface FileSystemContext extends Context {
  localEnvironment: LocalEnvironmentPort;
  threadWriteLease: ThreadWriteLeaseLifecyclePort;
  userDirectory: UserDirectoryPort;
  vfs: MemoryVfsPort;
  virtualFilesystem: VirtualFilesystemPort;
  workspaceFilesystem: WorkspaceFilesystemPort;
  workspaceView: WorkspaceViewPort;
}

interface ControlPath {
  path: string;
  user: WorkspaceUser;
}

interface FuzzySearchSessionState {
  readonly roots: readonly string[];
  generation: number;
}

interface FuzzySearchResult {
  readonly root: string;
  readonly path: string;
  readonly match_type: "file" | "directory";
  readonly file_name: string;
  readonly score: number;
  readonly indices: readonly number[] | null;
}

const FUZZY_SEARCH_EXCLUDED_DIRECTORIES = new Set([
  ".git", ".hg", ".next", ".pnpm-store", ".svn", ".turbo", ".yarn",
  "build", "coverage", "dist", "node_modules",
]);
const FUZZY_SEARCH_MAX_VISITED = 30_000;
const FUZZY_SEARCH_MAX_RESULTS = 200;
const FUZZY_SEARCH_STEP_DELAY_MS = 1;

function requiredStringArray(params: AppServerParams, key: string): string[] {
  const value = params[key];
  if (!Array.isArray(value)) {
    throw new FileSystemRpcError(`filesystem parameter ${key} must be an array`, -32602, { key });
  }
  const result = [...new Set(value.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : []))];
  if (result.length === 0) {
    throw new FileSystemRpcError(`filesystem parameter ${key} must contain a path`, -32602, { key });
  }
  return result;
}

function joinPath(parent: string, child: string): string {
  return parent === "/" ? `/${child}` : `${parent.replace(/\/+$/u, "")}/${child}`;
}

function matchScore(value: string, rawQuery: string): { score: number; indices: number[] } | null {
  const candidate = value.toLocaleLowerCase();
  const query = rawQuery.toLocaleLowerCase();
  if (query.length === 0) return null;
  const substring = candidate.indexOf(query);
  if (substring >= 0) {
    const quality = candidate === query ? 1_000 : substring === 0 ? 900 : 800 - Math.min(200, substring);
    return {
      score: quality - Math.min(100, candidate.length - query.length),
      indices: Array.from({ length: query.length }, (_, index) => substring + index),
    };
  }
  const indices: number[] = [];
  let cursor = 0;
  for (const character of query) {
    const index = candidate.indexOf(character, cursor);
    if (index < 0) return null;
    indices.push(index);
    cursor = index + 1;
  }
  const span = indices.at(-1)! - indices[0]! + 1;
  return { score: 600 - indices[0]! - Math.max(0, span - query.length), indices };
}

class FileSystemRpcError extends Error {
  readonly code: number;
  readonly data: Record<string, unknown>;

  constructor(message: string, code: number, data: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function requiredString(params: AppServerParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new FileSystemRpcError(`filesystem parameter ${key} must be a non-empty string`, -32602, {
      key,
    });
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FileSystemService extends Service {
  static inject = [
    "appServer", "localEnvironment", "threadWriteLease", "userDirectory", "vfs",
    "virtualFilesystem", "workspaceFilesystem", "workspaceView",
  ];

  constructor(ctx: FileSystemContext) {
    super(ctx, "fileSystem");
    const userFor = (connection: AppServerConnection): WorkspaceUser | null => {
      const id = connection.identity?.id;
      return typeof id === "string" ? ctx.userDirectory.find(id) : null;
    };
    const viewFor = (connection: AppServerConnection): string => {
      return typeof connection.activeThreadId === "string"
        ? ctx.workspaceView.viewIdForThread(connection.activeThreadId)
        : "main";
    };
    const clientPath = (path: string, connection: AppServerConnection): string => {
      return ctx.workspaceFilesystem.toVirtual(path, userFor(connection), viewFor(connection));
    };
    const userControlPath = (
      path: string,
      connection: AppServerConnection,
    ): ControlPath | null => {
      if (!ctx.workspaceFilesystem.ownsControlPath(path)) return null;
      if (
        ctx.workspaceFilesystem.enabled === false &&
        path.startsWith(`${WORKSPACE_CODEX_HOME}/.tmp/bundled-marketplaces/`)
      ) {
        return null;
      }
      const user = userFor(connection);
      if (typeof user?.username !== "string" || user.username.length === 0) {
        if (ctx.workspaceFilesystem.enabled === false) return null;
        throw new FileSystemRpcError(
          "workspace Codex state requires an authenticated user",
          -32066,
          { kind: "workspaceControlPathRequiresUser", path },
        );
      }
      return { path: ctx.workspaceFilesystem.controlPathForUser(path), user };
    };
    const authorizeWorkspaceWrite = (path: string, connection: AppServerConnection): void => {
      if (!ctx.workspaceFilesystem.owns(path)) return;
      if (ctx.workspaceFilesystem.ownsControlPath(path)) return;
      const threadId = connection.activeThreadId;
      if (typeof threadId !== "string") {
        throw new FileSystemRpcError(
          "workspace writes require an active thread",
          -32063,
          { kind: "workspaceWriteRequiresThread", path },
        );
      }
      ctx.workspaceView.assertWritePath(threadId, path);
      const result = ctx.threadWriteLease.acquire(threadId, connection, "editing");
      if (!result.acquired) throw ctx.threadWriteLease.errorFor(result.lease);
    };
    const metadataFor = (path: string, connection: AppServerConnection): VfsMetadata => {
      const virtualPath = clientPath(path, connection);
      const user = userFor(connection);
      const control = userControlPath(virtualPath, connection);
      const metadata = control
        ? ctx.virtualFilesystem.metadata(control.path, control.user)
        : ctx.localEnvironment.owns(virtualPath, user)
          ? ctx.localEnvironment.metadata(virtualPath, user)
          : ctx.workspaceFilesystem.owns(virtualPath)
            ? ctx.workspaceFilesystem.metadata(virtualPath, viewFor(connection))
            : ctx.virtualFilesystem.owns(virtualPath)
              ? ctx.virtualFilesystem.metadata(virtualPath, user)
              : ctx.vfs.metadata(virtualPath);
      return {
        isDirectory: metadata.isDirectory === true,
        isFile: metadata.isFile === true,
        isSymlink: false,
        createdAtMs: Number(metadata.createdAtMs ?? 0),
        modifiedAtMs: Number(metadata.modifiedAtMs ?? 0),
      };
    };
    const register = (method: string, handler: AppServerHandler): void => {
      ctx.effect(() => ctx.appServer.register(method, handler));
    };
    const fuzzySessions = new Map<AppServerConnection, Map<string, FuzzySearchSessionState>>();
    ctx.effect(() => ctx.appServer.onClose((connection) => {
      fuzzySessions.delete(connection);
    }));
    const readDirectoryFor = (
      path: string,
      connection: AppServerConnection,
    ): VfsDirectoryEntry[] => {
      const user = userFor(connection);
      const control = userControlPath(path, connection);
      return control
        ? ctx.virtualFilesystem.readDirectory(control.path, control.user)
        : ctx.localEnvironment.owns(path, user)
          ? ctx.localEnvironment.readDirectory(path, user)
          : ctx.workspaceFilesystem.owns(path)
            ? ctx.workspaceFilesystem.readDirectory(path, viewFor(connection))
            : ctx.virtualFilesystem.owns(path)
              ? ctx.virtualFilesystem.readDirectory(path, user)
              : ctx.vfs.readDirectory(path);
    };
    const startFuzzySearch = (
      query: string,
      requestedRoots: readonly string[],
      connection: AppServerConnection,
      isActive: () => boolean,
      onProgress: ((files: FuzzySearchResult[]) => void) | undefined,
      onComplete: (files: FuzzySearchResult[]) => void,
    ): void => {
      const normalizedQuery = query.trim();
      if (normalizedQuery.length === 0) {
        onComplete([]);
        return;
      }
      const results: Array<FuzzySearchResult & { order: number }> = [];
      const queue = requestedRoots.map((requestedRoot) => ({
        requestedRoot,
        absolutePath: clientPath(requestedRoot, connection),
        relativePath: "",
      }));
      let queueCursor = 0;
      let visited = 0;
      let order = 0;
      const snapshotResults = (): FuzzySearchResult[] => results
          .sort((left, right) => right.score - left.score
            || left.path.localeCompare(right.path)
            || left.order - right.order)
          .slice(0, FUZZY_SEARCH_MAX_RESULTS)
          .map(({ order: _order, ...result }) => result);
      const step = (): void => {
        if (!isActive()) return;
        let stepVisited = 0;
        while (
          queueCursor < queue.length
          && visited < FUZZY_SEARCH_MAX_VISITED
          && stepVisited < 600
        ) {
          const current = queue[queueCursor++]!;
          let entries: VfsDirectoryEntry[];
          try {
            entries = readDirectoryFor(current.absolutePath, connection);
          } catch {
            continue;
          }
          entries.sort((left, right) => left.fileName.localeCompare(right.fileName));
          for (const entry of entries) {
            visited += 1;
            stepVisited += 1;
            const relativePath = current.relativePath.length === 0
              ? entry.fileName
              : `${current.relativePath}/${entry.fileName}`;
            const absolutePath = joinPath(current.absolutePath, entry.fileName);
            if (entry.isDirectory && !FUZZY_SEARCH_EXCLUDED_DIRECTORIES.has(entry.fileName)) {
              queue.push({
                requestedRoot: current.requestedRoot,
                absolutePath,
                relativePath,
              });
            }
            const nameMatch = matchScore(entry.fileName, normalizedQuery);
            const pathMatch = matchScore(relativePath, normalizedQuery);
            const best = nameMatch === null
              ? pathMatch
              : pathMatch === null || nameMatch.score >= pathMatch.score ? nameMatch : pathMatch;
            if (best === null) continue;
            results.push({
              root: current.requestedRoot,
              path: relativePath,
              match_type: entry.isDirectory ? "directory" : "file",
              file_name: entry.fileName,
              score: best.score,
              indices: best.indices,
              order: order++,
            });
          }
        }
        if (queueCursor < queue.length && visited < FUZZY_SEARCH_MAX_VISITED) {
          onProgress?.(snapshotResults());
          ctx.appServer.defer(connection, FUZZY_SEARCH_STEP_DELAY_MS, step);
        } else {
          onComplete(snapshotResults());
        }
      };
      ctx.appServer.defer(connection, FUZZY_SEARCH_STEP_DELAY_MS, step);
    };

    register("fs/createDirectory", (params, connection) => {
      const path = clientPath(requiredString(params, "path"), connection);
      const mapped: FileOperationParams = { ...params, path };
      const control = userControlPath(path, connection);
      if (control) {
        return ctx.virtualFilesystem.createDirectory({ ...mapped, path: control.path }, control.user);
      }
      authorizeWorkspaceWrite(path, connection);
      if (ctx.localEnvironment.acceptsDirectory(path)) {
        return ctx.localEnvironment.createDirectory(mapped, userFor(connection));
      }
      if (ctx.workspaceFilesystem.owns(path)) {
        return ctx.workspaceFilesystem.createDirectory(mapped, viewFor(connection));
      }
      if (ctx.virtualFilesystem.owns(path)) {
        return ctx.virtualFilesystem.createDirectory(mapped, userFor(connection));
      }
      ctx.vfs.createDirectory(path, params["recursive"] !== false);
      return {};
    });

    register("fs/getMetadata", (params, connection) => {
      return metadataFor(requiredString(params, "path"), connection);
    });

    register("fs/readDirectory", (params, connection) => {
      const path = clientPath(requiredString(params, "path"), connection);
      return { entries: readDirectoryFor(path, connection) };
    });

    register("fuzzyFileSearch", (params, connection) => {
      const query = typeof params["query"] === "string" ? params["query"] : "";
      const roots = requiredStringArray(params, "roots");
      return deferredAppServerResponse((controller) => {
        startFuzzySearch(query, roots, connection, () => true, undefined, (files) => {
          controller.resolve({ files });
        });
      });
    });

    register("fuzzyFileSearch/sessionStart", (params, connection) => {
      const sessionId = requiredString(params, "sessionId");
      const sessions = fuzzySessions.get(connection) ?? new Map<string, FuzzySearchSessionState>();
      sessions.set(sessionId, { roots: requiredStringArray(params, "roots"), generation: 0 });
      fuzzySessions.set(connection, sessions);
      return {};
    });

    register("fuzzyFileSearch/sessionUpdate", (params, connection) => {
      const sessionId = requiredString(params, "sessionId");
      const query = typeof params["query"] === "string" ? params["query"] : "";
      const session = fuzzySessions.get(connection)?.get(sessionId);
      if (session === undefined) {
        throw new FileSystemRpcError("fuzzy file search session not found", -32001, {
          kind: "fuzzyFileSearchSessionNotFound",
          sessionId,
        });
      }
      const generation = ++session.generation;
      startFuzzySearch(
        query,
        session.roots,
        connection,
        () => fuzzySessions.get(connection)?.get(sessionId) === session
          && session.generation === generation,
        (files) => {
          if (
            fuzzySessions.get(connection)?.get(sessionId) !== session
            || session.generation !== generation
          ) return;
          ctx.appServer.send(connection, {
            method: "fuzzyFileSearch/sessionUpdated",
            params: { sessionId, query, files },
          });
        },
        (files) => {
          if (
            fuzzySessions.get(connection)?.get(sessionId) !== session
            || session.generation !== generation
          ) return;
          ctx.appServer.send(connection, {
            method: "fuzzyFileSearch/sessionUpdated",
            params: { sessionId, query, files },
          });
          ctx.appServer.send(connection, {
            method: "fuzzyFileSearch/sessionCompleted",
            params: { sessionId },
          });
        },
      );
      return {};
    });

    register("fuzzyFileSearch/sessionStop", (params, connection) => {
      const sessionId = requiredString(params, "sessionId");
      fuzzySessions.get(connection)?.delete(sessionId);
      return {};
    });

    register("fs/readFile", (params, connection) => {
      const path = clientPath(requiredString(params, "path"), connection);
      const identityId = connection.identity?.id;
      if (path === "/workspace/.codex/installation_id" && typeof identityId === "string") {
        const user = ctx.userDirectory.find(identityId);
        if (typeof user?.installationId === "string") {
          return { dataBase64: base64Encode(utf8Encode(user.installationId)) };
        }
      }
      const user = userFor(connection);
      const control = userControlPath(path, connection);
      const bytes = control
        ? ctx.virtualFilesystem.readFile(control.path, control.user)
        : ctx.localEnvironment.owns(path, user)
          ? ctx.localEnvironment.readFile(path, user)
          : ctx.workspaceFilesystem.owns(path)
            ? ctx.workspaceFilesystem.readFile(path, viewFor(connection))
            : ctx.virtualFilesystem.owns(path)
              ? ctx.virtualFilesystem.readFile(path, user)
              : ctx.vfs.readFile(path);
      return { dataBase64: base64Encode(bytes) };
    });

    register("fs/remove", (params, connection) => {
      const path = clientPath(requiredString(params, "path"), connection);
      const mapped: FileOperationParams = { ...params, path };
      const control = userControlPath(path, connection);
      if (control) return ctx.virtualFilesystem.remove({ ...mapped, path: control.path }, control.user);
      authorizeWorkspaceWrite(path, connection);
      const user = userFor(connection);
      if (ctx.localEnvironment.owns(path, user)) return ctx.localEnvironment.remove(mapped, user);
      if (ctx.workspaceFilesystem.owns(path)) return ctx.workspaceFilesystem.remove(mapped, viewFor(connection));
      if (ctx.virtualFilesystem.owns(path)) return ctx.virtualFilesystem.remove(mapped, user);
      ctx.vfs.remove(path, params["recursive"] !== false, params["force"] !== false);
      return {};
    });

    register("fs/copy", (params, connection) => {
      const sourcePath = clientPath(requiredString(params, "sourcePath"), connection);
      const destinationPath = clientPath(requiredString(params, "destinationPath"), connection);
      const mapped: FileOperationParams = { ...params, sourcePath, destinationPath };
      const controlSource = userControlPath(sourcePath, connection);
      const controlDestination = userControlPath(destinationPath, connection);
      if (controlSource || controlDestination) {
        if (!controlSource || !controlDestination) {
          throw new Error("copying across workspace control and project boundaries is not supported");
        }
        return ctx.virtualFilesystem.copy({
          ...mapped,
          sourcePath: controlSource.path,
          destinationPath: controlDestination.path,
        }, ctx.vfs, controlSource.user);
      }
      authorizeWorkspaceWrite(destinationPath, connection);
      if (ctx.workspaceFilesystem.owns(sourcePath) || ctx.workspaceFilesystem.owns(destinationPath)) {
        if (!ctx.workspaceFilesystem.owns(sourcePath) || !ctx.workspaceFilesystem.owns(destinationPath)) {
          throw new Error("copying across workspace runtime boundaries is not supported");
        }
        return ctx.workspaceFilesystem.copy(mapped, viewFor(connection));
      }
      if (ctx.virtualFilesystem.owns(sourcePath) || ctx.virtualFilesystem.owns(destinationPath)) {
        return ctx.virtualFilesystem.copy(mapped, ctx.vfs, userFor(connection));
      }
      ctx.vfs.copy(sourcePath, destinationPath, params["recursive"] === true);
      return {};
    });

    register("fs/writeFile", (params, connection) => {
      const path = clientPath(requiredString(params, "path"), connection);
      const mapped: FileOperationParams = { ...params, path };
      const encoded = typeof params["dataBase64"] === "string" ? params["dataBase64"] : "";
      const bytes = base64Decode(encoded);
      const control = userControlPath(path, connection);
      if (control) {
        return ctx.virtualFilesystem.writeFile({ ...mapped, path: control.path }, bytes, control.user);
      }
      authorizeWorkspaceWrite(path, connection);
      const user = userFor(connection);
      if (ctx.localEnvironment.acceptsFile(path)) {
        return ctx.localEnvironment.writeFile(mapped, bytes, user);
      }
      if (ctx.workspaceFilesystem.owns(path)) {
        return ctx.workspaceFilesystem.writeFile(mapped, bytes, viewFor(connection));
      }
      if (ctx.virtualFilesystem.owns(path)) return ctx.virtualFilesystem.writeFile(mapped, bytes, user);
      ctx.vfs.writeFile(path, bytes);
      return {};
    });

    register("fs/watch", (params, connection) => {
      const requestedPath = clientPath(requiredString(params, "path"), connection);
      const watchId = requiredString(params, "watchId");
      const control = userControlPath(requestedPath, connection);
      const user = userFor(connection);
      const localEnvironmentResolver: FilesystemWatchResolver = {
        owns: (path) => ctx.localEnvironment.owns(path, user),
        normalize: (path) => ctx.localEnvironment.normalize(path),
      };
      const watch = resolveFilesystemWatch(
        control?.path ?? requestedPath,
        [localEnvironmentResolver, ctx.workspaceFilesystem, ctx.virtualFilesystem],
        (path) => ctx.vfs.get(path).path,
      );
      const previous = connection.watches.get(watchId);
      if (typeof previous !== "string") previous?.stop?.();
      if (watch.routable && !control && ctx.workspaceFilesystem.owns(watch.path)) {
        const hostWatchId = `workspace-watch-${++ctx.appServer.filesystemWatchSequence}`;
        const viewId = viewFor(connection);
        try {
          ctx.workspaceFilesystem.watch(hostWatchId, watch.path, viewId);
          watch.drain = () => ctx.workspaceFilesystem.drainWatch(hostWatchId);
          watch.stop = () => ctx.workspaceFilesystem.unwatch(hostWatchId);
        } catch (error) {
          watch.routable = false;
          watch.error = error;
        }
      }
      connection.watches.set(watchId, watch);
      if (!watch.routable && !connection.unroutableWatchPaths.has(watch.path)) {
        connection.unroutableWatchPaths.add(watch.path);
        console.warn(`[filesystem] inert watch path=${watch.path} reason=${errorMessage(watch.error)}`);
      }
      return { path: watch.path };
    });

    register("fs/unwatch", (params, connection) => {
      const watchId = requiredString(params, "watchId");
      const watch = connection.watches.get(watchId);
      if (typeof watch !== "string") watch?.stop?.();
      connection.watches.delete(watchId);
      return {};
    });
  }
}
