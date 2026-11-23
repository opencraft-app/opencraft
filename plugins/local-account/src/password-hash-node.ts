// Node composition: native node:crypto Argon2id (libuv thread pool, never the
// calling event loop) plus the pre-Argon2id scrypt verifier for existing records.
import * as crypto from 'node:crypto';
import { createArgon2idHasher, type PasswordHasher, type StoredPassword } from './password-hash.js';

type Argon2 = (algorithm: 'argon2id', parameters: {
  message: Uint8Array; nonce: Uint8Array; parallelism: number; tagLength: number; memory: number; passes: number;
}, callback: (error: Error | null, derived: Buffer) => void) => void;

/** Published scrypt parameters; verify-only, kept exactly as records were written. */
function legacyScrypt(password: string, record: StoredPassword): Promise<boolean> {
  return new Promise((resolve, reject) => crypto.scrypt(password, record.salt, 32,
    { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }, (error, derived) => {
      if (error) { reject(error); return; }
      const expected = Buffer.from(record.passwordDigest, 'hex');
      resolve(expected.length === derived.length && crypto.timingSafeEqual(derived, expected));
    }));
}

export function createNodePasswordHasher(): PasswordHasher {
  const argon2 = (crypto as unknown as { argon2?: Argon2 }).argon2;
  if (typeof argon2 !== 'function') throw new Error('node:crypto Argon2id unavailable');
  return createArgon2idHasher({
    randomBytes: length => new Uint8Array(crypto.randomBytes(length)),
    derive: (message, nonce, { m, t, p }, tagLength) => new Promise((resolve, reject) => argon2('argon2id',
      { message, nonce, parallelism: p, tagLength, memory: m, passes: t },
      (error, derived) => error ? reject(error) : resolve(new Uint8Array(derived)))),
  }, legacyScrypt);
}
