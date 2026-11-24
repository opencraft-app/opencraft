// Runtime-neutral digests, random tokens and byte encodings for the
// access-control domain stores. Imports no node:* module and uses no Buffer,
// so the stores run unchanged in a Node owner Worker and in a single-writer
// isolate without Node compatibility.
import { sha256 as portableSha256 } from "@noble/hashes/sha2.js";

type Digest = (data: string | Uint8Array) => Uint8Array;

const encoder = new TextEncoder();

/**
 * The host's native SHA-256, when the runtime exposes its built-in modules
 * synchronously (Node's `process.getBuiltinModule`). Probed, never imported:
 * without it the portable implementation gives the same digest.
 */
function hostDigest(): Digest | undefined {
  try {
    const host = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const crypto = host?.getBuiltinModule?.("crypto") as
      { createHash?: (name: string) => { update(data: string | Uint8Array): { digest(): Uint8Array } } } | undefined;
    const createHash = crypto?.createHash;
    if (typeof createHash !== "function") return undefined;
    return (data) => new Uint8Array(createHash("sha256").update(data).digest());
  } catch {
    return undefined;
  }
}

const portableDigest: Digest = (data) => portableSha256(typeof data === "string" ? encoder.encode(data) : data);
const digest: Digest = hostDigest() ?? portableDigest;

/** SHA-256 of UTF-8 text or bytes. */
export function sha256(data: string | Uint8Array): Uint8Array {
  return digest(data);
}

/** Lowercase hex SHA-256 of UTF-8 text or bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(digest(data));
}

/** The portable SHA-256 alone, for tests that compare it with the host's. */
export const portableSha256Hex = (data: string | Uint8Array): string => bytesToHex(portableDigest(data));

/** A random version 4 UUID from the runtime's Web Crypto. */
export function randomUUID(): string {
  return crypto.randomUUID();
}

/** `size` random bytes from the runtime's CSPRNG, as unpadded base64url. */
export function randomToken(size = 32): string {
  return encodeBase64Url(randomBytes(size));
}

export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  // getRandomValues fills at most 65536 bytes per call.
  for (let offset = 0; offset < size; offset += 65536)
    crypto.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65536)));
  return bytes;
}

/** Compares two byte sequences in time independent of where they differ. Unequal lengths are unequal. */
export function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0"));

export function bytesToHex(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += HEX[byte];
  return text;
}

/** Decodes hex the way Node's `Buffer.from(text, "hex")` does: it stops at the first invalid pair. */
export function hexToBytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index + 1 < text.length; index += 2) {
    const pair = text.slice(index, index + 2);
    if (!/^[0-9a-fA-F]{2}$/u.test(pair)) break;
    bytes.push(Number.parseInt(pair, 16));
  }
  return Uint8Array.from(bytes);
}

/** UTF-8 byte length, counting an unpaired surrogate as its 3-byte replacement character. */
export function utf8ByteLength(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        index++;
      } else length += 3;
    } else length += 3;
  }
  return length;
}

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** UTF-8 to text with replacement characters and any BOM kept, as `Buffer#toString("utf8")`. */
export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DECODE = new Int16Array(128).fill(-1);
for (let index = 0; index < 64; index++) DECODE[ALPHABET.charCodeAt(index)] = index;
// Like Node, both alphabets decode either way.
DECODE["-".charCodeAt(0)] = 62;
DECODE["_".charCodeAt(0)] = 63;

type NativeBase64 = (options: { alphabet: "base64" | "base64url"; omitPadding: boolean }) => string;

function encode(bytes: Uint8Array, url: boolean): string {
  // ES2026 `Uint8Array#toBase64` where the runtime has it; same output.
  const native = (bytes as Uint8Array & { toBase64?: NativeBase64 }).toBase64;
  if (typeof native === "function")
    return native.call(bytes, { alphabet: url ? "base64url" : "base64", omitPadding: url });
  const table = url ? ALPHABET.slice(0, 62) + "-_" : ALPHABET;
  let text = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const value = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    text += table[value >> 18]! + table[(value >> 12) & 63]! + table[(value >> 6) & 63]! + table[value & 63]!;
  }
  const rest = bytes.length - index;
  if (rest === 1) {
    const value = bytes[index]! << 16;
    text += table[value >> 18]! + table[(value >> 12) & 63]! + (url ? "" : "==");
  } else if (rest === 2) {
    const value = (bytes[index]! << 16) | (bytes[index + 1]! << 8);
    text += table[value >> 18]! + table[(value >> 12) & 63]! + table[(value >> 6) & 63]! + (url ? "" : "=");
  }
  return text;
}

/** Padded standard base64, as `Buffer#toString("base64")`. */
export function encodeBase64(bytes: Uint8Array): string {
  return encode(bytes, false);
}

/** Unpadded base64url of bytes or UTF-8 text, as `Buffer#toString("base64url")`. */
export function encodeBase64Url(data: Uint8Array | string): string {
  return encode(typeof data === "string" ? encoder.encode(data) : data, true);
}

/**
 * Decodes base64 or base64url leniently, as `Buffer.from(text, "base64")`
 * does: characters outside both alphabets are skipped and the first `=` ends
 * the input. Callers that need canonical input re-encode and compare.
 */
export function decodeBase64(text: string): Uint8Array {
  const output = new Uint8Array(Math.floor((text.length * 3) / 4) + 3);
  let length = 0;
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 61) break;
    const value = code < 128 ? DECODE[code]! : -1;
    if (value < 0) continue;
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[length++] = (buffer >> bits) & 0xff;
    }
  }
  return output.slice(0, length);
}
