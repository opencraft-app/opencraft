import { FilePreviewError } from "@opencraft/file-preview-web";
import { unzipSync } from "fflate";

/** Inspect the directory before inflating OOXML. ZIP64/encrypted archives are
 * outside this preview slice; compressed input size alone is not a safe limit. */
export function validateOfficeArchive(buffer: ArrayBuffer, kind: string): void {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65_557) && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || end < bytes.length - 65_557) throw new Error("Invalid Office archive");
  const entries = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (entries < 1 || entries > 4000 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) throw new Error("Unsupported archive size");
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error("Invalid archive directory");
    const size = view.getUint32(offset + 24, true);
    total += size;
    if (view.getUint16(offset + 8, true) & 1) throw new FilePreviewError("encrypted");
    if (size > 32 * 1024 * 1024 || total > 64 * 1024 * 1024) throw new Error("Office archive exceeds preview limits");
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  const metadata = unzipSync(bytes, { filter: file => file.name === "[Content_Types].xml" || file.name.endsWith(".rels") });
  const contentTypes = metadata["[Content_Types].xml"];
  if (!contentTypes) throw new Error("Not an OOXML document");
  const text = new TextDecoder();
  const expected = kind === "docx" ? "wordprocessingml" : kind === "pptx" ? "presentationml" : "spreadsheetml";
  if (!text.decode(contentTypes).includes(expected)) throw new Error("Office format does not match the file");
  for (const [name, data] of Object.entries(metadata)) {
    if (!name.endsWith(".rels")) continue;
    const xml = new DOMParser().parseFromString(text.decode(data), "application/xml");
    if (xml.querySelector("parsererror")) throw new Error("Invalid Office relationships");
    for (const relation of Array.from(xml.getElementsByTagNameNS("*", "Relationship"))) {
      if (relation.getAttribute("TargetMode")?.toLowerCase() === "external" && !relation.getAttribute("Type")?.endsWith("/hyperlink")) {
        throw new Error("Externally linked document resources are unsupported");
      }
    }
  }
}
