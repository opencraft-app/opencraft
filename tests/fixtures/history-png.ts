import { deflateSync } from "node:zlib";

/** Small deterministic valid PNG, with an uncompressed stream large enough to exercise blob history. */
export function historyPng(width = 48, height = 32): Buffer {
  function chunk(type: string, data: Buffer) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const prefix = Buffer.alloc(4), suffix = Buffer.alloc(4);
    prefix.writeUInt32BE(data.length); suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([prefix, body, suffix]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    pixels[offset] = 80 + x % 100; pixels[offset + 1] = 150 + y % 100; pixels[offset + 2] = 190;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels, { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
}
