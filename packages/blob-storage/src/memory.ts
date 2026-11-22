import {
  BlobDigestError, BlobExistsError, BlobLimitError, validateBlobKey, validateBlobLimit, validateBlobRange, validateSha256,
  type BlobStore, type BlobUpload,
} from "./contract.js";

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** In-process adapter for tests and runtimes without durable object storage. */
export function memoryBlobStore(): BlobStore {
  const objects = new Map<string, Uint8Array>();
  const begin = async (key: string, maxBytes: number): Promise<BlobUpload> => {
    validateBlobKey(key);
    validateBlobLimit(maxBytes);
    const chunks: Uint8Array[] = [];
    let size = 0, finished = false;
    return {
      async write(chunk) {
        if (finished) throw new Error("Blob upload is finished");
        if (!(chunk instanceof Uint8Array)) throw new TypeError("Blob chunks must be bytes");
        if (size + chunk.byteLength > maxBytes) { finished = true; throw new BlobLimitError(); }
        chunks.push(new Uint8Array(chunk));
        size += chunk.byteLength;
      },
      async complete(options = {}) {
        if (finished) throw new Error("Blob upload is finished");
        finished = true;
        if (options.sha256 !== undefined) validateSha256(options.sha256);
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
        if (options.sha256 !== undefined && options.sha256 !== sha256) throw new BlobDigestError();
        if (objects.has(key)) throw new BlobExistsError(key);
        objects.set(key, bytes);
        return { key, size, sha256 };
      },
      async abort() { finished = true; },
    };
  };
  return {
    upload: (key, options) => begin(key, options.maxBytes),
    async put(key, body, options) {
      validateBlobKey(key);
      if (objects.has(key)) throw new BlobExistsError(key);
      const upload = await begin(key, options.maxBytes);
      if (body instanceof Uint8Array) await upload.write(body);
      else for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) await upload.write(chunk);
      return upload.complete(options.sha256 === undefined ? {} : { sha256: options.sha256 });
    },
    async head(key) {
      validateBlobKey(key);
      const bytes = objects.get(key);
      return bytes ? { key, size: bytes.byteLength } : null;
    },
    async get(key, range) {
      validateBlobKey(key);
      validateBlobRange(range);
      const bytes = objects.get(key);
      if (!bytes) return null;
      const start = Math.min(range?.offset ?? 0, bytes.byteLength);
      const end = range?.length === undefined ? bytes.byteLength : Math.min(bytes.byteLength, start + range.length);
      const slice = bytes.slice(start, end);
      return { key, size: bytes.byteLength, body: new ReadableStream<Uint8Array>({ start(controller) { if (slice.byteLength) controller.enqueue(slice); controller.close(); } }) };
    },
    async delete(key) { validateBlobKey(key); objects.delete(key); },
  };
}
