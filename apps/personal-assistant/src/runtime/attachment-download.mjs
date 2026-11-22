import { join } from "node:path";
import { LocalAttachmentStore } from "../adapters/filesystem/attachment-store.mjs";

/**
 * Reads one platform file in 64 KiB chunks and imports it into the runner's attachment store.
 * `readChunk(offset)` returns {name,size,next,base64}; every chunk must agree on size and order.
 * Shared by the owner's private line and crew intake, so both apply the same 8 MiB bound.
 */
export async function downloadAttachment(profilePath, readChunk) {
  let offset = 0,
    name,
    expectedSize,
    total = 0;
  const chunks = [];
  do {
    const file = await readChunk(offset);
    if (
      !file ||
      file.size > 8 * 1024 * 1024 ||
      file.size < 0 ||
      (expectedSize !== undefined && expectedSize !== file.size)
    )
      throw Error("Attachment unavailable");
    name = file.name;
    expectedSize = file.size;
    const chunk = Buffer.from(file.base64, "base64");
    total += chunk.length;
    if (total > expectedSize || (file.next !== null && (file.next !== offset + 65536 || chunk.length !== 65536)))
      throw Error("Invalid attachment chunk");
    chunks.push(chunk);
    offset = file.next;
  } while (offset !== null);
  if (total !== expectedSize) throw Error("Incomplete attachment");
  return new LocalAttachmentStore(join(profilePath, "attachments")).importBytes(name, Buffer.concat(chunks, total))
    .attachmentId;
}
