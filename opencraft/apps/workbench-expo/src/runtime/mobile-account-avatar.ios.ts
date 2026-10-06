import { File, UploadType } from "expo-file-system";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import {
  ACCOUNT_AVATAR_UPLOAD_MAX_BYTES,
  accountOperations,
  parseAccountProfile,
} from "@opencraft/mobile-account-sdk";
import { LIGHTVELA_REGIONS, type LightVelaRegion } from "@opencraft/plugin-lightvela-hermes/account-contract";

import { mobileAccount } from "./mobile-account-instance";
import { mobileDeveloperLog } from "./mobile-developer-log.ios";

export class AvatarUploadError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Keep the large original photo on-device; upload only a bounded JPEG. */
async function prepareAvatar(asset: ImagePicker.ImagePickerAsset): Promise<string> {
  const largestDimension = Math.max(1, asset.width, asset.height);
  for (const [index, [limit, quality]] of ([[1024, 0.8], [768, 0.72], [512, 0.64], [384, 0.56]] as const).entries()) {
    const scale = Math.min(1, limit / largestDimension);
    const image = await manipulateAsync(asset.uri, [{ resize: {
      width: Math.max(1, Math.round(asset.width * scale)),
      height: Math.max(1, Math.round(asset.height * scale)),
    } }], { compress: quality, format: SaveFormat.JPEG });
    const file = new File(image.uri);
    if (file.exists && file.size > 0 && file.size <= ACCOUNT_AVATAR_UPLOAD_MAX_BYTES) {
      mobileDeveloperLog.log("avatar.prepared", { bytes: file.size, attempt: index + 1 });
      return image.uri;
    }
  }
  throw new AvatarUploadError("avatar_too_large");
}

/** Returns false when the user closes the picker without choosing an image. */
export async function pickAndUploadAvatar(region: LightVelaRegion): Promise<boolean> {
  mobileDeveloperLog.log("avatar.picker.opened");
  const selection = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
    selectionLimit: 1,
  });
  if (selection.canceled) {
    mobileDeveloperLog.log("avatar.picker.cancelled");
    return false;
  }
  mobileDeveloperLog.log("avatar.picker.selected");
  const asset = selection.assets[0];
  if (!asset?.uri || !asset.width || !asset.height) throw new AvatarUploadError("avatar_invalid");
  let uri: string;
  try { uri = await prepareAvatar(asset); }
  catch (cause) {
    mobileDeveloperLog.log("avatar.prepare.failed");
    throw cause;
  }
  const token = await mobileAccount.webSessionToken();
  if (!token) {
    mobileDeveloperLog.log("avatar.auth.missing");
    throw new AvatarUploadError("unauthorized");
  }

  const operation = accountOperations.uploadAvatar();
  const file = new File(uri);
  mobileDeveloperLog.log("avatar.upload.started", { bytes: file.size });
  let response: Awaited<ReturnType<File["upload"]>>;
  try {
    response = await file.upload(`${LIGHTVELA_REGIONS[region].apiBase}${operation.path}`, {
      httpMethod: operation.method,
      uploadType: UploadType.MULTIPART,
      fieldName: operation.field,
      mimeType: "image/jpeg",
      headers: { Authorization: `Bearer ${token}` },
      sessionType: "foreground",
    });
  } catch {
    mobileDeveloperLog.log("avatar.upload.failed");
    throw new AvatarUploadError("upload_failed");
  }
  mobileDeveloperLog.log("avatar.upload.response", { status: response.status });
  let body: { user?: unknown; code?: unknown; error?: unknown };
  try { body = JSON.parse(response.body) as typeof body; }
  catch {
    mobileDeveloperLog.log("avatar.response.invalid", { status: response.status });
    throw new AvatarUploadError("upload_failed");
  }
  if (response.status < 200 || response.status >= 300) {
    const code = typeof body?.code === "string" ? body.code : body?.error;
    throw new AvatarUploadError(typeof code === "string" ? code : response.status === 401 ? "unauthorized" : "upload_failed");
  }
  try { parseAccountProfile(body.user); }
  catch {
    mobileDeveloperLog.log("avatar.response.invalid", { status: response.status });
    throw new AvatarUploadError("upload_failed");
  }
  mobileDeveloperLog.log("avatar.upload.succeeded", { status: response.status });
  return true;
}
