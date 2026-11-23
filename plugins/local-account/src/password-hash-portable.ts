// Runtime-neutral composition (Cloudflare Workers, no native Argon2 and no
// runtime WebAssembly compilation): pure-JS Argon2id from @noble/hashes.
// Cloudflare installations are fresh, so no scrypt record can exist there.
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { createArgon2idHasher, type PasswordHasher } from "./password-hash.js";

export function createPortablePasswordHasher(): PasswordHasher {
  return createArgon2idHasher({
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    // maxmem bounds the working set to the parsed record's memory cost plus overhead.
    derive: (password, salt, { m, t, p }, dkLen) =>
      argon2idAsync(password, salt, { m, t, p, dkLen, maxmem: m * 1024 + 1024 * 1024 }),
  });
}
