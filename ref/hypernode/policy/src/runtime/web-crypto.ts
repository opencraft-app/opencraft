import { sha256 as nobleSha256 } from "@noble/hashes/sha256";

type DigestAlgorithm = string | { readonly name?: unknown };
type IntegerTypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array;

interface DeferredDigest {
  resolve(value: ArrayBuffer): void;
  reject(reason: Error): void;
}

interface SubtleCryptoTarget {
  digest?: (algorithm: DigestAlgorithm, input: unknown) => Promise<ArrayBuffer>;
}

interface WebCryptoTarget extends Crypto {
  getRandomValues?: (array: IntegerTypedArray) => IntegerTypedArray;
  subtle?: SubtleCryptoTarget;
}

const pending = new Map<string, DeferredDigest>();

function normalizeAlgorithm(algorithm: DigestAlgorithm): string {
  const name = typeof algorithm === "string" ? algorithm : algorithm.name;
  return String(name ?? "").toUpperCase();
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) {
    return Uint8Array.from(value);
  }
  return new Uint8Array();
}

function fallbackDigest(algorithm: DigestAlgorithm, input: unknown): Promise<ArrayBuffer> {
  if (normalizeAlgorithm(algorithm) !== "SHA-256") {
    return Promise.reject(
      new Error(`unsupported digest algorithm: ${normalizeAlgorithm(algorithm)}`),
    );
  }
  // Promise scheduling preserves the Web Crypto contract. This fallback is
  // deliberately portable, but native host jobs are preferred because they do
  // not spend the QuickJS turn hashing large buffers.
  return Promise.resolve().then(() => Uint8Array.from(nobleSha256(bytes(input))).buffer);
}

function digest(algorithm: DigestAlgorithm, input: unknown): Promise<ArrayBuffer> {
  const normalized = normalizeAlgorithm(algorithm);
  if (normalized !== "SHA-256") return fallbackDigest(normalized, input);
  if (typeof hostWebCrypto !== "object" || typeof hostWebCrypto.submitDigest !== "function") {
    return fallbackDigest(normalized, input);
  }
  try {
    const id = hostWebCrypto.submitDigest(normalized, bytes(input));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[web-crypto] native digest unavailable reason=${reason}`);
    return fallbackDigest(normalized, input);
  }
}

export function installWebCrypto(): void {
  const target = globalThis.crypto as WebCryptoTarget;
  if (typeof target.getRandomValues !== "function") {
    target.getRandomValues = (array) => {
      const hex = target.randomBytes(array.byteLength);
      for (let index = 0; index < array.byteLength; index += 1) {
        array[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      }
      return array;
    };
  }
  const nativeSubtle = target.subtle && typeof target.subtle === "object" ? target.subtle : {};
  Object.defineProperty(nativeSubtle, "digest", {
    configurable: true,
    enumerable: true,
    value: digest,
  });
  Object.defineProperty(target, "subtle", {
    configurable: true,
    enumerable: true,
    value: nativeSubtle,
  });
  globalThis.crypto = target;
}

export function drainWebCrypto(): number {
  if (typeof hostWebCrypto !== "object" || typeof hostWebCrypto.drain !== "function") return 0;
  let completed = 0;
  for (const result of hostWebCrypto.drain()) {
    const deferred = pending.get(result.id);
    if (!deferred) continue;
    pending.delete(result.id);
    completed += 1;
    if (result.error) deferred.reject(new Error(result.error));
    else deferred.resolve(Uint8Array.from(result.bytes ?? []).buffer);
  }
  return completed;
}
