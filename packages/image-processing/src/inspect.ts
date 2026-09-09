export interface ImageInfo {
  type: "image/png" | "image/jpeg";
  width: number;
  height: number;
  animated: boolean;
}
/** Header-only preflight: never allocate a pixel buffer to discover its dimensions. */
export function inspectImage(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 33 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
  ) {
    let animated = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      if (offset + 12 + length > bytes.length) return null;
      const kind = String.fromCharCode(
        ...bytes.subarray(offset + 4, offset + 8),
      );
      if (kind === "acTL") animated = true;
      offset += 12 + length;
    }
    return {
      type: "image/png",
      width: view.getUint32(16),
      height: view.getUint32(20),
      animated,
    };
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    for (let p = 2; p + 4 <= bytes.length;) {
      if (bytes[p++] !== 255) return null;
      while (bytes[p] === 255) p++;
      const marker = bytes[p++];
      if (marker === 218 || marker === 217 || p + 2 > bytes.length) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = view.getUint16(p);
      if (length < 2 || p + length > bytes.length) return null;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        length >= 8
      ) {
        return {
          type: "image/jpeg",
          width: view.getUint16(p + 5),
          height: view.getUint16(p + 3),
          animated: false,
        };
      }
      p += length;
    }
  }
  return null;
}
