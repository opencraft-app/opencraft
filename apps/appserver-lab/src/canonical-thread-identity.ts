import {
  mkdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

export interface CanonicalThreadIdentity {
  version: 1;
  threadId: string;
  createdAtMs: number;
}

export interface CanonicalThreadResolution {
  identity: CanonicalThreadIdentity;
  created: boolean;
}

export interface ResolveCanonicalThreadOptions {
  identityFile: string;
  create(): Promise<string>;
  lockTimeoutMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isExistingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function parseIdentity(value: unknown, identityFile: string): CanonicalThreadIdentity {
  if (
    typeof value !== "object"
    || value === null
    || !("version" in value)
    || value.version !== 1
    || !("threadId" in value)
    || typeof value.threadId !== "string"
    || value.threadId.length === 0
    || !("createdAtMs" in value)
    || typeof value.createdAtMs !== "number"
    || !Number.isFinite(value.createdAtMs)
  ) {
    throw new Error(`Invalid canonical AppServer thread identity in ${identityFile}`);
  }
  return {
    version: 1,
    threadId: value.threadId,
    createdAtMs: value.createdAtMs,
  };
}

export async function readCanonicalThreadIdentity(
  identityFile: string,
): Promise<CanonicalThreadIdentity | null> {
  try {
    return parseIdentity(JSON.parse(await readFile(identityFile, "utf8")) as unknown, identityFile);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

/**
 * Creates at most one canonical Thread for one identity file. The file lock is
 * acquired before `thread/start`, so concurrent Lab processes cannot both
 * create a different server-owned ID.
 */
export async function resolveCanonicalThread(
  options: ResolveCanonicalThreadOptions,
): Promise<CanonicalThreadResolution> {
  const existing = await readCanonicalThreadIdentity(options.identityFile);
  if (existing !== null) return { identity: existing, created: false };

  await mkdir(dirname(options.identityFile), { recursive: true });
  const lockPath = `${options.identityFile}.lock`;
  const lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs)));
  const deadline = now() + lockTimeoutMs;
  let ownsLock = false;

  while (!ownsLock) {
    const identity = await readCanonicalThreadIdentity(options.identityFile);
    if (identity !== null) return { identity, created: false };
    try {
      await mkdir(lockPath);
      ownsLock = true;
    } catch (error) {
      if (!isExistingPath(error)) throw error;
      if (now() >= deadline) {
        throw new Error(`Timed out waiting for canonical Thread lock ${lockPath}`);
      }
      await sleep(Math.min(25, Math.max(1, deadline - now())));
    }
  }

  const temporaryFile = `${options.identityFile}.${process.pid}.${now()}.tmp`;
  try {
    const identityAfterLock = await readCanonicalThreadIdentity(options.identityFile);
    if (identityAfterLock !== null) return { identity: identityAfterLock, created: false };
    const threadId = await options.create();
    if (threadId.length === 0) throw new Error("thread/start returned an empty canonical Thread ID");
    const identity: CanonicalThreadIdentity = {
      version: 1,
      threadId,
      createdAtMs: now(),
    };
    await writeFile(temporaryFile, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryFile, options.identityFile);
    return { identity, created: true };
  } finally {
    await unlink(temporaryFile).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
    await rmdir(lockPath).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }
}
