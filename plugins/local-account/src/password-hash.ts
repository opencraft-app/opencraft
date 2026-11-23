// Local-account password records (official server plugin `opencraft.account`).
// New records are Argon2id PHC strings stored in `password_digest` with an
// empty `salt` column; the salt and every cost parameter travel inside the
// string. Records written before Argon2id are scrypt: a non-empty `salt` text
// and a 64-hex-character digest. The two shapes cannot be confused.
// Runtime-neutral: each runtime supplies only the Argon2id primitive.

/** The stored columns a password check reads. */
export interface StoredPassword {
  readonly salt: string;
  readonly passwordDigest: string;
}
export interface PasswordVerification {
  readonly ok: boolean;
  /** The password matched a record weaker than the current parameters (scrypt or older Argon2id). */
  readonly needsRehash: boolean;
}
/** Composition-selected password hashing port; both runtimes read and write the same PHC format. */
export interface PasswordHasher {
  /** A new Argon2id PHC string at the current parameters. Store it with an empty salt column. */
  hash(password: string): Promise<string>;
  verify(password: string, record: StoredPassword): Promise<PasswordVerification>;
}

export interface Argon2idParameters {
  /** Memory in KiB. */
  readonly m: number;
  readonly t: number;
  readonly p: number;
}
/** OWASP minimum Argon2id configuration: 19 MiB, 2 passes, 1 lane. */
export const ARGON2ID_PARAMETERS: Argon2idParameters = Object.freeze({ m: 19456, t: 2, p: 1 });
const SALT_BYTES = 16;
const TAG_BYTES = 32;
// Records come from trusted storage, but a crafted or corrupted record must not
// make one login allocate or spin without bound. 64 MiB stays below the
// Workers isolate limit; anything outside these bounds is rejected unhashed.
export const ARGON2ID_LIMITS = Object.freeze({ maxMemoryKiB: 65536, maxPasses: 10, maxLanes: 4, minBytes: 16, maxBytes: 64, maxLength: 256 });

export interface Argon2idPrimitive {
  derive(password: Uint8Array, salt: Uint8Array, parameters: Argon2idParameters, tagLength: number): Promise<Uint8Array>;
  randomBytes(length: number): Uint8Array;
}
/** Verifies a pre-Argon2id scrypt record; absent where none can exist (fresh Cloudflare installations). */
export type LegacyPasswordVerifier = (password: string, record: StoredPassword) => Promise<boolean>;

const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/u, '');
function unbase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+$/u.test(text) || text.length % 4 === 1) return null;
  let binary: string;
  try { binary = atob(text + '='.repeat((4 - text.length % 4) % 4)); } catch { return null; }
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return base64(bytes) === text ? bytes : null; // canonical encoding only
}

export interface Argon2idRecord {
  readonly parameters: Argon2idParameters;
  readonly salt: Uint8Array;
  readonly tag: Uint8Array;
}
const PHC = /^\$argon2id\$v=19\$m=([1-9][0-9]{0,7}),t=([1-9][0-9]{0,2}),p=([1-9][0-9]{0,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u;

export function formatArgon2id(record: Argon2idRecord): string {
  const { m, t, p } = record.parameters;
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${base64(record.salt)}$${base64(record.tag)}`;
}
/** Strict PHC parser: only Argon2id v=19, bounded parameters, canonical unpadded base64. */
export function parseArgon2id(text: string): Argon2idRecord | null {
  if (typeof text !== 'string' || text.length > ARGON2ID_LIMITS.maxLength) return null;
  const match = PHC.exec(text);
  if (!match) return null;
  const [m, t, p] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  if (p > ARGON2ID_LIMITS.maxLanes || t > ARGON2ID_LIMITS.maxPasses || m > ARGON2ID_LIMITS.maxMemoryKiB || m < 8 * p) return null;
  const salt = unbase64(match[4]!), tag = unbase64(match[5]!);
  const sized = (bytes: Uint8Array | null) => !!bytes && bytes.length >= ARGON2ID_LIMITS.minBytes && bytes.length <= ARGON2ID_LIMITS.maxBytes;
  if (!sized(salt) || !sized(tag)) return null;
  return { parameters: { m, t, p }, salt: salt!, tag: tag! };
}

const LEGACY_SCRYPT_DIGEST = /^[0-9a-f]{64}$/u;
export type StoredPasswordShape = 'argon2id' | 'scrypt' | 'invalid';
export function storedPasswordShape(record: StoredPassword): StoredPasswordShape {
  if (record.salt === '' && parseArgon2id(record.passwordDigest)) return 'argon2id';
  if (typeof record.salt === 'string' && record.salt !== '' && LEGACY_SCRYPT_DIGEST.test(record.passwordDigest)) return 'scrypt';
  return 'invalid';
}

function weakerThanCurrent(record: Argon2idRecord): boolean {
  return record.parameters.m < ARGON2ID_PARAMETERS.m || record.parameters.t < ARGON2ID_PARAMETERS.t
    || record.salt.length < SALT_BYTES || record.tag.length < TAG_BYTES;
}
function equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

/**
 * Checked against when no account matches, so an unknown username costs one
 * Argon2id derivation at the current parameters, like a real account.
 */
export const UNKNOWN_ACCOUNT_PASSWORD: StoredPassword = Object.freeze({
  salt: '',
  passwordDigest: formatArgon2id({ parameters: ARGON2ID_PARAMETERS, salt: encoder.encode('opencraft-unknown-account'), tag: new Uint8Array(TAG_BYTES) }),
});

export function createArgon2idHasher(primitive: Argon2idPrimitive, legacy?: LegacyPasswordVerifier): PasswordHasher {
  const derive = (password: string, record: Argon2idRecord) =>
    primitive.derive(encoder.encode(password), record.salt, record.parameters, record.tag.length);
  const dummy = parseArgon2id(UNKNOWN_ACCOUNT_PASSWORD.passwordDigest)!;
  return Object.freeze({
    async hash(password: string) {
      const salt = primitive.randomBytes(SALT_BYTES);
      const tag = await primitive.derive(encoder.encode(password), salt, ARGON2ID_PARAMETERS, TAG_BYTES);
      return formatArgon2id({ parameters: ARGON2ID_PARAMETERS, salt, tag });
    },
    async verify(password: string, record: StoredPassword): Promise<PasswordVerification> {
      const shape = storedPasswordShape(record);
      if (shape === 'scrypt') {
        if (!legacy) throw new Error('Legacy password record unsupported by this runtime');
        const ok = await legacy(password, record);
        return { ok, needsRehash: ok };
      }
      if (shape === 'invalid') {
        await derive(password, dummy); // corrupt record: same cost, never a match
        return { ok: false, needsRehash: false };
      }
      const parsed = parseArgon2id(record.passwordDigest)!;
      const ok = equal(await derive(password, parsed), parsed.tag);
      return { ok, needsRehash: ok && weakerThanCurrent(parsed) };
    },
  });
}
