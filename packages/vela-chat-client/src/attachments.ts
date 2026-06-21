import type { ClientInputPart } from "./wire";

export async function imageFileToInputPart(file: Pick<File, "arrayBuffer" | "type">) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    type: "image",
    data: bytesToBase64(bytes),
    mime_type: file.type || "application/octet-stream",
  } satisfies ClientInputPart;
}

function bytesToBase64(bytes: Uint8Array) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const packed = (first << 16) | (second << 8) | third;
    output += alphabet[(packed >> 18) & 63];
    output += alphabet[(packed >> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(packed >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[packed & 63] : "=";
  }
  return output;
}
