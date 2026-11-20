import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { isAbsolute } from "node:path";
import { ArtifactCatalog, inspectArtifactFile, type Artifact } from "@opencraft/local-agent-host/artifacts";
import type { AppServerTurn, HistoryImageResource } from "@opencraft/appserver-protocol";

const MAX_BYTES = 32 * 1024 * 1024;
/** Deliberately conservative: unsupported/unknown images keep their original wire body. */
export function inlineHistoryPng(result: unknown): { encoded: string; byteSize: number; width: number; height: number } | null {
  if (typeof result !== "string") return null;
  const encoded = result.startsWith("data:image/png;base64,") ? result.slice(22) : result;
  if (encoded.length < 44 || encoded.length > Math.ceil(MAX_BYTES / 3) * 4 || encoded.length % 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  // The alphabet guarantees all complete groups; canonical padding bits belong only to the final group.
  const last = encoded.slice(-4);
  if (Buffer.from(last, "base64").toString("base64") !== last) return null;
  const byteSize = encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  const header = Buffer.from(encoded.slice(0, 44), "base64");
  if (byteSize > MAX_BYTES || header.length < 33
    || !header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    || header.readUInt32BE(8) !== 13 || header.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
  if (!width || !height || width > 32768 || height > 32768 || width * height > 64 * 1024 * 1024) return null;
  return { encoded, byteSize, width, height };
}

/** Decode bounded complete base64 groups instead of retaining a second full-size image Buffer. */
function* imageChunks(encoded: string, signal?: AbortSignal) {
  for (let offset = 0; offset < encoded.length; offset += 64 * 1024) {
    signal?.throwIfAborted();
    yield Buffer.from(encoded.slice(offset, offset + 64 * 1024), "base64");
  }
}

/** Uses the existing artifact owner and authenticated file transport, not a new file-serving route.
 * Only inline bytes are admitted: untrusted savedPath/URL never trigger a filesystem/network read.
 * Preparation is serial and bounded per image; no retained base64 or process-global image cache. */
export async function prepareHistoryImages(catalog: ArtifactCatalog, threadId: string, turns: readonly AppServerTurn[],
  deliver: (artifact: Artifact, owner: string, signal?: AbortSignal) => Promise<Artifact>, signal?: AbortSignal,
): Promise<Record<string, HistoryImageResource>> {
  const resources: Record<string, HistoryImageResource> = Object.create(null);
  const owner = JSON.stringify(["thread", threadId]);
  for (const turn of turns) for (const item of turn.items ?? []) {
    signal?.throwIfAborted();
    if (item.type !== "imageGeneration" || !["completed", "complete", "success"].includes(String(item.status))) continue;
    if (typeof item.result !== "string" || item.result.length <= 1024) continue;
    const image = inlineHistoryPng(item.result);
    if (!image) continue;
    try {
      const hash = createHash("sha256");
      for (const chunk of imageChunks(image.encoded, signal)) hash.update(chunk);
      const sha256 = hash.digest("hex");
      // Immutable content versions prevent a correction of an Item from changing an old reference.
      const identity = { scope: "history-image-v1", key: JSON.stringify([threadId, turn.id, item.id, sha256]) };
      let artifact = catalog.get(catalog.id(identity));
      if (artifact) {
        const checked = await inspectArtifactFile(artifact.path, signal);
        if (checked.sha256 !== sha256 || checked.size !== image.byteSize) continue;
        catalog.retain(artifact.id, owner, JSON.stringify(["history-image", turn.id, item.id, sha256]));
      } else artifact = await catalog.ingest(identity, { name: "generated.png", mimeType: "image/png", origin: "generation" },
        Readable.from(imageChunks(image.encoded, signal)), { maxBytes: MAX_BYTES, size: image.byteSize, sha256, signal,
          reference: { owner, slot: JSON.stringify(["history-image", turn.id, item.id, sha256]) } });
      const delivered = await deliver(artifact, owner, signal);
      signal?.throwIfAborted();
      if (delivered.sha256 !== sha256 || delivered.size !== image.byteSize || delivered.mimeType !== "image/png"
        || !isAbsolute(delivered.path) || delivered.path.length > 8192 || /[\0\r\n]/u.test(delivered.path)) continue;
      resources[JSON.stringify([turn.id, item.id])] = { version: 1, path: delivered.path, sha256,
        byteSize: delivered.size, mimeType: "image/png", width: image.width, height: image.height };
    } catch {
      signal?.throwIfAborted();
      // Derived acceleration is optional. Keep authoritative bytes on transfer/storage failure.
    }
  }
  return resources;
}
