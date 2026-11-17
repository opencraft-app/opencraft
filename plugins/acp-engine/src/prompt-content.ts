import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AppServerRpcError } from "@opencraft/appserver-client";

type PromptBlock = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };
const maxImageBytes = 20 * 1024 * 1024;
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const invalid = (message: string): never => { throw new AppServerRpcError({ code: -32602, message }); };

async function localImage(path: unknown): Promise<Extract<PromptBlock, { type: "image" }>> {
  if (typeof path !== "string" || !isAbsolute(path)) return invalid("Invalid local image path");
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > maxImageBytes) return invalid("Invalid image size");
    // Read at most the observed size plus one byte, even if the file grows.
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== stat.size) return invalid("Image changed while being read");
    const data = bytes.subarray(0, length);
    const mimeType = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
      : data[0] === 255 && data[1] === 216 && data[2] === 255 ? "image/jpeg"
      : ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii")) ? "image/gif"
      : data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : null;
    if (!mimeType) return invalid("Unsupported image format");
    return { type: "image", mimeType, data: data.toString("base64") };
  } finally { await file.close(); }
}

/** AppServer image references become ACP v1 inline image blocks, never text substitutes. */
export async function acpPromptContent(input: unknown, imagesAllowed: boolean): Promise<PromptBlock[]> {
  if (!Array.isArray(input) || !input.length) return invalid("ACP input is empty");
  const blocks: PromptBlock[] = [];
  let images = 0, imageBytes = 0;
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid("Invalid ACP input");
    if (item.type === "text" && typeof item.text === "string") { blocks.push({ type: "text", text: item.text }); continue; }
    if (item.type !== "image" && item.type !== "localImage") return invalid("Unsupported ACP input type");
    if (!imagesAllowed) return invalid("This agent does not support image input");
    if (++images > 8) return invalid("At most 8 images are accepted");
    let block: Extract<PromptBlock, { type: "image" }>;
    if (item.type === "localImage") block = await localImage(item.path);
    else {
      // The Composer provides inline image data. Do not fetch arbitrary URLs or
      // reinterpret opaque file IDs as paths on the Agent's machine.
      if (typeof item.url !== "string" || item.url.length > Math.ceil(maxImageBytes / 3) * 4 + 64) return invalid("Invalid inline image");
      const comma = item.url.indexOf(","), header = item.url.slice(0, comma), data = item.url.slice(comma + 1);
      const mimeType = header.startsWith("data:") && header.endsWith(";base64") ? header.slice(5, -7) : "";
      if (!imageTypes.has(mimeType) || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) return invalid("Invalid inline image");
      block = { type: "image", mimeType, data };
    }
    imageBytes += Buffer.byteLength(block.data, "base64");
    if (imageBytes > maxImageBytes) return invalid("Image input is too large");
    blocks.push(block);
  }
  return blocks;
}
