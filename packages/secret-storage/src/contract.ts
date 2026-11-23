/**
 * Runtime-neutral secret storage. See docs/architecture/platform/storage-ports.md.
 *
 * Two shapes with different lifetimes:
 * - `SecretStore`: named, replaceable string secrets (API keys, tokens).
 *   There is no listing or bulk readback; callers resolve one name at a time.
 * - `KeyMaterial`: installation keys created once and never rotated in place
 *   (vault, signing and access keys). A second creation returns the first key.
 */

export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  /** Removing an absent name succeeds. */
  delete(name: string): Promise<void>;
  /**
   * An opaque value that changes whenever any secret changes. Readers use it to
   * detect a concurrent change between related reads; it carries no content
   * and is only comparable within one process.
   */
  stamp(): Promise<string>;
}

export interface KeyMaterial {
  /** Returns the existing key, or atomically stores `create()` and returns it. */
  ensure(name: string, create: () => Uint8Array): Promise<Uint8Array>;
  /** The existing key, or undefined. Never creates one. */
  read(name: string): Promise<Uint8Array | undefined>;
}

/** The stored secrets exist but are not in the expected layout. */
export class SecretStoreCorruptError extends Error {
  constructor() {
    super("Secret storage format is invalid");
    this.name = "SecretStoreCorruptError";
  }
}

const NAME = /^[_A-Za-z][_A-Za-z0-9]{0,127}$/u;
export function validateSecretName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !NAME.test(name)) throw new TypeError("Invalid secret name");
}
export function validateSecretValue(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || /[\r\n\0]/u.test(value)) throw new TypeError("Invalid secret value");
}
const KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export function validateKeyName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !KEY_NAME.test(name) || name.includes("..")) throw new TypeError("Invalid key name");
}

/** In-process key material for tests and runtimes without durable key storage. */
export function memoryKeyMaterial(): KeyMaterial {
  const keys = new Map<string, Uint8Array>();
  return {
    async read(name) {
      validateKeyName(name);
      const key = keys.get(name);
      return key && new Uint8Array(key);
    },
    async ensure(name, create) {
      validateKeyName(name);
      if (!keys.has(name)) {
        const key = create();
        if (!(key instanceof Uint8Array) || !key.byteLength)
          throw new TypeError("Key material must be non-empty bytes");
        keys.set(name, new Uint8Array(key));
      }
      return new Uint8Array(keys.get(name)!);
    },
  };
}
