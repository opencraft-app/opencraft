import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { posix } from "node:path";

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export const fileDescriptorPath = (file: FileHandle) => `/proc/self/fd/${file.fd}`;

export function isScopedFilePath(root: string, path: string): boolean {
  return (
    root !== "/" &&
    root.startsWith("/") &&
    posix.normalize(root) === root &&
    (path === root || path.startsWith(root + "/")) &&
    posix.normalize(path) === path &&
    !path.endsWith("/") &&
    !/[\\\x00-\x1f\x7f]/u.test(path)
  );
}

/**
 * Pin every directory before opening the next component. The final syscall
 * may use the path only while the parent descriptor is owned by this call.
 */
export async function withScopedFilePath<T>(
  root: string,
  path: string,
  signal: AbortSignal,
  run: (target: string, parent: FileHandle) => Promise<T>,
): Promise<T> {
  if (process.platform !== "linux" || !isScopedFilePath(root, path)) throw Error("File outside workspace");
  const segments = (path === root ? root : posix.dirname(path)).split("/").slice(1);
  let directory = await open("/", DIRECTORY);
  try {
    for (const segment of segments) {
      signal.throwIfAborted();
      const child = await open(fileDescriptorPath(directory) + "/" + segment, DIRECTORY);
      const previous = directory;
      directory = child;
      await previous.close();
    }
    signal.throwIfAborted();
    return await run(fileDescriptorPath(directory) + "/" + (path === root ? "." : posix.basename(path)), directory);
  } finally {
    await directory.close();
  }
}
