import { CHANNEL_IMAGE_LIMIT, channelImageType } from "@opencraft/appserver-protocol";

/** Browser MIME/filename hints are not the image format authority. Read only its header. */
export async function normalizeChannelAttachment(file: File, signal?: AbortSignal): Promise<File> {
  signal?.throwIfAborted();
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  signal?.throwIfAborted();
  const type = channelImageType(header);
  if (type) return type === file.type ? file : new File([file], file.name, { type, lastModified: file.lastModified });
  if (/^image\/(?:png|x-png|jpe?g|pjpeg)$/iu.test(file.type) || /\.(?:png|jpe?g)$/iu.test(file.name)) {
    throw Error("channel_image_invalid");
  }
  return file;
}

/** Keep native/direct file support; refine only an authoritative external-file refusal. */
export function channelAttachmentFailure(error: unknown, file: File): unknown {
  if (!(error instanceof Error) || error.message !== "channel_files_unavailable") return error;
  if ((file.type === "image/png" || file.type === "image/jpeg") && file.size > CHANNEL_IMAGE_LIMIT) {
    return Error("channel_image_too_large");
  }
  if (file.type.startsWith("image/") && file.type !== "image/png" && file.type !== "image/jpeg") {
    return Error("channel_image_format_unavailable");
  }
  return error;
}
