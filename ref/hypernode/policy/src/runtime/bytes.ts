export type ByteInput = Uint8Array | readonly number[];

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(bytes: ByteInput): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = index + 1 < bytes.length ? (bytes[index + 1] ?? 0) : 0;
    const third = index + 2 < bytes.length ? (bytes[index + 2] ?? 0) : 0;
    const value = (first << 16) | (second << 8) | third;
    result += BASE64_ALPHABET[(value >>> 18) & 63] ?? "";
    result += BASE64_ALPHABET[(value >>> 12) & 63] ?? "";
    result += index + 1 < bytes.length ? (BASE64_ALPHABET[(value >>> 6) & 63] ?? "") : "=";
    result += index + 2 < bytes.length ? (BASE64_ALPHABET[value & 63] ?? "") : "=";
  }
  return result;
}

export function base64Decode(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < clean.length; index += 4) {
    const firstCharacter = clean[index];
    const secondCharacter = clean[index + 1];
    const thirdCharacter = clean[index + 2];
    const fourthCharacter = clean[index + 3];
    if (firstCharacter == null || secondCharacter == null || thirdCharacter == null || fourthCharacter == null) {
      throw new Error("invalid base64 data");
    }
    const a = BASE64_ALPHABET.indexOf(firstCharacter);
    const b = BASE64_ALPHABET.indexOf(secondCharacter);
    const c = thirdCharacter === "=" ? 0 : BASE64_ALPHABET.indexOf(thirdCharacter);
    const d = fourthCharacter === "=" ? 0 : BASE64_ALPHABET.indexOf(fourthCharacter);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error("invalid base64 data");
    const value = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((value >>> 16) & 0xff);
    if (thirdCharacter !== "=") bytes.push((value >>> 8) & 0xff);
    if (fourthCharacter !== "=") bytes.push(value & 0xff);
  }
  return Uint8Array.from(bytes);
}

export function asciiBytes(text: string): Uint8Array {
  const output = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    output[index] = text.charCodeAt(index) & 0xff;
  }
  return output;
}

export function asciiText(bytes: Uint8Array): string {
  let result = "";
  for (const value of bytes) result += String.fromCharCode(value);
  return result;
}

export function concatBytes(...parts: readonly ByteInput[]): Uint8Array {
  const normalized = parts.filter((part) => part.length > 0).map((part) =>
    part instanceof Uint8Array ? part : Uint8Array.from(part));
  const output = new Uint8Array(normalized.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of normalized) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of text) {
    const value = character.codePointAt(0);
    if (value == null) continue;
    if (value <= 0x7f) bytes.push(value);
    else if (value <= 0x7ff) bytes.push(0xc0 | (value >>> 6), 0x80 | (value & 0x3f));
    else if (value <= 0xffff) {
      bytes.push(0xe0 | (value >>> 12), 0x80 | ((value >>> 6) & 0x3f), 0x80 | (value & 0x3f));
    } else {
      bytes.push(
        0xf0 | (value >>> 18),
        0x80 | ((value >>> 12) & 0x3f),
        0x80 | ((value >>> 6) & 0x3f),
        0x80 | (value & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

export function utf8Decode(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++] ?? 0;
    let value: number;
    if (first < 0x80) value = first;
    else if ((first & 0xe0) === 0xc0 && index < bytes.length) {
      value = ((first & 0x1f) << 6) | ((bytes[index++] ?? 0) & 0x3f);
    } else if ((first & 0xf0) === 0xe0 && index + 1 < bytes.length) {
      value = ((first & 0x0f) << 12) |
        (((bytes[index++] ?? 0) & 0x3f) << 6) |
        ((bytes[index++] ?? 0) & 0x3f);
    } else if ((first & 0xf8) === 0xf0 && index + 2 < bytes.length) {
      value = ((first & 7) << 18) |
        (((bytes[index++] ?? 0) & 0x3f) << 12) |
        (((bytes[index++] ?? 0) & 0x3f) << 6) |
        ((bytes[index++] ?? 0) & 0x3f);
    } else value = 0xfffd;
    result += String.fromCodePoint(value);
  }
  return result;
}
