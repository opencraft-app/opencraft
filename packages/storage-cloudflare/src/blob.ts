import {
  BlobDigestError, BlobExistsError, BlobLimitError, validateBlobKey, validateBlobLimit, validateBlobRange, validateSha256,
  type BlobObject, type BlobStore, type BlobUpload,
} from "@opencraft/blob-storage";
import type { DigestStreamConstructor, R2Bucket, R2MultipartUpload, R2UploadedPart } from "./bindings.js";

export interface R2BlobStoreOptions {
  /** Key prefix (a valid blob key) that scopes this store inside the bucket. */
  readonly prefix?: string;
  /**
   * Bytes buffered before a multipart part is sent. Bodies that fit in one
   * part are written with a single conditional `put`. R2 requires at least
   * 5 MiB for every part but the last, and equal sizes for all of them.
   */
  readonly partBytes?: number;
}

const MIN_PART_BYTES = 5 * 1024 * 1024;
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function emptyBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
}

function digestStream(): DigestStreamConstructor {
  const constructor = (crypto as unknown as { DigestStream?: DigestStreamConstructor }).DigestStream;
  if (!constructor) throw new Error("The R2 blob store requires workerd's crypto.DigestStream");
  return constructor;
}

/**
 * Immutable blobs in an R2 bucket.
 *
 * Bytes are hashed incrementally while they arrive and at most one part is
 * buffered. A body that fits in one part is committed with one `put` carrying
 * the verified SHA-256 (R2 re-checks it) and `onlyIf: { etagDoesNotMatch: "*" }`,
 * so an existing key is rejected atomically by R2. Larger bodies go through a
 * multipart upload that stays invisible until `complete()`; the digest and size
 * are verified before completing, and a failed or abandoned upload is aborted
 * (or expires under the bucket's incomplete-upload lifecycle) without leaving
 * an object. The Workers binding cannot attach a condition to multipart
 * completion, so for those bodies the existing-key check is a `head` before
 * `complete()`, serialized per key within this store instance; a writer
 * outside this store's owner can still race it.
 */
export function r2BlobStore(bucket: R2Bucket, options: R2BlobStoreOptions = {}): BlobStore {
  if (options.prefix !== undefined) validateBlobKey(options.prefix);
  const partBytes = options.partBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(partBytes) || partBytes < MIN_PART_BYTES) throw new RangeError("R2 parts must be at least 5 MiB");
  const location = (key: string) => {
    validateBlobKey(key);
    return options.prefix === undefined ? key : `${options.prefix}/${key}`;
  };

  const commits = new Map<string, Promise<unknown>>();
  const exclusive = <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const run = (commits.get(key) ?? Promise.resolve()).then(action, action);
    const settled = run.catch(() => undefined);
    commits.set(key, settled);
    void settled.then(() => { if (commits.get(key) === settled) commits.delete(key); });
    return run;
  };

  const begin = (key: string, maxBytes: number): BlobUpload => {
    const target = location(key);
    validateBlobLimit(maxBytes);
    const hasher = new (digestStream())("SHA-256");
    const digest = hasher.getWriter();
    const pending: Uint8Array[] = [];
    const parts: R2UploadedPart[] = [];
    let pendingBytes = 0, size = 0, finished = false;
    let multipart: R2MultipartUpload | undefined;

    const discard = async () => {
      finished = true;
      await digest.abort().catch(() => undefined);
      await multipart?.abort().catch(() => undefined);
    };
    const flushPart = async () => {
      const bytes = concat(pending, pendingBytes);
      pending.length = 0;
      pending.push(bytes.subarray(partBytes));
      pendingBytes = bytes.byteLength - partBytes;
      multipart ??= await bucket.createMultipartUpload(target);
      parts.push(await multipart.uploadPart(parts.length + 1, bytes.slice(0, partBytes)));
    };
    const guard = async <T>(action: () => Promise<T>): Promise<T> => {
      try { return await action(); } catch (error) { await discard(); throw error; }
    };

    return {
      async write(chunk) {
        if (finished) throw new Error("Blob upload is finished");
        if (!(chunk instanceof Uint8Array)) throw new TypeError("Blob chunks must be bytes");
        if (size + chunk.byteLength > maxBytes) { await discard(); throw new BlobLimitError(); }
        await guard(async () => {
          const copy = new Uint8Array(chunk);
          await digest.write(copy);
          pending.push(copy);
          pendingBytes += copy.byteLength;
          size += copy.byteLength;
          while (pendingBytes >= partBytes) await flushPart();
        });
      },
      async complete(completion = {}) {
        if (finished) throw new Error("Blob upload is finished");
        finished = true;
        return guard(async () => {
          if (completion.sha256 !== undefined) validateSha256(completion.sha256);
          await digest.close();
          const sha256 = hex(await hasher.digest);
          if (completion.sha256 !== undefined && completion.sha256 !== sha256) throw new BlobDigestError();
          const rest = concat(pending, pendingBytes);
          if (!multipart) {
            const stored = await bucket.put(target, rest, { sha256, onlyIf: { etagDoesNotMatch: "*" } });
            if (!stored) throw new BlobExistsError(key);
          } else {
            if (rest.byteLength) parts.push(await multipart.uploadPart(parts.length + 1, rest));
            const upload = multipart;
            await exclusive(target, async () => {
              if (await bucket.head(target)) throw new BlobExistsError(key);
              await upload.complete(parts);
            });
          }
          return { key, size, sha256 };
        });
      },
      abort: discard,
    };
  };

  return {
    async upload(key, uploadOptions) {
      return begin(key, uploadOptions.maxBytes);
    },
    async put(key, body, putOptions) {
      const target = location(key);
      validateBlobLimit(putOptions.maxBytes);
      if (putOptions.sha256 !== undefined) validateSha256(putOptions.sha256);
      if (await bucket.head(target)) throw new BlobExistsError(key);
      const upload = begin(key, putOptions.maxBytes);
      if (body instanceof Uint8Array) {
        await upload.write(body);
      } else {
        const reader = body.getReader();
        try {
          for (let next = await reader.read(); !next.done; next = await reader.read()) await upload.write(next.value);
        } catch (error) {
          await upload.abort();
          await reader.cancel(error).catch(() => undefined);
          throw error;
        }
      }
      return upload.complete(putOptions.sha256 === undefined ? {} : { sha256: putOptions.sha256 });
    },
    async get(key, range): Promise<BlobObject | null> {
      const target = location(key);
      validateBlobRange(range);
      if (!range) {
        const object = await bucket.get(target);
        return object && { key, size: object.size, body: object.body };
      }
      try {
        const object = await bucket.get(target, { range: range.length === undefined ? { offset: range.offset } : { offset: range.offset, length: range.length } });
        if (object) return { key, size: object.size, body: object.body };
      } catch (error) {
        // R2 rejects empty ranges (at or past the end, or zero length); the port clamps them to no bytes.
        const stat = await bucket.head(target);
        if (stat && (range.offset >= stat.size || range.length === 0)) return { key, size: stat.size, body: emptyBody() };
        if (stat) throw error;
      }
      return null;
    },
    async head(key) {
      const object = await bucket.head(location(key));
      return object && { key, size: object.size };
    },
    async delete(key) {
      await bucket.delete(location(key));
    },
  };
}
