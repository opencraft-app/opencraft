export interface Utf8DecodeOptions {
  readonly fatal?: boolean;
}

const REPLACEMENT_CODE_POINT = 0xfffd;

/**
 * The sole text codec for AppServer protocol boundaries.
 *
 * It deliberately does not delegate to host TextEncoder/TextDecoder APIs:
 * React Native, browsers and Node must interpret the same bytes identically.
 */
export function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        index += 1;
      } else {
        codePoint = REPLACEMENT_CODE_POINT;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = REPLACEMENT_CODE_POINT;
    }

    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

export function decodeUtf8(bytes: Uint8Array, options: Utf8DecodeOptions = {}): string {
  const chunks: string[] = [];
  const codeUnits: number[] = [];
  const flush = () => {
    if (codeUnits.length === 0) return;
    chunks.push(String.fromCharCode(...codeUnits));
    codeUnits.length = 0;
  };
  const emit = (codePoint: number) => {
    if (codePoint <= 0xffff) codeUnits.push(codePoint);
    else {
      const scalar = codePoint - 0x10000;
      codeUnits.push(0xd800 | (scalar >> 10), 0xdc00 | (scalar & 0x3ff));
    }
    if (codeUnits.length >= 0x2000) flush();
  };
  const invalid = (offset: number) => {
    if (options.fatal === true) throw new TypeError(`Invalid UTF-8 sequence at byte ${offset}`);
    emit(REPLACEMENT_CODE_POINT);
  };

  for (let index = 0; index < bytes.length;) {
    const first = bytes[index]!;
    if (first <= 0x7f) {
      emit(first);
      index += 1;
      continue;
    }

    let length = 0;
    let codePoint = 0;
    let minimum = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      length = 2;
      codePoint = first & 0x1f;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      length = 3;
      codePoint = first & 0x0f;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      length = 4;
      codePoint = first & 0x07;
      minimum = 0x10000;
    } else {
      invalid(index);
      index += 1;
      continue;
    }

    if (index + length > bytes.length) {
      invalid(index);
      break;
    }
    let valid = true;
    for (let offset = 1; offset < length; offset += 1) {
      const continuation = bytes[index + offset]!;
      if ((continuation & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (!valid || codePoint < minimum || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      invalid(index);
      index += 1;
      continue;
    }
    emit(codePoint);
    index += length;
  }
  flush();
  return chunks.join("");
}

function sequenceLength(first: number): number {
  if (first <= 0x7f) return 1;
  if (first >= 0xc2 && first <= 0xdf) return 2;
  if (first >= 0xe0 && first <= 0xef) return 3;
  if (first >= 0xf0 && first <= 0xf4) return 4;
  return 1;
}

/** Stateful decoder for PTY/SSE chunks which may split a UTF-8 scalar. */
export class Utf8StreamDecoder {
  private pending: Uint8Array = new Uint8Array();

  decode(input: Uint8Array = new Uint8Array(), options: { readonly stream?: boolean } = {}): string {
    const bytes = new Uint8Array(this.pending.byteLength + input.byteLength);
    bytes.set(this.pending);
    bytes.set(input, this.pending.byteLength);
    this.pending = new Uint8Array();

    let completeLength = bytes.byteLength;
    if (options.stream === true && bytes.byteLength > 0) {
      let start = bytes.byteLength - 1;
      while (start > 0 && bytes.byteLength - start < 4 && (bytes[start]! & 0xc0) === 0x80) start -= 1;
      const expected = sequenceLength(bytes[start]!);
      if (expected > bytes.byteLength - start) completeLength = start;
      if (completeLength < bytes.byteLength) this.pending = bytes.slice(completeLength);
    }
    return decodeUtf8(bytes.subarray(0, completeLength));
  }
}
