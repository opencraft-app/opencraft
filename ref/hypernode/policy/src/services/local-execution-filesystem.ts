import type {
  LocalRuntimeFilesystemPort,
} from "../types/workspace.ts";
import type {
  TransparentBackendFilesystemPort,
} from "../types/transparent-backend.ts";

const LOCAL_ROOT = "/localhost";
const PUBLIC_CODEX_HOME = "/workspace/.codex";
const LOCAL_CODEX_HOME = `${LOCAL_ROOT}/.codex`;

function isPublicCodexPath(path: string): boolean {
  return path === PUBLIC_CODEX_HOME || path.startsWith(`${PUBLIC_CODEX_HOME}/`);
}

function toLocalPath(path: string): string {
  return isPublicCodexPath(path)
    ? `${LOCAL_CODEX_HOME}${path.slice(PUBLIC_CODEX_HOME.length)}`
    : path;
}

/**
 * Execution-only alias for a user's durable Codex home.
 *
 * Public filesystem browsing remains rooted at `/localhost`; execution
 * runtimes additionally resolve `/workspace/.codex` without widening the
 * public VFS namespace.
 */
export function createLocalExecutionFilesystem(
  filesystem: LocalRuntimeFilesystemPort,
): TransparentBackendFilesystemPort {
  return {
    ...(filesystem.enabled === undefined ? {} : { enabled: filesystem.enabled }),
    ...(filesystem.mount === undefined ? {} : { mount: filesystem.mount }),
    normalize: (path) => filesystem.normalize(path),
    owns: (path) => isPublicCodexPath(path) || filesystem.owns(path),
    toPhysical: (path, user = null, viewId = "main") =>
      filesystem.toPhysical(toLocalPath(path), user, viewId),
    toVirtual: (path, user = null, viewId = "main") => {
      const value = filesystem.toVirtual(path, user, viewId);
      return value === LOCAL_CODEX_HOME || value.startsWith(`${LOCAL_CODEX_HOME}/`)
        ? `${PUBLIC_CODEX_HOME}${value.slice(LOCAL_CODEX_HOME.length)}`
        : value;
    },
    ensureWorkingDirectory: (path, user = null, viewId = "main") =>
      filesystem.ensureWorkingDirectory(toLocalPath(path), user, viewId),
    spawnAppServer: (processId, cwd, user = null, viewId = "main", providerId = null) =>
      filesystem.spawnAppServer(processId, toLocalPath(cwd), user, viewId, providerId),
    spawnThreadRuntime: (
      processId,
      cwd,
      user = null,
      viewId = "main",
      runtimeId = processId,
      providerId = null,
    ) => filesystem.spawnThreadRuntime(
      processId,
      toLocalPath(cwd),
      user,
      viewId,
      runtimeId,
      providerId,
    ),
    send: (processId, message) => filesystem.send(processId, message),
    drain: (processId) => filesystem.drain(processId),
    kill: (processId) => filesystem.kill(processId),
    terminateThreadRuntime: (processId, viewId, threadId, timeoutMs) =>
      filesystem.terminateThreadRuntime(processId, viewId, threadId, timeoutMs),
  };
}
