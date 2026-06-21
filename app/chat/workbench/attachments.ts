import {
  imageFileToInputPart,
  type ClientInputPart,
} from "../../../packages/vela-chat-client/src";

export interface PendingImageAttachment {
  id: string;
  label: string;
  mimeType: string;
  part: Extract<ClientInputPart, { type: "image" }>;
}

export async function buildPendingImageAttachments(files: File[]) {
  const createdAt = Date.now();
  return Promise.all(
    files.map(async (file, index): Promise<PendingImageAttachment> => ({
      id: `image_${createdAt}_${index}_${file.name || "attachment"}`,
      label: file.name || "image",
      mimeType: file.type || "application/octet-stream",
      part: await imageFileToInputPart(file),
    })),
  );
}
