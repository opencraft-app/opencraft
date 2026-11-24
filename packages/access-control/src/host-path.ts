// Absolute-path check without node:path, for domain code that validates a
// path it only forwards (a conversation's working directory on its Host).
const windowsHost = (globalThis as { process?: { platform?: unknown } }).process?.platform === "win32";

/**
 * Same answer as `node:path`'s `isAbsolute` in the running process: Windows
 * rules (a leading slash or backslash, or a drive letter followed by one)
 * when the host process is Windows, POSIX rules (a leading `/`) otherwise,
 * including in runtimes without a host process.
 */
export function isAbsoluteHostPath(path: string): boolean {
  if (!windowsHost) return path.startsWith("/");
  return /^[\\/]/u.test(path) || /^[A-Za-z]:[\\/]/u.test(path);
}
