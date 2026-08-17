import type { AttachmentSource } from "@vela/client-core";

interface PickedAttachmentAsset {
  file?: unknown;
  height?: number;
  mimeType?: string | null;
  name: string;
  size?: number;
  uri: string;
  width?: number;
}

export function attachmentSourceFromAsset(
  asset: PickedAttachmentAsset,
): AttachmentSource {
  if (asset.file !== undefined) {
    return {
      file: asset.file,
      ...(asset.height !== undefined ? {height: asset.height} : {}),
      kind: "platform-file",
      ...(asset.mimeType ? {mimeType: asset.mimeType} : {}),
      name: asset.name,
      previewUri: asset.uri,
      ...(asset.size !== undefined ? {size: asset.size} : {}),
      ...(asset.width !== undefined ? {width: asset.width} : {}),
    };
  }
  return {
    ...(asset.height !== undefined ? {height: asset.height} : {}),
    kind: "uri",
    ...(asset.mimeType ? {mimeType: asset.mimeType} : {}),
    name: asset.name,
    ...(asset.size !== undefined ? {size: asset.size} : {}),
    uri: asset.uri,
    ...(asset.width !== undefined ? {width: asset.width} : {}),
  };
}

export async function pickImageAttachment(): Promise<AttachmentSource | null> {
  const ImagePicker = await import("expo-image-picker");
  const result = await ImagePicker.launchImageLibraryAsync({
    allowsMultipleSelection: false,
    mediaTypes: ["images"],
    quality: 1,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return attachmentSourceFromAsset({
    ...(asset.file !== undefined ? {file: asset.file} : {}),
    ...(asset.mimeType ? {mimeType: asset.mimeType} : {}),
    height: asset.height,
    name: asset.fileName ?? fileNameFromUri(asset.uri, "图片"),
    ...(asset.fileSize !== undefined ? {size: asset.fileSize} : {}),
    uri: asset.uri,
    width: asset.width,
  });
}

export async function pickFileAttachment(): Promise<AttachmentSource | null> {
  const DocumentPicker = await import("expo-document-picker");
  const result = await DocumentPicker.getDocumentAsync({
    base64: false,
    copyToCacheDirectory: false,
    multiple: false,
    type: "*/*",
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return attachmentSourceFromAsset({
    ...(asset.file !== undefined ? {file: asset.file} : {}),
    ...(asset.mimeType ? {mimeType: asset.mimeType} : {}),
    name: asset.name || fileNameFromUri(asset.uri, "文件"),
    ...(asset.size !== undefined ? {size: asset.size} : {}),
    uri: asset.uri,
  });
}

function fileNameFromUri(uri: string, fallback: string): string {
  const withoutQuery = uri.split("?")[0] ?? uri;
  const segment = withoutQuery.split("/").pop();
  if (!segment) return fallback;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
