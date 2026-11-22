import { createHash, randomUUID, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import {
  BlobDigestError, BlobExistsError, BlobLimitError, validateBlobKey, validateBlobLimit, validateBlobRange, validateSha256,
  type BlobStat, type BlobStore, type BlobUpload,
} from "./contract.js";

const STAGING = ".staging";

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Node adapter: one private file per key under `root`. Bytes are staged in
 * `root/.staging`, fsynced, then published with a create-only hard link and a
 * directory fsync, so a key is either absent or complete.
 */
export function fileBlobStore(root: string): BlobStore {
  const path = (key: string) => (validateBlobKey(key), join(root, key));
  const head = async (key: string): Promise<BlobStat | null> => {
    const file = path(key);
    try {
      const info = await stat(file);
      if (!info.isFile()) return null;
      return { key, size: info.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const begin = async (key: string, maxBytes: number): Promise<BlobUpload> => {
    const target = path(key);
    validateBlobLimit(maxBytes);
    await mkdir(join(root, STAGING), { recursive: true, mode: 0o700 });
    const staged = join(root, STAGING, randomUUID());
    let handle: FileHandle | undefined = await open(staged, "wx", 0o600);
    const hash: Hash = createHash("sha256");
    let size = 0, finished = false, writing: Promise<void> = Promise.resolve();
    const discard = async () => {
      finished = true;
      await handle?.close().catch(() => undefined);
      handle = undefined;
      await unlink(staged).catch(() => undefined);
    };
    return {
      write(chunk) {
        writing = writing.then(async () => {
          if (finished || !handle) throw new Error("Blob upload is finished");
          if (!(chunk instanceof Uint8Array)) throw new TypeError("Blob chunks must be bytes");
          if (size + chunk.byteLength > maxBytes) { await discard(); throw new BlobLimitError(); }
          await handle.write(chunk);
          hash.update(chunk);
          size += chunk.byteLength;
        });
        return writing;
      },
      async complete(options = {}) {
        await writing;
        if (finished || !handle) throw new Error("Blob upload is finished");
        if (options.sha256 !== undefined) validateSha256(options.sha256);
        const sha256 = hash.digest("hex");
        try {
          if (options.sha256 !== undefined && options.sha256 !== sha256) throw new BlobDigestError();
          await handle.sync();
          await handle.close();
          handle = undefined;
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          try {
            await link(staged, target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BlobExistsError(key);
            throw error;
          }
          await syncDirectory(dirname(target));
          return { key, size, sha256 };
        } finally {
          await discard();
        }
      },
      abort: () => writing.catch(() => undefined).then(discard),
    };
  };
  return {
    head,
    upload: (key, options) => begin(key, options.maxBytes),
    async put(key, body, options) {
      validateBlobLimit(options.maxBytes);
      if (options.sha256 !== undefined) validateSha256(options.sha256);
      if (await head(key)) throw new BlobExistsError(key);
      const upload = await begin(key, options.maxBytes);
      try {
        if (body instanceof Uint8Array) await upload.write(body);
        else for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) await upload.write(chunk);
      } catch (error) {
        await upload.abort();
        throw error;
      }
      return upload.complete(options.sha256 === undefined ? {} : { sha256: options.sha256 });
    },
    async get(key, range) {
      validateBlobRange(range);
      const info = await head(key);
      if (!info) return null;
      const start = Math.min(range?.offset ?? 0, info.size);
      const end = range?.length === undefined ? info.size : Math.min(info.size, start + range.length);
      const body = end > start
        ? Readable.toWeb(createReadStream(path(key), { start, end: end - 1 })) as ReadableStream<Uint8Array>
        : new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
      return { ...info, body };
    },
    async delete(key) {
      const file = path(key);
      try {
        await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      await syncDirectory(dirname(file));
    },
  };
}
