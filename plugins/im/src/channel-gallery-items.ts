import type { ChannelMessage, ForwardedRecord } from "@opencraft/appserver-protocol";
import type { ChannelPictureTarget } from "./channel-pictures";
import { channelTargetKey } from "./channel-resources";
export interface ChannelGalleryItem {
  readonly id: string;
  readonly target: ChannelPictureTarget;
  readonly label: string;
}
export const isChannelImage = (mime: string) =>
  ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(mime);
export function channelGalleryItems(group: string, messages: readonly ChannelMessage[]): ChannelGalleryItem[] {
  return messages.flatMap((m) => {
    const target: ChannelPictureTarget | null =
      m.image?.state === "ready"
        ? { group, sequence: m.sequence, kind: "image" }
        : m.attachment && isChannelImage(m.attachment.type)
          ? { group, sequence: m.sequence, kind: "attachment", mime: m.attachment.type }
          : null;
    return target ? [{ id: channelTargetKey(target), target, label: m.attachment?.name ?? "" }] : [];
  });
}
export function recordGalleryItems(group: string, sequence: number, record: ForwardedRecord): ChannelGalleryItem[] {
  const out: ChannelGalleryItem[] = [],
    seen = new Set<string>();
  const visit = (r: ForwardedRecord) => {
    for (const e of r.entries)
      for (const p of e.parts) {
        if (p.kind === "record" && p.record) visit(p.record);
        if (p.kind !== "image" || !p.resource) continue;
        const target: ChannelPictureTarget = { group, sequence, kind: "record", path: p.resource },
          id = channelTargetKey(target);
        if (!seen.has(id)) {
          seen.add(id);
          out.push({ id, target, label: p.name ?? "" });
        }
      }
  };
  visit(record);
  return out;
}
